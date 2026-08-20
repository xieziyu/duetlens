import path from 'node:path';
import { refExists } from './base-ref';
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
 * GitButler 虚拟分支 source。target.ref = 虚拟分支名;target.repoPath = 已 setup 的 GitButler 项目目录。
 *
 * **取证一律读被审分支那棵 commit 树,不读工作区。** diff 的新侧就是这棵树(`but diff <branch>`
 * 与 `git diff <base>...<branch>` 都是 commit 比较),读别处就会与 diff 分家。工作区在 GitButler 下
 * 尤其读不得:它是**所有 applied lane 合并后的样子**,审 A 时 B 的改动就摊在那儿(实测 `cat b.txt`
 * 拿到另一条 lane 的内容,而 `git show A:b.txt` 正确地报 not in 'A'),agent 无从分辨。
 * 顺带,树读不跟随符号链接 —— 提交进仓库的 `leak -> ~/.ssh/id_rsa` 读回的是那行**链接目标字符串**,
 * 不是私钥,越界外泄面因此在结构上消失,不再靠一道 realpath 判断兜着。
 */
export class GitButlerSource implements Source {
  /**
   * 本次审核钉住的 commit。**在 prepare 时定死,不在每次读取时按分支名重解析** ——
   * GitButler 的日常就是 amend / absorb / squash,分支名指向的 commit 随时会变;
   * 按名字重解析会让后半程读到的树与开头拉的那份 diff 不是同一棵。
   */
  private head = '';
  /**
   * 取证是否已经读过 {@link head} 那棵树。读过之后 head 就**不能再重钉** ——
   * 已经发给 agent 的行号会对到另一份内容上。
   */
  private evidenceRead = false;
  /**
   * 这次审核的 diff,首次取用时定死。**不能留成「每次 getDiff 现拉」** ——
   * 缺省档只有 `but diff <branch>` 给得出「这条分支自己的提交」,而它认的是分支名:
   * 会话存活期间作者 amend 一次,MCP 的 get_diff 就回到了新树,而 get_file / search_code
   * 仍在 {@link head} 那棵旧树上,agent 会拿新行号去核旧内容 —— 正是本 source 要消除的那类错树。
   */
  private snapshot?: Promise<string>;

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const repo = this.target.repoPath;
    if (!repo) throw new Error('gitbutler-vbranch source 需指定 repoPath(GitButler 项目目录)');
    const branch = this.branch();
    // **只钉树,不在这里拉 diff**:这条路也服务「会话已释放时展开 DiffPane 上下文」——
    // 那边一个文件建一次 source,顺手拉整份 diff 会把按需读退化成每读一个文件全量 diff 一次。
    // applied 虚拟分支都有真实的 refs/heads/<name>,解析得到就是 diff 的新侧那棵树。
    // **必须写全 refs/heads/ 并要求剥到 commit**:短名的消歧顺序里 refs/tags 排在 refs/heads 之前,
    // 仓库存着同名旧 tag 时(`release` 分支 + `release` tag)只会给一句 ambiguous 警告,
    // 然后把取证钉到 tag 那棵树上,而 `but diff` 那侧仍审虚拟分支。
    try {
      this.head = await resolveCommit(repo, `refs/heads/${branch}`);
    } catch {
      throw new Error(`虚拟分支 ${branch} 不存在(已改名或已 unapply?)`);
    }
    // **解析出的 sha 不外报**:headSha 是复审判「代码有没有变」的判据,而 vbranch 的 sha 会因
    // amend / reorder 变动而内容没变,报出去会把没改的一轮说成改过。那条判据现在按 diff 原文比对,
    // 这里的 sha 只作「本次审的是哪棵树」的内部锚。
    return { title: `GitButler · ${branch}`, cwd: repo };
  }

  async getDiff(): Promise<string> {
    if (!this.head) throw new Error('gitbutler-vbranch source 尚未 prepare,无法取 diff');
    if (!this.snapshot) {
      // 失败不留缓存:一次 but 抖动否则会把这条 source 永久钉死在错误上
      this.snapshot = this.takeSnapshot().catch((e: unknown) => {
        this.snapshot = undefined;
        throw e;
      });
    }
    return this.snapshot;
  }

  /**
   * 取这次审核的 diff,并保证它与 {@link head} 是同一棵树。
   *
   * 显式 base 那档由两个 sha 完全决定,分支后来怎么动都取得回来。缺省档只有 `but diff <branch>`
   * 给得出「这条分支自己的提交」,而它认的是**名字** —— 于是必须趁分支还停在钉住的 commit 上取,
   * 取完再确认它没挪过;`rev-parse` 与 `but diff` 是两个进程,中间那条缝里一次 amend 就够让
   * 拿回来的 diff 属于另一棵树。取证还没读过树时重钉一次即可(等价于晚一点 prepare),
   * 读过之后就只能报错 —— 那时改口径会让已经发出去的行号失真。
   */
  private async takeSnapshot(): Promise<string> {
    const repo = this.target.repoPath;
    const branch = this.branch();
    if (this.target.baseRef?.trim()) {
      return gitButlerDiff(repo, branch, { baseRef: this.target.baseRef, head: this.head });
    }
    const ref = `refs/heads/${branch}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = await resolveCommit(repo, ref);
      if (at !== this.head) {
        if (this.evidenceRead) {
          throw new Error(`虚拟分支 ${branch} 在本次审核期间变动过,取不回与已读代码同一棵树的 diff(请重跑一轮)`);
        }
        this.head = at;
      }
      const diff = await gitButlerDiff(repo, branch);
      if ((await resolveCommit(repo, ref)) === this.head) return diff;
    }
    throw new Error(`虚拟分支 ${branch} 正在被反复改写,取不到稳定快照(请稍后重试)`);
  }

  async getFile(p: string): Promise<string> {
    // 先词法挡一道:`../` 与绝对路径连交给 git 的必要都没有,且这样报得出确切原因
    // (git 对两者的措辞分别是 outside repository / not in tree,读起来像文件不存在)。
    if (!this.withinRepo(p)) throw new Error(`拒绝越界读取 ${p}`);
    // 取树在 try 之外:未 prepare 是调用方用错了,与「这个文件不在树上」是两回事,
    // 放进 try 会被下面那句 catch 抹成同一个「无法读取」。
    const tree = this.treeish();
    try {
      return await run('git', ['-C', this.target.repoPath, 'show', `${tree}:${p}`]);
    } catch {
      // 抛而不是回占位文本:读失败与读到内容不可分的话,MCP 的取证闸会把一次失败的读记成「已取证」。
      throw new Error(`无法读取 ${p}(可能不在 ${this.branch()} 这棵树上)`);
    }
  }

  /** 与 {@link getFile} 同口径:搜同一棵树,而不是工作区 —— 否则搜到的行号拿去 getFile 读到的是另一份内容。 */
  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return gitGrep(this.target.repoPath, input.query, {
      treeish: this.treeish(),
      pathPrefix: input.pathPrefix,
    });
  }

  /** 词法上把相对路径限制在仓库内(挡 `../` 与绝对路径)。 */
  private withinRepo(p: string): boolean {
    const root = path.resolve(this.target.repoPath);
    const full = path.resolve(root, p);
    return full === root || full.startsWith(root + path.sep);
  }

  /** 钉住的那棵树;未 prepare 就取会落成 `git show :path`(读索引)—— 那是另一份内容,故明确拦住。 */
  private treeish(): string {
    if (!this.head) throw new Error('gitbutler-vbranch source 尚未 prepare,无法取证');
    this.evidenceRead = true;
    return this.head;
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
export async function gitButlerDiff(
  repo: string,
  branch: string,
  pinned?: { baseRef?: string | null; head?: string },
): Promise<string> {
  const base = pinned?.baseRef?.trim();
  if (!base) {
    // `but diff` 认的也是名字,而同名 tag 在场时它**静默回一份空 changes**(实测),
    // 整轮审核就会在「一处改动都没有」上跑完。挡在这里并说清怎么解 —— 这一档没法像下面那样
    // 换成 sha 绕开,`but diff` 只接受分支名。
    if (await refExists(repo, `refs/tags/${branch}`)) {
      throw new Error(
        `虚拟分支 ${branch} 与同名 tag 冲突,取不到缺省 diff(删掉 refs/tags/${branch},或改选一个 base)`,
      );
    }
    const out = await butJson(['diff', branch, '--no-tui'], repo);
    return toUnifiedDiff(JSON.parse(out) as ButDiffJson);
  }
  // 两端都先解析成 sha 再拼 range:界面传下来的是短名(stack 内的虚拟分支名,或 workspace target),
  // 直接交给 git 的话同名 tag 会抢在 refs/heads 前面,比较范围整段错掉且只有一句警告。
  const head = pinned?.head ?? (await resolveCommit(repo, `refs/heads/${branch}`));
  return run('git', ['-C', repo, 'diff', `${await resolveCommit(repo, base)}...${head}`]);
}

/**
 * 解析成 commit sha,**按 heads → remotes → 原名 的顺序**。base 候选有两类:虚拟分支名
 * (都有真实 `refs/heads/<name>`)与 workspace target —— 后者在 git config 里是完整的
 * `refs/remotes/origin/main`,但落库与界面显示的是剥掉前缀的 `origin/main`,不先试这两个
 * 命名空间就会被同名 tag 抢走(短名消歧里 refs/tags 排在两者之前)。
 * 一律剥到 `^{commit}`,顺带挡掉指向 tree/blob 的 ref。
 */
export async function resolveCommit(repo: string, name: string): Promise<string> {
  const candidates = name.startsWith('refs/')
    ? [name]
    : [`refs/heads/${name}`, `refs/remotes/${name}`, name];
  for (const ref of candidates) {
    try {
      return (await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
    } catch {
      // 下一档
    }
  }
  throw new Error(`无法解析 ref: ${name}`);
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
