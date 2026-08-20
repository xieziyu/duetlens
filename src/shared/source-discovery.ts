/**
 * 入口发起页的「来源发现」结果类型:三来源各自的预检/列举数据。
 * 与具体 CLI(gh / git / but)解耦,renderer 与 main 共用。
 */

/** 单个 PR 的解析预览(粘贴/选取后展示的确认卡片)。 */
export interface PrPreview {
  nwo: string;
  number: number;
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  /** PR 的目标分支(base) */
  baseRef: string;
}

/** 仓库最近 open PR 的一项(供「从最近 open PR 选择」列表)。 */
export interface PrSummary {
  number: number;
  title: string;
  author: string;
  additions: number;
  deletions: number;
  /** ISO 时间串(更新于) */
  updatedAt: string;
}

/** 本地分支的一项(相对 base 领先若干 commit)。 */
export interface LocalBranchSummary {
  name: string;
  isHead: boolean;
  /** 相对 base 领先的 commit 数 */
  ahead: number;
  /** 最近一次提交的 epoch 毫秒 */
  updatedAt: number;
  /** 分支 HEAD 提交标题 */
  subject: string;
}

/** 本地仓库分支列举结果(含探测到的 base 与可选 base 候选)。 */
export interface LocalBranchList {
  /** 本次列举实际用的基线(= 调用方给的 baseRef,没给则等于 detectedBase);ahead 计数相对它 */
  base: string;
  /**
   * 自动探测出的默认基线,**与调用方给了什么无关**。
   * 两者必须分开:合成一格的话,用户选了别的 base 之后那条 base 会摇身变成「探测到的默认」,
   * 于是他再选回真默认时会被当成自定义值落库 —— 默认分支日后改名,复审就指向一条不存在的 ref。
   */
  detectedBase: string;
  baseCandidates: string[];
  branches: LocalBranchSummary[];
}

/**
 * stacked PR 的一层祖先:上一层 PR 的 base 分支,以及(若存在)以它为 head 的那个 PR。
 * 没有对应 PR 的层(通常是仓库默认分支)`number` 为 null。
 */
export interface PrAncestor {
  ref: string;
  number: number | null;
  title: string | null;
  /** 这条 ref 是不是仓库的默认分支;`number === null` 只说明没有以它为 head 的 open PR,不等于默认分支 */
  isDefaultBranch: boolean;
}

/** 一次改动面计量(选定 base 后现算,入口据此显示本次要审多大一片)。 */
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** GitButler 虚拟分支的一项。 */
export interface VbranchSummary {
  name: string;
  /** 相对 base 的净改动文件数;算不出(分支刚改名 / 与同名 tag 冲突 / but 报错)为 null */
  fileCount: number | null;
  commitCount: number;
  hasUncommitted: boolean;
  /** 所属 stack(同一条 lane 的分支共享);跨 stack 的分支之间没有叠加关系,不能互为 base */
  stackId: string;
  /** 在 stack 内自顶向下的位次:0 = 栈顶。序号大的在下方,才可作序号小的 base */
  stackOrder: number;
}

/** GitButler workspace 探测结果。 */
export interface GitButlerStatus {
  isWorkspace: boolean;
  /** workspace 根目录名(展示用) */
  repoName: string;
  branches: VbranchSummary[];
  /** workspace 的目标分支(整条 stack 的底,如 `origin/main`);读不到为 null */
  targetRef: string | null;
}

/** 本地仓库按哪条 source 实现审核。 */
export type RepoMode = 'gitbutler' | 'local';

/** HEAD 落在 workspace 分支、却仍降级为普通分支审核的原因。 */
export type RepoDegradeReason = 'but-missing' | 'not-setup';

/**
 * 选定本地仓库后的一次性探测:入口据此决定是按 GitButler 虚拟分支还是普通 git 分支审核。
 * 判据以 HEAD 分支名为主(不依赖 but),`but status` 只作可用性副判据。
 */
export interface RepoInspection {
  /** 归一到 git 顶层目录的路径(选到子目录时回写);非 git 仓库时为传入原值 */
  repoPath: string;
  repoName: string;
  isGit: boolean;
  /** 当前分支名;detached HEAD 为 null */
  head: string | null;
  mode: RepoMode;
  /** mode=gitbutler 时的虚拟分支列表 */
  gitbutler: GitButlerStatus | null;
  /** 非空表示 HEAD 在 workspace 分支但 GitButler 不可用,已降级为 local */
  degraded: RepoDegradeReason | null;
}

/** 某本地目录的 remote 归属(用于 PR 本地路径的 remote-匹配校验)。 */
export interface RepoRemoteInfo {
  /** nameWithOwner,取不到返回 null(非 git 仓库 / 无 gh) */
  nwo: string | null;
}
