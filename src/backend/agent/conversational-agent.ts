/**
 * ConversationalAgent —— 审核 agent 的接口层(见 docs/design/architecture.md)。
 * 把各家 agent 的协议包薄一层,归一成 Duetlens 领域事件,不让协议细节渗到 UI。
 *
 * 契约写的是 **Duetlens 需要什么**,不是某家 agent 恰好给什么。某条约束只对一家成立时,
 * 写在那家的实现里;这里只留两边都得守的那部分(pi 与 codex 的差异见 docs/design/pi-integration.md)。
 */

import type { AgentEvent } from '@shared/agent-events';

export type { AgentEvent };

export interface StartConversationOptions {
  /** 审核目标工作目录(源码/diff 所在)。agent 的可读范围随它走,会直接影响结论。 */
  cwd: string;
  /** 多层级提示词(project→global→builtin),作为会话的系统级指令注入 */
  baseInstructions?: string;
  /**
   * Duetlens 工具服务(MCP)的 HTTP 端点,agent 经它回传 findings。
   * 怎么接上去是各实现自己的事 —— 工具清单与 schema 一律以这个端点为准,实现侧不另抄。
   */
  mcpUrl?: string;
  /** 工具服务的 bearer 令牌。只能经环境变量交给子进程:命令行对同机其他进程可见。 */
  mcpToken?: string;
  /** 指定模型(空/缺省 = agent 自己的默认) */
  model?: string | null;
  /** 推理强度;取值与缺省由各实现映射到自家的档位 */
  reasoningEffort?: string | null;
}

/** 续接已存在会话:同 start 的注入项 + 要续接的 conversationId。 */
export interface ResumeConversationOptions extends StartConversationOptions {
  conversationId: string;
}

export interface ConversationHandle {
  /** agent 侧的会话 id(用于续接/持久化) */
  readonly conversationId: string;
  /** agent 侧最终生效的模型;未指定模型时这是唯一能知道跑的是谁的途径 */
  readonly model?: string;
}

/**
 * 一个 **turn** = 一次 {@link ConversationalAgent.sendMessage} 到它的那一条终局事件
 * (`turn-completed` / `turn-failed`)。agent 内部怎么切分不算数 —— 同名概念在别家可能
 * 只是这其中的一段,映射时以这里为准。
 *
 * 实现都起**只读**会话,且须**失败关闭**:证实不了只读就拒绝开工,不带着未知权限往下跑。
 * 各家能证实的东西不同,判据各写在自己的实现里,不共用。
 */
export interface ConversationalAgent {
  startConversation(opts: StartConversationOptions): Promise<ConversationHandle>;
  /** 按 conversationId 从磁盘续接会话(app 重启后追问);注入项要重新给一遍。 */
  resumeConversation(opts: ResumeConversationOptions): Promise<ConversationHandle>;
  /**
   * 发起一个 turn;返回它的 id,供调用方只认自己那一轮的终局事件、点名打断。
   * 同一会话内 turn 串行,调用方负责排队。
   *
   * id 由实现给出:协议自带就透传,协议只有会话级打断的就自己编号 —— 串行保证了
   * 「当前那一轮」唯一,编号足以点名。空串只作为**协议漂移时的降级**被容忍
   * (归属退回「来什么认什么」,且这一轮叫停不了),不是可选的正常形态。
   */
  sendMessage(conversationId: string, text: string): Promise<string>;
  streamEvents(handler: (e: AgentEvent) => void): () => void;
  /**
   * 打断指定 turn。turnId 必须是 {@link sendMessage} 给回的那个。
   * 那一轮已经结束时**不得波及别的 turn** —— 调用方的叫停是对当时那一轮取的快照,
   * 靠会话级打断实现的话,不核对 id 就会误杀紧随其后的下一轮。
   */
  interrupt(conversationId: string, turnId: string): Promise<void>;
  dispose(): void;
}
