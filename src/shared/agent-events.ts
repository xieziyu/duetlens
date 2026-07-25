/** codex 的 token 计量。占用率只能用 used/total;cumulative 是累计消耗,可远超窗口。 */
export interface TokenUsage {
  /** 当前上下文占用(codex tokenUsage.last.totalTokens) */
  used: number;
  /** 整个 thread 的累计消耗(codex tokenUsage.total.totalTokens) */
  cumulative: number;
  /** 模型上下文窗口;codex 未上报时为空 */
  total?: number;
}

/**
 * 失败归因。provider 中立(codex 的 codexErrorInfo 映射到这里),因为 UI 的处置建议
 * 按「用户能做什么」分档,而不是按某家 agent 的错误码分档。
 */
export const AGENT_ERROR_KINDS = [
  /** 用量/额度耗尽 —— 换账号或等重置,重试无用 */
  'usage-limit',
  /** 上下文超限 —— 缩小审核范围才有救 */
  'context-exceeded',
  /** 上游过载或 5xx —— 稍后重试通常就好 */
  'server-overloaded',
  /** 连接层失败(握手/流中断)—— 查网络或代理后重试 */
  'connection',
  /** 未登录或凭证失效 —— 需要重新 codex login */
  'unauthorized',
  /** 请求被拒(参数/策略)—— 重试无用 */
  'bad-request',
  'other',
] as const;
export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

/**
 * 归一后的 agent 领域事件(codex turn/item/* 映射到这里)。
 * 放 shared:backend 产生、renderer 消费,经 IPC 透传。
 */
export type AgentEvent =
  | { kind: 'turn-started'; turnId: string }
  | { kind: 'message-delta'; text: string }
  | { kind: 'tool-call'; server: string; tool: string; status: string; args?: unknown }
  | ({ kind: 'token-usage' } & TokenUsage)
  // 上下文压缩由 codex auto-compact 触发,我们只观测(compaction 只摘要 codex 历史,
  // 不碰我们 DB 里的锚点/finding;不主动 thread/compact/start)。
  | { kind: 'compaction'; phase: 'started' | 'completed' }
  // 反向审批的统一观测面:受信工具 elicitation 自动 accept 为 expected;其余一律拒绝且 expected=false。
  | { kind: 'approval'; method: string; decision: 'accepted' | 'declined' | 'denied'; expected: boolean; server?: string; message?: string }
  | { kind: 'turn-completed'; turnId: string }
  | { kind: 'turn-failed'; turnId: string; error: string; errorKind: AgentErrorKind }
  // agent 自己还会重试的中途失败:一轮可能这样静默耗掉几十秒,不外发的话进度条是纯黑盒。
  | { kind: 'turn-retrying'; turnId: string; error: string; errorKind: AgentErrorKind }
  | { kind: 'error'; error: string };
