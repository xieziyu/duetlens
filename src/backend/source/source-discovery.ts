/**
 * 入口发起页的来源发现:轻量只读查询(gh 登录检测、PR 预览/列举、
 * 本地仓库模式探测与分支列举、目录 remote 归属)。
 * 不进入 Source 的 prepare/diff 生命周期,仅为发起前的选择器供数据。
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DiffStat,
  GitButlerStatus,
  PrAncestor,
  LocalBranchList,
  LocalBranchSummary,
  PrPreview,
  PrSummary,
  RepoInspection,
  RepoRemoteInfo,
  VbranchSummary,
} from '@shared/source-discovery';
import { parseUnifiedDiff } from '@shared/diff';
import { BASE_ORDER, detectBaseRef, refExists } from './base-ref';
import { butJson } from './but-cli';
import { createSource } from './create-source';
import { run } from './exec';
import { gitButlerDiff } from './gitbutler-source';
import { parsePrRef } from './github-pr-source';
import type { ReviewTarget } from './source';

/** `gh auth status` 退出码非 0 即未登录;命令缺失(未装 gh)同样视为不可用。 */
export async function checkGhAuth(): Promise<boolean> {
  try {
    await run('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

/** 解析单个 PR 预览;ref 缺 owner/repo 时用 repoPath 推断。失败向上抛(前端展示解析失败态)。 */
export async function previewPr(ref: string, repoPath?: string): Promise<PrPreview> {
  const parsed = parsePrRef(ref);
  const nwo = parsed.nwo || (await deriveNwo(repoPath));
  const json = await run('gh', [
    'pr', 'view', parsed.num, '--repo', nwo,
    '--json', 'number,title,author,additions,deletions,changedFiles,url,baseRefName',
  ]);
  const m = JSON.parse(json) as {
    number: number;
    title: string;
    author: { login: string };
    additions: number;
    deletions: number;
    changedFiles: number;
    url: string;
    baseRefName: string;
  };
  return {
    nwo,
    number: m.number,
    title: m.title,
    author: m.author?.login ?? '',
    additions: m.additions,
    deletions: m.deletions,
    changedFiles: m.changedFiles,
    url: m.url,
    baseRef: m.baseRefName,
  };
}

/** 顺着 base 往下最多摸几层;stacked PR 现实里两三层,给足余量同时兜住成环。 */
const PR_CHAIN_DEPTH = 8;

/**
 * 被审 PR 的祖先链,自近及远:`[0]` 就是这个 PR 自己的 base(即默认基线),
 * 之后每一层是「以上一层 base 为 head 的那个 PR」的 base,直到摸不到 PR 为止。
 *
 * 这条链就是 stacked PR 的形状本身 —— 用户想「pr1 对 pr3」时,要选的正是链上某一环,
 * 而不必自己记住 pr1 的分支叫什么。
 *
 * 每层一次 `gh` 调用,故封了深度;`seen` 兼防分支互为 base 时成环。
 * 中途出错就把已经摸到的那几层返回:链短一点仍然可用,报错反而把默认那档也一起没收了。
 */
export async function prBaseChain(ref: string, repoPath?: string): Promise<PrAncestor[]> {
  const parsed = parsePrRef(ref);
  const nwo = parsed.nwo || (await deriveNwo(repoPath));
  const chain: PrAncestor[] = [];
  const seen = new Set<string>();
  let cursor: string;
  try {
    cursor = await prBaseRef(nwo, parsed.num);
  } catch {
    return [];
  }
  const defaultBranch = await repoDefaultBranch(nwo);

  for (let i = 0; i < PR_CHAIN_DEPTH && cursor && !seen.has(cursor); i++) {
    seen.add(cursor);
    const parent = await prByHead(nwo, cursor);
    chain.push({
      ref: cursor,
      number: parent?.number ?? null,
      title: parent?.title ?? null,
      isDefaultBranch: !!defaultBranch && cursor === defaultBranch,
    });
    if (!parent) break; // 这一层没有对应 PR,链到此为止
    cursor = parent.baseRefName;
  }
  return chain;
}

/** 仓库默认分支名;取不到返回 null(那就别去断言某一环是不是它)。 */
async function repoDefaultBranch(nwo: string): Promise<string | null> {
  try {
    const out = await run('gh', [
      'repo', 'view', nwo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name',
    ]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function prBaseRef(nwo: string, num: string): Promise<string> {
  const json = await run('gh', ['pr', 'view', num, '--repo', nwo, '--json', 'baseRefName']);
  return (JSON.parse(json) as { baseRefName: string }).baseRefName;
}

/**
 * 以某分支为 head 的 PR(open);没有则 null —— 那一层就不是一个 PR,而是普通分支。
 *
 * **`gh pr list --head` 只按分支名过滤**(它的帮助里明写不支持 `<owner>:<branch>`),于是 fork 里
 * 一条同名分支的 PR 会一并命中 —— 拿它的 base 接着往下摸,整条链就串到了不相干的分支上。
 * 故多取几条、只认 head 在本仓库的那些。
 *
 * 同仓库仍有多条同名 head 时**返回 null 断链**,不静默挑一条:挑错会让 base 候选看起来正常、
 * 实际比的是另一条线,而断链只是少给几个候选,默认那档照旧可用。
 */
async function prByHead(
  nwo: string,
  head: string,
): Promise<{ number: number; title: string; baseRefName: string } | null> {
  try {
    const json = await run('gh', [
      'pr', 'list', '--repo', nwo, '--head', head, '--state', 'open', '--limit', '10',
      '--json', 'number,title,baseRefName,isCrossRepository',
    ]);
    const rows = JSON.parse(json) as {
      number: number;
      title: string;
      baseRefName: string;
      isCrossRepository: boolean;
    }[];
    const own = rows.filter((r) => !r.isCrossRepository);
    return own.length === 1 ? own[0] : null;
  } catch {
    return null;
  }
}

/** 列举某仓库最近的 open PR(nwo 或本地仓库路径二选一)。 */
export async function listOpenPrs(opts: { nwo?: string; repoPath?: string; limit?: number }): Promise<PrSummary[]> {
  const args = ['pr', 'list', '--state', 'open', '--limit', String(opts.limit ?? 20),
    '--json', 'number,title,author,additions,deletions,updatedAt'];
  if (opts.nwo) args.push('--repo', opts.nwo);
  const json = await run('gh', args, opts.repoPath);
  const rows = JSON.parse(json) as {
    number: number;
    title: string;
    author: { login: string };
    additions: number;
    deletions: number;
    updatedAt: string;
  }[];
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    author: r.author?.login ?? '',
    additions: r.additions,
    deletions: r.deletions,
    updatedAt: r.updatedAt,
  }));
}

/** 读某本地目录的 remote 归属(nameWithOwner);非 git / 无 gh 返回 null。 */
export async function getRepoRemote(repoPath: string): Promise<RepoRemoteInfo> {
  try {
    const out = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repoPath);
    return { nwo: out.trim() || null };
  } catch {
    return { nwo: null };
  }
}

/**
 * 由 PR 的 owner/repo 反推本机已 clone 的仓库路径,便于粘贴 PR 链接后自动复用本地全量代码。
 * 匹配以 origin remote 的 nameWithOwner 为准(大小写不敏感),命中即返回,全程离线、无 gh。
 * priorPaths 为历史审核用过的仓库路径(最近在前),既作直接候选、其父目录又作扫描根。
 */
export async function inferLocalRepo(nwo: string, priorPaths: string[]): Promise<string | null> {
  const target = nwo.toLowerCase();
  const [owner, repoName] = nwo.split('/');
  if (!owner || !repoName) return null;

  // Tier 1:历史用过的路径直接比对(数量少,用 git 命令兼容 worktree/gitbutler 的 .git 文件形态)
  for (const p of priorPaths) {
    if ((await gitRemoteNwo(p))?.toLowerCase() === target) return p;
  }

  // Tier 2:<root>/<repoName> 同名目录直探(clone 默认目录名即仓库名,命中率最高)
  for (const root of candidateRoots(priorPaths, owner)) {
    const cand = path.join(root, repoName);
    if ((await readGitConfigNwo(cand))?.toLowerCase() === target) return cand;
  }
  return null;
}

const INFER_ROOTS = [
  'Projects', 'projects', 'Developer', 'dev', 'Code', 'code',
  'src', 'repos', 'workspace', 'work', 'git', 'GitHub', 'github',
  path.join('Documents', 'GitHub'),
];

/** 反推扫描的候选根:历史仓库的父目录 + 常见开发目录 + go 布局的 owner 目录。 */
function candidateRoots(priorPaths: string[], owner: string): string[] {
  const home = os.homedir();
  const set = new Set<string>();
  for (const p of priorPaths) set.add(path.dirname(p));
  for (const r of INFER_ROOTS) set.add(path.join(home, r));
  set.add(path.join(home, 'go', 'src', 'github.com', owner));
  return [...set];
}

/** origin remote 的 nameWithOwner(去 .git 后缀);非 git / 无 origin 返回 null。用 git 命令,兼容各种 .git 形态。 */
async function gitRemoteNwo(repoPath: string): Promise<string | null> {
  try {
    return parseRemoteNwo((await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'])).trim());
  } catch {
    return null;
  }
}

/** 直接读 .git/config 取 origin nwo:比 spawn git 快得多,用于浅扫大量目录;非常规 clone(.git 为文件)返回 null。 */
async function readGitConfigNwo(dir: string): Promise<string | null> {
  try {
    const cfg = await readFile(path.join(dir, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/);
    return m ? parseRemoteNwo(m[1]) : null;
  } catch {
    return null;
  }
}

/** 从 remote URL 解析 owner/repo,兼容 git@host:owner/repo.git、ssh://、https:// 三种写法。 */
function parseRemoteNwo(url: string): string | null {
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 列举本地分支(相对 base 领先若干 commit),按最近提交时间倒序,取前 limit 个。
 * base 缺省自动探测默认分支;同时给出常见 base 候选供切换。
 */
export async function listLocalBranches(
  repoPath: string,
  baseRef?: string,
  limit = 30,
): Promise<LocalBranchList> {
  // 探测独立于调用方给的 base:两者同源会让「用户选的」冒充「自动探测的」(见 LocalBranchList)
  const detectedBase = await detectBaseRef(repoPath);
  const base = baseRef?.trim() || detectedBase;
  const head = (await run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  // refname|committerdate(unix)|subject —— \x1f 作字段分隔,避免与 subject 内容冲突
  const raw = await run('git', [
    '-C', repoPath, 'for-each-ref',
    '--sort=-committerdate',
    `--count=${limit}`,
    '--format=%(refname:short)%1f%(committerdate:unix)%1f%(subject)',
    'refs/heads',
  ]);
  const branches: LocalBranchSummary[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, unix, subject] = line.split('\x1f');
    if (!name || name === base) continue;
    let ahead = 0;
    try {
      ahead = Number((await run('git', ['-C', repoPath, 'rev-list', '--count', `${base}..${name}`])).trim()) || 0;
    } catch {
      // base 不可比较(如 base 不存在):领先数记 0,不阻断列举
    }
    branches.push({ name, isHead: name === head, ahead, updatedAt: Number(unix) * 1000, subject: subject ?? '' });
  }
  const baseCandidates = await existingBaseCandidates(repoPath, detectedBase);
  return { base, detectedBase, baseCandidates, branches };
}

/** GitButler 把整个 workspace 的改动挂在这条分支上;HEAD 在它上面即说明该按虚拟分支审核。 */
const WORKSPACE_BRANCH = 'gitbutler/workspace';

/**
 * 选定本地仓库后的模式探测:HEAD 在 workspace 分支且 GitButler 可用 → 按虚拟分支审,其余按普通 git 分支审。
 * 主判据用 `git symbolic-ref`(不依赖 but、detached HEAD 自然落到 local),
 * `but status` 只在主判据命中后跑一次,兼作可用性检查 —— 不可用则降级并说明原因。
 */
export async function inspectRepo(repoPath: string): Promise<RepoInspection> {
  const root = await gitToplevel(repoPath);
  const resolved = root ?? repoPath;
  const base: RepoInspection = {
    repoPath: resolved,
    repoName: path.basename(path.resolve(resolved)),
    isGit: !!root,
    head: null,
    mode: 'local',
    gitbutler: null,
    degraded: null,
  };
  if (!root) return base;

  const head = await headBranch(root);
  if (head !== WORKSPACE_BRANCH) return { ...base, head };

  const gitbutler = await detectGitButler(root);
  if (gitbutler.isWorkspace) return { ...base, head, mode: 'gitbutler', gitbutler };
  return { ...base, head, degraded: (await butInstalled()) ? 'not-setup' : 'but-missing' };
}

/** git 顶层目录;非 git 仓库返回 null。 */
async function gitToplevel(dir: string): Promise<string | null> {
  try {
    return (await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).trim() || null;
  } catch {
    return null;
  }
}

/** 当前分支名;detached HEAD 返回 null。 */
async function headBranch(repoPath: string): Promise<string | null> {
  try {
    return (await run('git', ['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

async function butInstalled(): Promise<boolean> {
  try {
    await run('but', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** 探测目录是否 GitButler workspace,并列举其 applied 虚拟分支。 */
export async function detectGitButler(repoPath: string): Promise<GitButlerStatus> {
  const repoName = path.basename(path.resolve(repoPath));
  let json: string;
  try {
    json = await butJson(['status'], repoPath);
  } catch {
    return { isWorkspace: false, repoName, branches: [], targetRef: null };
  }
  let parsed: ButStatus;
  try {
    parsed = JSON.parse(json) as ButStatus;
  } catch {
    return { isWorkspace: false, repoName, branches: [], targetRef: null };
  }
  const listed: Omit<VbranchSummary, 'fileCount'>[] = [];
  for (const [si, stack] of (parsed.stacks ?? []).entries()) {
    // assignedChanges 是整条 lane 的未提交部分,不含各 branch 已提交的那些
    const hasUncommitted = (stack.assignedChanges?.length ?? 0) > 0;
    // but 自顶向下列 stack 内的分支,位次即叠加次序:序号大的在下方,才可作上方分支的 base
    const stackId = stack.cliId || `s${si}`;
    for (const [bi, b] of (stack.branches ?? []).entries()) {
      listed.push({
        name: b.name,
        commitCount: b.commits?.length ?? 0,
        hasUncommitted,
        stackId,
        stackOrder: bi,
      });
    }
  }
  // 计量按 `but diff <branch>` 现算:那正是 GitButlerSource 取 diff 用的命令,
  // 于是入口卡片上的 N files 与进屏后看到的改动面天然同一个数。
  // 不去并集各 commit 的文件清单 —— 那是"历史触达过",后一个 commit 把前一个改回去时会多算。
  const branches: VbranchSummary[] = await Promise.all(
    listed.map(async (b) => ({ ...b, fileCount: await countDiffFiles(repoPath, b.name) })),
  );
  return { isWorkspace: true, repoName, branches, targetRef: await gitButlerTargetRef(repoPath) };
}

/** 虚拟分支相对 base 的净改动文件数;取不到(分支刚被改名 / but 报错)记 0,不阻断列举。 */
async function countDiffFiles(repoPath: string, branch: string): Promise<number> {
  try {
    return parseUnifiedDiff(await gitButlerDiff(repoPath, branch)).length;
  } catch {
    return 0;
  }
}

/**
 * 选定 base 后的改动面。**刻意绕一圈 source 而不另写一条 git 命令** —— 卡片上的数与进屏后
 * 的改动面必须由同一次构造得出,各算各的迟早分家(见 CLAUDE.md「改动面计量」)。
 */
export async function diffStat(target: ReviewTarget): Promise<DiffStat> {
  const source = createSource(target);
  try {
    await source.prepare();
    const files = parseUnifiedDiff(await source.getDiff());
    return {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  } finally {
    await source.dispose();
  }
}

interface ButStatus {
  stacks?: {
    cliId?: string;
    assignedChanges?: unknown[];
    branches?: { name: string; commits?: unknown[] }[];
  }[];
}

/**
 * workspace 的目标分支(整条 stack 的底)。but status 的 JSON 只给 mergeBase 的 commitId,
 * 没有名字;而 base 要落库、要在界面上显示,拿得住的是这条 git config 里的 ref 名。
 */
async function gitButlerTargetRef(repoPath: string): Promise<string | null> {
  try {
    const raw = (await run('git', ['-C', repoPath, 'config', '--get', 'gitbutler.project.targetref'])).trim();
    return raw.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '') || null;
  } catch {
    return null;
  }
}

/** github-pr review 的 PR 网页地址;ref 缺 owner/repo 时用 repoPath 推断,推断不出向上抛。 */
export async function resolvePrUrl(ref: string, repoPath?: string): Promise<string> {
  const parsed = parsePrRef(ref);
  const nwo = parsed.nwo || (await deriveNwo(repoPath));
  return `https://github.com/${nwo}/pull/${parsed.num}`;
}

async function deriveNwo(repoPath?: string): Promise<string> {
  if (!repoPath) throw new Error('PR 引用缺 owner/repo,且未提供本地仓库路径');
  const info = await getRepoRemote(repoPath);
  if (!info.nwo) throw new Error('无法从本地仓库推断 owner/repo');
  return info.nwo;
}


/** base 候选里本地分支最多列几条(默认分支那几档之外);再多就该用筛选而不是往下滚。 */
const BASE_BRANCH_LIMIT = 20;

/**
 * base 候选:探测到的 base 置顶,其次常见默认分支,再次本地分支(按最近提交倒序)。
 * 本地分支也要列 —— 叠在一起的分支互为 base 才审得出「只看上面这一层」。
 * 置顶的必须是**探测到的**那条,不是本次生效的那条:候选顺序跟着用户的选择变,列表会在他每选一次后重排。
 */
async function existingBaseCandidates(repoPath: string, detectedBase: string): Promise<string[]> {
  const out: string[] = [];
  for (const b of [detectedBase, ...BASE_ORDER]) {
    if (!out.includes(b) && (await refExists(repoPath, b))) out.push(b);
  }
  try {
    const raw = await run('git', [
      '-C', repoPath, 'for-each-ref',
      '--sort=-committerdate',
      `--count=${BASE_BRANCH_LIMIT}`,
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    for (const name of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!out.includes(name)) out.push(name);
    }
  } catch {
    // 列不出本地分支不阻断:常见默认分支那几档已经够用
  }
  return out;
}
