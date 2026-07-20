/**
 * 归一后的 agent 领域事件(codex turn/item/* 映射到这里)。
 * 放 shared:backend 产生、renderer 消费,经 IPC 透传。
 */
export type AgentEvent =
  | { kind: 'turn-started'; turnId: string }
  | { kind: 'message-delta'; text: string }
  | { kind: 'tool-call'; server: string; tool: string; status: string; args?: unknown }
  | { kind: 'token-usage'; used: number; total?: number }
  // 上下文压缩由 codex auto-compact 触发,我们只观测(compaction 只摘要 codex 历史,
  // 不碰我们 DB 里的锚点/finding;不主动 thread/compact/start)。
  | { kind: 'compaction'; phase: 'started' | 'completed' }
  // 反向审批的统一观测面:受信工具 elicitation 自动 accept 为 expected;其余一律拒绝且 expected=false。
  | { kind: 'approval'; method: string; decision: 'accepted' | 'declined' | 'denied'; expected: boolean; server?: string; message?: string }
  | { kind: 'turn-completed'; turnId: string }
  | { kind: 'turn-failed'; turnId: string; error: string }
  | { kind: 'error'; error: string };
