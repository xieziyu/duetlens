/**
 * ConversationalAgent —— 审核 agent 的接口层(见 docs/design/architecture.md)。
 * codex app-server 是目前唯一实现(CodexAgent,基于 CodexAppServer)。
 * 目的:把 agent 的 event/approval 模型包薄一层,归一成 Duetlens 领域事件,
 * 不让 codex 协议细节渗到 UI。**先只做一个真实实现,把接口磨对再谈第二个。**
 */

export interface StartConversationOptions {
  /** 审核目标工作目录(源码/diff 所在) */
  cwd: string;
  /** 多层级提示词(project→global→builtin),注入 codex baseInstructions */
  baseInstructions?: string;
  /** 自建 MCP server 的 HTTP 端点,注入让 agent 回传 findings */
  mcpUrl?: string;
}

/** 归一后的领域事件;codex 的 turn/item/* 流事件映射到这里。 */
export type AgentEvent =
  | { kind: 'turn-started'; turnId: string }
  | { kind: 'message-delta'; text: string }
  | { kind: 'tool-call'; server: string; tool: string; status: string; args?: unknown }
  | { kind: 'token-usage'; used: number; total?: number }
  | { kind: 'turn-completed'; turnId: string }
  | { kind: 'turn-failed'; turnId: string; error: string }
  | { kind: 'error'; error: string };

export interface ConversationHandle {
  /** codex threadId(用于续接/持久化) */
  readonly conversationId: string;
}

export interface ConversationalAgent {
  startConversation(opts: StartConversationOptions): Promise<ConversationHandle>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  streamEvents(handler: (e: AgentEvent) => void): () => void;
  interrupt(conversationId: string): Promise<void>;
  /** 反向审批的显式应答口子;受信工具默认自动 accept(见 CodexAppServer)。 */
  approve(requestId: string, decision: 'accept' | 'decline'): void;
  dispose(): void;
}
