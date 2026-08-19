import type { ReviewIntensity, SourceKind } from '@shared/domain';

/** 一次审核的目标定位(三种 source 共用)。 */
export interface ReviewTarget {
  source: SourceKind;
  /** github-pr: PR url / owner/repo#123 / 号;local-branch: 分支名(空=当前 HEAD);gitbutler: vbranch id */
  ref: string;
  /** 本地仓库工作目录(git 操作与读文件所在);github-pr 可为空(走 gh api) */
  repoPath: string;
  /** local-branch 的 diff 基线;缺省自动探测默认分支 */
  baseRef?: string;
  /** codex 模型(空=账号默认);仅审核配置,不影响 source 定位 */
  model?: string | null;
  /** reasoning effort(缺省 codex medium) */
  reasoningEffort?: string | null;
  /** 审核强度(标准 / 对抗);仅审核配置,不影响 source 定位 */
  intensity?: ReviewIntensity;
  /** 用户给 agent 的附加上下文,随首轮机审注入(可选);仅审核配置,不影响 source 定位 */
  context?: string;
}

export interface PreparedSource {
  /** 供 UI/持久化的标题 */
  title: string;
  /** codex 会话的工作目录 */
  cwd: string;
  /**
   * 被审代码的 head commit;复审时与上一轮比对即知代码有无变化。
   * 无稳定 commit 概念的 source(如工作区未提交改动)可为空,此时降级为「无法判定」。
   */
  headSha?: string | null;
}

/**
 * source 抽象:延续 1.0 SourceFlow 思路,把「取 diff / 读文件」统一,喂给自建 MCP。
 * 只读:review-only,不改工作区。
 */
export interface Source {
  /** 拉元数据、必要时准备工作目录 */
  prepare(): Promise<PreparedSource>;
  /** 本次改动的完整 unified diff */
  getDiff(): Promise<string>;
  /**
   * 按相对路径读被审文件(新侧内容)。
   * 读不到(已删除 / 不在该 ref / 越界)**必须抛**,不要回一句占位文本 ——
   * 读失败与读到内容不可分的话,MCP 的取证闸会把一次失败的读取记成「已取证」。
   */
  getFile(path: string): Promise<string>;
  /**
   * 全仓字面量搜索。**可选** —— 只有拿得到完整代码树、且能与 {@link getFile} 同口径的
   * source 才实现它(github-pr 走 `gh api` 逐文件取内容,没有可搜的树,故不实现)。
   *
   * 口径必须与 getFile 完全一致(同一 ref / 同一工作区),否则 agent 搜到的行号拿去 getFile
   * 会读到另一份内容 —— 那比没有搜索更坏:它会拿着对不上的两段代码推出一个像模像样的结论。
   *
   * 不实现时 MCP 层**不声明** search_code 工具,而不是声明了再报错 ——
   * 工具不存在,agent 就不会调用,也就不会把「搜不了」误读成「代码里没有」。
   */
  searchCode?(input: CodeSearchInput): Promise<CodeSearchResult>;
  /** 清理临时资源(如临时 checkout) */
  dispose(): Promise<void>;
}

export interface CodeSearchInput {
  /** 字面量(非正则);大小写敏感 */
  query: string;
  /** 可选的路径前缀过滤(git pathspec),缩小范围用 */
  pathPrefix?: string;
}

/** 一个文件里的命中。`hasMore` = 本文件还有未展示的命中(在 git 侧就截了,数不出精确条数)。 */
export interface CodeSearchFileHits {
  path: string;
  hits: { line: number; text: string }[];
  hasMore: boolean;
}

export interface CodeSearchResult {
  files: CodeSearchFileHits[];
  /** 收集到的命中数。读取阶段就按文件数与每文件条数封了顶,故这不是全仓真实总数 */
  total: number;
  /** 还有更多文件的命中没读(读满文件上限就停了,数不出还剩几个 —— 所以是布尔不是计数) */
  moreFiles: boolean;
}
