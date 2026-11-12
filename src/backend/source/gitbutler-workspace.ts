import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { butJson } from './but-cli';
import { run } from './exec';

interface ButBranch {
  name: string;
  commits?: unknown[];
}

interface ButStatusWorktree {
  name: string;
  reference: string;
  base?: { commitId?: string };
  uncommittedChanges?: unknown[];
  branches?: ButBranch[];
}

export interface ButStatus {
  stacks: { assignedChanges?: unknown[]; branches?: ButBranch[] }[];
  worktrees?: ButStatusWorktree[];
}

interface ButWorktreePath {
  name: string;
  refName: string | null;
  path?: string | null;
}

type ButWorktrees =
  | { kind: 'available'; active: ButWorktreePath[]; archived: ButWorktreePath[] }
  | { kind: 'legacy' }
  | { kind: 'unavailable' };

export async function readGitButlerStatus(repoPath: string): Promise<ButStatus | null> {
  try {
    const status = JSON.parse(await butJson(['status'], repoPath)) as ButStatus | null;
    if (!Array.isArray(status?.stacks)) return null;
    return {
      stacks: status.stacks,
      worktrees: Array.isArray(status.worktrees) ? status.worktrees : undefined,
    };
  } catch {
    return null;
  }
}

export async function readGitButlerWorktrees(repoPath: string): Promise<ButWorktrees> {
  try {
    const list = JSON.parse(await butJson(['worktree', 'list'], repoPath)) as {
      active?: ButWorktreePath[];
      archived?: ButWorktreePath[];
      entries?: unknown[];
    } | null;
    if (Array.isArray(list?.active) && Array.isArray(list.archived)) {
      return { kind: 'available', active: list.active, archived: list.archived };
    }
    if (Array.isArray(list?.entries)) return { kind: 'legacy' };
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    if (/unrecognized subcommand '(worktree|list)'/.test(stderr)) return { kind: 'legacy' };
  }
  return { kind: 'unavailable' };
}

export async function gitToplevel(dir: string): Promise<string | null> {
  try {
    return (await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '') || null;
  } catch {
    return null;
  }
}

export async function gitHeadRef(repoPath: string): Promise<string | null> {
  try {
    return (await run('git', ['-C', repoPath, 'symbolic-ref', '--quiet', 'HEAD'])).replace(/\r?\n$/, '') || null;
  } catch {
    return null;
  }
}

export async function readMainGitWorktree(repoPath: string): Promise<{
  repoPath: string;
  hasLinked: boolean;
} | null> {
  try {
    // Git 总把主工作区排在第一条。NUL 分隔保留路径里的空格和换行。
    const [main, linked] = (await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain', '-z'])).split('\0\0', 2);
    const first = main.split('\0', 1)[0];
    if (!first.startsWith('worktree ')) return null;
    const mainPath = first.slice('worktree '.length);
    return { repoPath: await realpath(mainPath).catch(() => mainPath), hasLinked: !!linked };
  } catch {
    return null;
  }
}

export function realWorktreePath(tree: ButWorktreePath): Promise<string | null> {
  return typeof tree.path === 'string' && path.isAbsolute(tree.path)
    ? realpath(tree.path).catch(() => null)
    : Promise.resolve(null);
}

type CheckoutResult = { ok: true; repoPath: string } | { ok: false; message: string };

export async function resolveGitButlerCheckout(repoPath: string, branch: string): Promise<CheckoutResult> {
  const status = await readGitButlerStatus(repoPath);
  if (!status) return { ok: false, message: '无法读取 GitButler 工作区状态' };

  const ref = `refs/heads/${branch}`;
  const worktree = status.worktrees?.find((tree) =>
    tree.reference === ref || tree.branches?.some((item) => item.name === branch),
  );
  const paths = await readGitButlerWorktrees(repoPath);
  // Worktree 的路径条目只带栈顶 ref，较下层的分支归属从 status 取。
  const active = paths.kind === 'available'
    ? paths.active.find((tree) => worktree
      ? tree.name === worktree.name && tree.refName === worktree.reference
      : tree.refName === ref)
    : undefined;
  if (active) {
    const root = await realWorktreePath(active);
    if (root) {
      const [top, main, head] = await Promise.all([
        gitToplevel(root), readMainGitWorktree(root), gitHeadRef(root),
      ]);
      if (top === root && main && root !== main.repoPath && head === active.refName
        && (await realpath(repoPath).catch(() => null)) === main.repoPath) {
        return { ok: true, repoPath: root };
      }
    }
    return { ok: false, message: `GitButler worktree ${active.name} 的目录已删除或不可用` };
  }

  if (worktree || (paths.kind === 'available' && paths.archived.some((tree) => tree.refName === ref))) {
    return { ok: false, message: `分支 ${branch} 的 GitButler worktree 已归档、删除或无法定位` };
  }
  if (status.stacks.some((stack) => stack.branches?.some((item) => item.name === branch))) {
    return { ok: true, repoPath };
  }
  if (paths.kind === 'legacy') {
    return { ok: false, message: `当前 GitButler 版本无法定位分支 ${branch} 的 worktree` };
  }
  return { ok: false, message: `分支 ${branch} 未出现在活动的 GitButler 工作区中，可能已归档或删除` };
}
