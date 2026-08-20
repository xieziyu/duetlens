import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { butJson } from './but-cli';
import { run } from './exec';
import { gitGrep } from './git-grep';
import type {
  CodeSearchInput,
  CodeSearchResult,
  PreparedSource,
  ReviewTarget,
  Source,
} from './source';

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
 * 文件读工作区磁盘内容。
 * target.ref = 虚拟分支名;target.repoPath = 已 setup 的 GitButler 项目目录。
 *
 * **两侧口径不同,是已知取舍**:`but diff <branch>` 只给这条分支的**已提交**内容(实测:工作区里
 * 改了它的文件、甚至新建一个从未提交的文件,都不出现在里面),而 getFile / searchCode 读的是
 * **工作区**。于是有未提交改动时,读回的内容会比 diff 新,极端情况下行号对不上。
 * 指定 base 走 git 那条路同理 —— 两条路在这点上一致,不是切 base 才有的问题。
 */
export class GitButlerSource implements Source {
  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const repo = this.target.repoPath;
    if (!repo) throw new Error('gitbutler-vbranch source 需指定 repoPath(GitButler 项目目录)');
    const branch = this.branch();
    // vbranch 没有单一稳定的 head(分支随时被 amend / reorder / 改名),故不给 headSha;
    // 复审改按 diff 原文比对判定变化。
    return { title: `GitButler · ${branch}`, cwd: repo };
  }

  async getDiff(): Promise<string> {
    return gitButlerDiff(this.target.repoPath, this.branch(), this.target.baseRef);
  }

  async getFile(p: string): Promise<string> {
    const full = this.resolveInRepo(p);
    if (!full) throw new Error(`拒绝越界读取 ${p}`);
    // **词法判断拦不住符号链接**:readFile 会跟随它,而被审仓库完全可以提交一条
    // `leak -> ~/.ssh/id_rsa` —— `<root>/leak` 在词法上就在根内,读回来的却是仓库外的私钥,
    // 再由取证工具原样送进模型上下文。故解析真实路径后再判一次归属。
    // 根本身也要 realpath:macOS 的 /tmp 就是 /private/tmp 的链接,不解析会把自家路径判成越界。
    let realRoot: string;
    let real: string;
    try {
      realRoot = await realpath(this.target.repoPath);
      real = await realpath(full);
    } catch {
      // 不存在 / 断链 —— 是读不到,不是越界,别把两者说成一回事
      throw new Error(`无法读取 ${p}`);
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`拒绝越界读取 ${p}(符号链接指向仓库外)`);
    }
    try {
      return await readFile(real, 'utf8');
    } catch {
      throw new Error(`无法读取 ${p}`);
    }
  }

  /** 与 {@link getFile} 同口径:搜工作区(vbranch 的改动尚未提交),含未跟踪的新文件。 */
  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return gitGrep(this.target.repoPath, input.query, {
      untracked: true,
      pathPrefix: input.pathPrefix,
    });
  }

  /** 词法上把相对路径限制在 repoPath 内(挡 `../` 与绝对路径);符号链接由 getFile 再判一次。 */
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

/**
 * 虚拟分支的 unified diff。**入口卡片的计量与本函数必须同源**(见 CLAUDE.md「改动面计量」),
 * 否则卡片上的 N files 与进屏后看到的改动面会分家。
 *
 * 缺省(不指定 base)沿用 `but diff <branch>`,它给的是这条分支自己的提交 ——
 * 在 stack 里即「相对紧邻下层分支」。指定 base 时改走 git:stack 内各分支都有真实
 * `refs/heads/<name>`,三点比较从 merge-base 起算,故目标分支后来前进也不会倒着显示成删除。
 */
export async function gitButlerDiff(repo: string, branch: string, baseRef?: string): Promise<string> {
  const base = baseRef?.trim();
  if (!base) {
    const out = await butJson(['diff', branch, '--no-tui'], repo);
    return toUnifiedDiff(JSON.parse(out) as ButDiffJson);
  }
  return run('git', ['-C', repo, 'diff', `${base}...${branch}`]);
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
