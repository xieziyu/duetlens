/**
 * 归一后的 agent 领域事件(codex turn/item/* 映射到这里)。
 * 放 shared:backend 产生、renderer 消费,经 IPC 透传。
 */
export type AgentEvent =
  | { kind: 'turn-started'; turnId: string }
  | { kind: 'message-delta'; text: string }
  | { kind: 'tool-call'; server: string; tool: string; status: string; args?: unknown }
  | { kind: 'token-usage'; used: number; total?: number }
  | { kind: 'turn-completed'; turnId: string }
  | { kind: 'turn-failed'; turnId: string; error: string }
  | { kind: 'error'; error: string };
