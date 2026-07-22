/**
 * 入口发起页的来源发现:三来源的轻量只读查询(gh 登录检测、PR 预览/列举、
 * 本地分支列举、GitButler workspace 探测、目录 remote 归属)。
 * 不进入 Source 的 prepare/diff 生命周期,仅为发起前的选择器供数据。
 */
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
