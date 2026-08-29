import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PR_COMMITS_CAP, type PrCommit } from '@shared/source-discovery';
import { run } from './exec';
import type { PreparedSource, ReviewTarget, Source } from './source';

/** 解析 PR 引用:完整 URL / owner/repo#123 / 纯号(需 repoPath 推断仓库)。 */
export function parsePrRef(ref: string): { nwo: string; num: string } {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { nwo: url[1], num: url[2] };
  const short = ref.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/);
  if (short) return { nwo: short[1], num: short[2] };
  const numOnly = ref.match(/^#?(\d+)$/);
  if (numOnly) return { nwo: '', num: numOnly[1] };
  throw new Error(`无法解析 PR 引用: ${ref}`);
}

/**
 * 解析 PR 引用并补齐仓库:ref 里没带 owner/repo 时,从本地仓库目录的 remote 推断。
 * `gh` 未登录 / 目录不是仓库时抛错。
 */
export async function resolvePrRef(
  ref: string,
  repoPath?: string | null,
): Promise<{ nwo: string; num: string }> {
  const parsed = parsePrRef(ref);
  if (parsed.nwo) return parsed;
  if (!repoPath) throw new Error('PR 引用缺 owner/repo,且未提供 repoPath');
  const out = await run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    repoPath,
  );
  return { nwo: out.trim(), num: parsed.num };
}

interface RawCommit {
  sha: string;
  commit: { message: string; committer?: { date?: string }; author?: { name?: string } };
  author?: { login?: string } | null;
  parents: unknown[];
}

const PR_COMMITS_PAGE = 100;

const toPrCommit = (c: RawCommit): PrCommit => ({
  oid: c.sha,
  headline: firstLine(c.commit.message),
  // 账号注销 / 提交邮箱没关联到账号时顶层 author 为 null,回落 git 署名
  author: c.author?.login || c.commit.author?.name || '',
  committedDate: c.commit.committer?.date ?? '',
  isMerge: c.parents.length > 1,
});

const firstLine = (msg: string): string => msg.split('\n')[0];

/**
 * gh api 的 404。gh 把 `gh: Not Found (HTTP 404)` 写到 stderr、JSON 体写到 stdout,
 * 两处都认一下,免得日后 gh 改动其中一侧就漏判成「网络错误」。
 */
function isHttp404(e: unknown): boolean {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  const text = `${err?.stderr ?? ''}\n${err?.stdout ?? ''}\n${err?.message ?? ''}`;
  return /\(HTTP 404\)|"status":\s*"404"/.test(text);
}

/**
 * PR 里的 commit 列表(旧→新,即 GitHub commits 页的顺序)。
 * 放在本模块而非 source-discovery:后者已依赖本模块的 parsePrRef,反向再引一次会成环。
 *
 * **手动翻页而不是 `gh api --paginate`**:数组端点分页时,部分 gh 版本把每页各自的 JSON 数组
 * 背靠背拼在一起输出(`][`),`JSON.parse` 当场就抛 —— 而这只在提交数过百的 PR 上才现形,
 * 属于「本机验不出、用户那儿才炸」的那类。自己按 page 取,拿到的每一份都是独立合法的 JSON。
 */
export async function fetchPrCommits(nwo: string, num: string): Promise<PrCommit[]> {
  const out: PrCommit[] = [];
  for (let page = 1; ; page++) {
    const json = await run('gh', [
      'api',
      `repos/${nwo}/pulls/${num}/commits?per_page=${PR_COMMITS_PAGE}&page=${page}`,
    ]);
    const raw = JSON.parse(json) as RawCommit[];
    out.push(...raw.map(toPrCommit));
    // 不满一页 = 已到末页;上限那一条兜住封顶值日后变大(再翻也只会拿到空页)
    if (raw.length < PR_COMMITS_PAGE || out.length >= PR_COMMITS_CAP) return out;
  }
}

/**
 * GitHub PR source:diff 走 `gh pr diff`,文件走 `gh api .../contents`(按 head sha),
 * 无需本地 clone。可选 repoPath 仅用作 codex cwd;缺省用临时空目录。
 *
 * 指定 base 时改走 compare API(见 {@link getDiff}):stacked PR 下「只审本 PR」与
 * 「连同下面几个 PR 一起审」是两个不同的范围,而 `gh pr diff` 只给得出前者。
 *
 * 指定 head 时则钉死在 PR 里的某一个 commit 上(相对其父提交),此时忽略 base。
 */
export class GitHubPrSource implements Source {
  private nwo = '';
  private num = '';
  private headSha = '';
  private tmp?: string;

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const parsed = parsePrRef(this.target.ref);
    this.num = parsed.num;
    this.nwo = parsed.nwo || (await this.deriveNwo());

    const metaJson = await run('gh', [
      'pr', 'view', this.num, '--repo', this.nwo,
      '--json', 'title,number,headRefOid,url',
    ]);
    const meta = JSON.parse(metaJson) as { title: string; number: number; headRefOid: string };
    this.headSha = meta.headRefOid;

