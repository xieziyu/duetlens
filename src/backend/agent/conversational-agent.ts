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
  /** agent 侧最终生效的模型;未指定模型时这是唯一能知道跑的是谁的途径 */
  readonly model?: string;
}

export interface ConversationalAgent {
  startConversation(opts: StartConversationOptions): Promise<ConversationHandle>;
  /** 按 conversationId 从磁盘续接会话(app 重启后追问);须重新注入 MCP。 */
  resumeConversation(opts: ResumeConversationOptions): Promise<ConversationHandle>;
  /**
   * 发起一轮 turn;返回该 turn 的 id,供调用方只认自己那一轮的终局事件。
   *
   * 返回空串表示这个 agent 不给 id:终局与 delta 的归属退回「来什么认什么」尚可将就,
   * 但 {@link interrupt} 点名不到 turn —— 这样的 agent 跑出来的轮次**叫停不了**。
   * codex 协议里没有 thread 级打断可退,故这不是能补的降级路径;要支持叫停就必须给出非空 id。
   */
  sendMessage(conversationId: string, text: string): Promise<string>;
  streamEvents(handler: (e: AgentEvent) => void): () => void;
  /** 打断指定 turn。turnId 必须是 {@link sendMessage} 给回的那个 —— 打断作用于具体一轮,不是整条会话。 */
  interrupt(conversationId: string, turnId: string): Promise<void>;
  /** 反向审批的显式应答口子;受信工具默认自动 accept(见 CodexAppServer)。 */
  approve(requestId: string, decision: 'accept' | 'decline'): void;
  dispose(): void;
}
