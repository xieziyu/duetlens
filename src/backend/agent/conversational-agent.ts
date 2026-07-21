/**
 * ConversationalAgent —— 审核 agent 的接口层(见 docs/design/architecture.md)。
 * codex app-server 是目前唯一实现(CodexAgent,基于 CodexAppServer)。
 * 目的:把 agent 的 event/approval 模型包薄一层,归一成 Duetlens 领域事件,
 * 不让 codex 协议细节渗到 UI。**先只做一个真实实现,把接口磨对再谈第二个。**
 */

import type { AgentEvent } from '@shared/agent-events';

export type { AgentEvent };

export interface StartConversationOptions {
  /** 审核目标工作目录(源码/diff 所在) */
  cwd: string;
  /** 多层级提示词(project→global→builtin),注入 codex baseInstructions */
  baseInstructions?: string;
  /** 自建 MCP server 的 HTTP 端点,注入让 agent 回传 findings */
  mcpUrl?: string;
  /** 自建 MCP 的 bearer 令牌;codex 经 bearer_token_env_var 携带以隔离本地其他进程 */
  mcpToken?: string;
  /** 指定 codex 模型(空/缺省=账号默认) */
  model?: string | null;
  /** reasoning effort(透传 config.model_reasoning_effort;缺省 codex medium) */
  reasoningEffort?: string | null;
}

/** 续接已存在会话:同 start 的注入项 + 要续接的 conversationId。 */
export interface ResumeConversationOptions extends StartConversationOptions {
  conversationId: string;
}

export interface ConversationHandle {
  /** codex threadId(用于续接/持久化) */
  readonly conversationId: string;
}

export interface ConversationalAgent {
  startConversation(opts: StartConversationOptions): Promise<ConversationHandle>;
  /** 按 conversationId 从磁盘续接会话(app 重启后追问);须重新注入 MCP。 */
  resumeConversation(opts: ResumeConversationOptions): Promise<ConversationHandle>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  streamEvents(handler: (e: AgentEvent) => void): () => void;
  interrupt(conversationId: string): Promise<void>;
  /** 反向审批的显式应答口子;受信工具默认自动 accept(见 CodexAppServer)。 */
  approve(requestId: string, decision: 'accept' | 'decline'): void;
  dispose(): void;
}
