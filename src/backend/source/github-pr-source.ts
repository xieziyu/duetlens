import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PR_COMMITS_CAP, type CommitPosition, type PrCommit } from '@shared/source-discovery';
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

const PR_COMMITS_PAGE = 100;

/**
 * 走 GraphQL 而不是 REST 的 `pulls/{num}/commits`:那个接口**最多只给最早的 250 条**,
 * 几百个提交的 PR 上被截掉的恰恰是最新的那些 —— 而人切过来找的正是它们。
 * GraphQL 的 connection 支持 `last` + `before`,能从最新一页倒着翻,总数也一并给出。
 */
const COMMITS_QUERY = `
query($owner:String!,$name:String!,$num:Int!,$page:Int!,$before:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$num){
      commits(last:$page,before:$before){
        totalCount
        pageInfo{ hasPreviousPage startCursor }
        nodes{ commit{ oid messageHeadline committedDate author{ name user{ login } } parents(first:1){ totalCount } } }
      }
    }
  }
}`;

interface GqlCommitNode {
  commit?: {
    oid?: string | null;
    messageHeadline?: string | null;
    committedDate?: string | null;
    author?: { name?: string | null; user?: { login?: string | null } | null } | null;
    parents?: { totalCount?: number | null } | null;
  } | null;
}

interface GqlCommitsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        commits?: {
          totalCount?: number | null;
          pageInfo?: { hasPreviousPage?: boolean | null; startCursor?: string | null } | null;
          nodes?: (GqlCommitNode | null)[] | null;
        } | null;
      } | null;
    } | null;
  };
}

const toPrCommit = (n: GqlCommitNode): PrCommit | null => {
  const c = n.commit;
  if (!c?.oid) return null;
  return {
    oid: c.oid,
    headline: c.messageHeadline ?? '',
    // 账号注销 / 提交邮箱没关联到账号时 user 为 null,回落 git 署名
    author: c.author?.user?.login || c.author?.name || '',
    committedDate: c.committedDate ?? '',
    isMerge: (c.parents?.totalCount ?? 0) > 1,
  };
};

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

export interface PrCommitList {
  /** 旧→新,与 GitHub PR 的 commits 页同序;超过封顶值时只含**最新**的那一段 */
  commits: PrCommit[];
  /** PR 的提交总数;大于 commits.length 即被截断 */
  total: number;
}

/**
 * PR 里的 commit 列表。从最新一页往回翻,凑够 {@link PR_COMMITS_CAP} 即停 ——
 * 几百个提交的 PR 靠翻列表找目标本就不现实,截掉的是最早的那段,与人找提交的方向一致。
 * 放在本模块而非 source-discovery:后者已依赖本模块的 parsePrRef,反向再引一次会成环。
 */
export async function fetchPrCommits(nwo: string, num: string): Promise<PrCommitList> {
  const [owner, name] = nwo.split('/');
  const pages: PrCommit[][] = [];
  let count = 0;
  let total = 0;
  let before: string | null = null;
  for (;;) {
    const args = [
      'api', 'graphql',
      '-f', `query=${COMMITS_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `num=${num}`,
      // 最后一页只取补足封顶值的那几条,别多拉一页再切
      '-F', `page=${Math.min(PR_COMMITS_PAGE, PR_COMMITS_CAP - count)}`,
    ];
    if (before) args.push('-f', `before=${before}`);
    const parsed = JSON.parse(await run('gh', args)) as GqlCommitsResponse;
    const conn = parsed.data?.repository?.pullRequest?.commits;
    if (!conn) throw new Error(`拉不到 ${nwo}#${num} 的提交列表`);
    total = conn.totalCount ?? 0;
    const page = (conn.nodes ?? []).flatMap((n) => (n ? (toPrCommit(n) ?? []) : []));
    pages.unshift(page);
    count += page.length;
    const cursor = conn.pageInfo?.startCursor ?? null;
    if (!conn.pageInfo?.hasPreviousPage || !cursor || count >= PR_COMMITS_CAP || page.length === 0) break;
    before = cursor;
  }
  return { commits: pages.flat(), total };
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
    const { commits: list, total } = await fetchPrCommits(this.nwo, this.num);
    const capped = total > list.length;
    const at = list.findIndex((c) => c.oid === pinned);
    const headline =
      at >= 0
        ? list[at].headline
        : // 列表被截断时「不在列表里」**不足以**判定它不属于本 PR:先前钉住的旧提交
          // 本来就落在截掉的那一段,照严格判法会把一条完全正常的 review 判成 force-push 失效,
          // 复审与提交一起断掉。故降级为问 compare:该 sha 是 PR head 的祖先(ahead)或就是它(identical)即算数。
          capped
          ? await this.headlineIfAncestor(pinned, meta.number)
          : null;
    if (headline == null) {
      throw new Error(
        `commit ${pinned.slice(0, 7)} 不在 #${meta.number} 里(可能已被 force-push 挤掉);请重新选择审核范围`,
      );
    }
    this.headSha = pinned;
    const position: CommitPosition = {
      sha: pinned,
      headline,
      // 列表只含最新一段时,序号要把截掉的前面那些算上
      index: at >= 0 ? total - list.length + at + 1 : null,
      total,
      prevHeadline: at > 0 ? list[at - 1].headline : null,
      nextHeadline: at >= 0 && at < list.length - 1 ? list[at + 1].headline : null,
    };
    return {
      title: `#${meta.number} @${pinned.slice(0, 7)} · ${headline}`,
      cwd,
      headSha: this.headSha,
      position,
    };
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
