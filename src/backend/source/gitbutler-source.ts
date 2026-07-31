import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { butJson } from './but-cli';
import type { PreparedSource, ReviewTarget, Source } from './source';

/** `but diff` JSON 输出的最小结构(只取重建 unified diff 所需字段)。 */
interface ButDiffJson {
  changes: ButChange[];
}
interface ButChange {
  path: string;
  /** 重命名时的原路径(字段名随版本,兼容取之) */
  previousPath?: string;
  oldPath?: string;
  status: string;
  diff?: { type: string; hunks?: { diff: string }[] };
}

/**
 * GitButler 虚拟分支 source:diff 走 `but diff <branch>` 的 JSON 输出(重建成标准 unified),
 * 文件读工作区磁盘内容(applied vbranch 的改动已落在 worktree,即新侧)。
 * target.ref = 虚拟分支名;target.repoPath = 已 setup 的 GitButler 项目目录。
 */
export class GitButlerSource implements Source {
  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const repo = this.target.repoPath;
    if (!repo) throw new Error('gitbutler-vbranch source 需指定 repoPath(GitButler 项目目录)');
    const branch = this.branch();
    // vbranch 的改动尚在工作区、无稳定 commit,故不给 headSha;复审改按 diff 原文比对判定变化。
    return { title: `GitButler · ${branch}`, cwd: repo };
  }

  async getDiff(): Promise<string> {
    const out = await butJson(['diff', this.branch(), '--no-tui'], this.target.repoPath);
    return toUnifiedDiff(JSON.parse(out) as ButDiffJson);
  }

  async getFile(p: string): Promise<string> {
    const full = this.resolveInRepo(p);
    if (!full) return `// 拒绝越界读取 ${p}`;
    try {
      return await readFile(full, 'utf8');
    } catch {
      return `// 无法读取 ${p}`;
    }
  }

  /** 把相对路径限制在 repoPath 内(防 `../` 穿越读盘);越界返回 null。 */
  private resolveInRepo(p: string): string | null {
    const root = path.resolve(this.target.repoPath);
    const full = path.resolve(root, p);
    return full === root || full.startsWith(root + path.sep) ? full : null;
  }

  async dispose(): Promise<void> {}

  private branch(): string {
    const ref = this.target.ref?.trim();
    if (!ref) throw new Error('gitbutler-vbranch source 需在 ref 指定虚拟分支名');
    return ref;
  }
}

/** 把 but 的结构化 diff 拼回标准 `diff --git` unified 文本,供 codex/MCP 消费。 */
export function toUnifiedDiff(json: ButDiffJson): string {
  const blocks: string[] = [];
  for (const c of json.changes) {
    if (c.diff?.type !== 'patch' || !c.diff.hunks?.length) continue; // 跳过二进制/无补丁体
    const oldPath = c.previousPath ?? c.oldPath ?? c.path;
    const added = /add|new|untrack/i.test(c.status);
    const deleted = /delete|remov/i.test(c.status);
    const lines = [
      `diff --git a/${oldPath} b/${c.path}`,
      `--- ${added ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${deleted ? '/dev/null' : `b/${c.path}`}`,
      ...c.diff.hunks.map((h) => h.diff.replace(/\n$/, '')),
    ];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}