    const cwd = this.target.repoPath || (this.tmp = mkdtempSync(path.join(tmpdir(), 'duetlens-pr-')));
    const pinned = this.target.headRef?.trim();
    if (!pinned) return { title: `#${meta.number} · ${meta.title}`, cwd, headSha: this.headSha };

    // 校验这个 sha 确实属于本 PR。**不属于就抛** —— force-push 后原 commit 被挤出 PR 正是这条路,
    // 而静默回落到整个 PR 会让复审悄悄换成另一份改动面(锚点与 422 预判的基准全跟着漂)。
    const list = await fetchPrCommits(this.nwo, this.num);
    const hit = list.find((c) => c.oid === pinned);
    const headline = hit
      ? hit.headline
      : // 列表拉满上限 = 可能被截断,「不在列表里」这时**不足以**判定它不属于本 PR:
        // 超过 250 个提交的 PR 里,先前钉住的旧提交本来就落在拿不到的那一段,
        // 照严格判法会把一条完全正常的 review 判成 force-push 失效,复审与提交一起断掉。
        // 故降级为问 compare:该 sha 是 PR head 的祖先(ahead)或就是它(identical)即算数。
        list.length >= PR_COMMITS_CAP
        ? await this.headlineIfAncestor(pinned, meta.number)
        : null;
    if (headline == null) {
      throw new Error(
        `commit ${pinned.slice(0, 7)} 不在 #${meta.number} 里(可能已被 force-push 挤掉);请重新选择审核范围`,
      );
    }
    this.headSha = pinned;
    return { title: `#${meta.number} @${pinned.slice(0, 7)} · ${headline}`, cwd, headSha: this.headSha };
  }

  /**
   * 截断兜底:`{sha}...{PR head}` 的 compare 状态为 ahead / identical 即认它属于本 PR。
   * 同一次调用顺带取回该 commit 自己的标题(compare 的 `base_commit` 就是传进去的那一侧),
   * 免得为了一行标题再打一次 gh。`per_page=1` 只为压响应体 —— 这里一条 commit 都不需要读。
   */
  private async headlineIfAncestor(sha: string, prNumber: number): Promise<string | null> {
    try {
      const json = await run('gh', [
        'api',
        `repos/${this.nwo}/compare/${sha}...${this.headSha}?per_page=1`,
      ]);
      const cmp = JSON.parse(json) as { status?: string; base_commit?: { commit?: { message?: string } } };
      if (cmp.status !== 'ahead' && cmp.status !== 'identical') return null;
      return firstLine(cmp.base_commit?.commit?.message ?? '') || `#${prNumber} 中的一个提交`;
    } catch (e) {
      // **只有 404 才算「查无此物」**:那是 sha 根本不在这个仓库里,与「不属于本 PR」同义。
      // 限流 / 断网 / 认证过期一律往上抛 —— 把它们咽成 null,用户看到的会是
      // 「可能已被 force-push 挤掉」,照着这条去翻 PR 历史,而真正的原因(网断了)一个字都没露。
      if (isHttp404(e)) return null;
      throw e;
    }
  }

  /**
   * 缺省用 `gh pr diff`(PR 相对自己 base 的那份)。指定 base 时改问 compare API 并要 diff
   * 媒体类型 —— 它回的是同一套标准 unified 文本,**仍然不需要 clone**,PR source 「不落地也能审」
   * 的性质得以保住。三点比较:base 分支后来前进不会被倒着显示成删除。
   */
  async getDiff(): Promise<string> {
    // 钉住某个 commit 时基线只能是它的父提交,故先于 base 判定(两者互斥,见 ReviewTarget.headRef)。
    // 单 commit 接口回的就是 first-parent unified diff,同样不需要 clone。
    if (this.target.headRef?.trim()) {
      return run('gh', [
        'api', '-H', 'Accept: application/vnd.github.v3.diff',
        `repos/${this.nwo}/commits/${this.headSha}`,
      ]);
    }
    const base = this.target.baseRef?.trim();
    if (!base) return run('gh', ['pr', 'diff', this.num, '--repo', this.nwo]);
    return run('gh', [
      'api', '-H', 'Accept: application/vnd.github.v3.diff',
      `repos/${this.nwo}/compare/${encodeURIComponent(base)}...${this.headSha}`,
    ]);
  }

  async getFile(path: string): Promise<string> {
    try {
      const b64 = await run('gh', [
        'api', `repos/${this.nwo}/contents/${encodeURIComponent(path)}?ref=${this.headSha}`,
        '--jq', '.content',
      ]);
      return Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch {
      throw new Error(`无法读取 ${path}(不在 PR head ${this.headSha.slice(0, 7)})`);
    }
  }

  async dispose(): Promise<void> {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }

  private async deriveNwo(): Promise<string> {
    if (!this.target.repoPath) throw new Error('PR 引用缺 owner/repo,且未提供 repoPath');
    const out = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], this.target.repoPath);
    return out.trim();
  }
}
