/**
 * 入口发起页的来源发现:三来源的轻量只读查询(gh 登录检测、PR 预览/列举、
 * 本地分支列举、GitButler workspace 探测、目录 remote 归属)。
 * 不进入 Source 的 prepare/diff 生命周期,仅为发起前的选择器供数据。
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  GitButlerStatus,
  LocalBranchList,
  LocalBranchSummary,
  PrPreview,
  PrSummary,
  RepoRemoteInfo,
  VbranchSummary,
} from '@shared/source-discovery';
import { run } from './exec';
import { parsePrRef } from './github-pr-source';

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
  const base = baseRef?.trim() || (await detectBase(repoPath));
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
  const baseCandidates = await existingBaseCandidates(repoPath, base);
  return { base, baseCandidates, branches };
}

/** 探测目录是否 GitButler workspace,并列举其 applied 虚拟分支。 */
export async function detectGitButler(repoPath: string): Promise<GitButlerStatus> {
  const repoName = path.basename(path.resolve(repoPath));
  let json: string;
  try {
    json = await run('but', ['status', '--format', 'json'], repoPath);
  } catch {
    return { isWorkspace: false, repoName, branches: [] };
  }
  let parsed: ButStatus;
  try {
    parsed = JSON.parse(json) as ButStatus;
  } catch {
    return { isWorkspace: false, repoName, branches: [] };
  }
  const branches: VbranchSummary[] = [];
  for (const stack of parsed.stacks ?? []) {
    const assigned = stack.assignedChanges?.length ?? 0;
    for (const b of stack.branches ?? []) {
      branches.push({
        name: b.name,
        fileCount: assigned,
        commitCount: b.commits?.length ?? 0,
        hasUncommitted: assigned > 0,
      });
    }
  }
  return { isWorkspace: true, repoName, branches };
}

interface ButStatus {
  stacks?: {
    assignedChanges?: unknown[];
    branches?: { name: string; commits?: unknown[] }[];
  }[];
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

const BASE_ORDER = ['origin/main', 'origin/master', 'main', 'master', 'develop'];

async function detectBase(repoPath: string): Promise<string> {
  for (const b of BASE_ORDER) {
    if (await refExists(repoPath, b)) return b;
  }
  const root = (await run('git', ['-C', repoPath, 'rev-list', '--max-parents=0', 'HEAD'])).trim();
  return root.split('\n')[0];
}

/** 存在的常见 base 候选(含探测到的 base 置顶),供发起表单切换对比基线。 */
async function existingBaseCandidates(repoPath: string, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const b of [base, ...BASE_ORDER]) {
    if (!out.includes(b) && (await refExists(repoPath, b))) out.push(b);
  }
  return out;
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}
