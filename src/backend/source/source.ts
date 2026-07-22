import type { SourceKind } from '@shared/domain';

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
  /** 用户给 agent 的附加上下文,随首轮机审注入(可选);仅审核配置,不影响 source 定位 */
  context?: string;
}

export interface PreparedSource {
  /** 供 UI/持久化的标题 */
  title: string;
  /** codex 会话的工作目录 */
  cwd: string;
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
  /** 按相对路径读被审文件(新侧内容) */
  getFile(path: string): Promise<string>;
  /** 清理临时资源(如临时 checkout) */
  dispose(): Promise<void>;
}
