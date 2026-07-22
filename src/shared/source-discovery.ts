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
  base: string;
  baseCandidates: string[];
  branches: LocalBranchSummary[];
}

/** GitButler 虚拟分支的一项。 */
export interface VbranchSummary {
  name: string;
  fileCount: number;
  commitCount: number;
  hasUncommitted: boolean;
}

/** GitButler workspace 探测结果。 */
export interface GitButlerStatus {
  isWorkspace: boolean;
  /** workspace 根目录名(展示用) */
  repoName: string;
  branches: VbranchSummary[];
}

/** 某本地目录的 remote 归属(用于 PR 本地路径的 remote-匹配校验)。 */
export interface RepoRemoteInfo {
  /** nameWithOwner,取不到返回 null(非 git 仓库 / 无 gh) */
  nwo: string | null;
}
