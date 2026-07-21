import { EventEmitter } from 'node:events';
import { CodexAppServer } from './codex-app-server';
import {
  CodexItemType,
  CodexNotification,
  type McpServerElicitationAction,
  type McpServerElicitationRequestParams,
  type McpToolCallItem,
} from './protocol';
import type {
  AgentEvent,
  ConversationHandle,
  ConversationalAgent,
  ResumeConversationOptions,
  StartConversationOptions,
} from '../conversational-agent';

/** 注入 bearer 令牌的 env 变量名(codex config 的 bearer_token_env_var 指向它)。 */
const MCP_TOKEN_ENV = 'DUETLENS_MCP_TOKEN';

export interface CodexAgentOptions {
  codexBin?: string;
  codexHome?: string;
  onLog?: (line: string) => void;
}

/**
 * ConversationalAgent 的 codex 实现:把 CodexAppServer 的协议事件归一成领域 AgentEvent。
 * 唯一实现(见 ConversationalAgent 说明);findings 不走这里,走 MCP report_finding。
 */
export class CodexAgent extends EventEmitter implements ConversationalAgent {
  private readonly server: CodexAppServer;

  constructor(opts: CodexAgentOptions = {}) {
    super();
    this.server = new CodexAppServer({
      codexBin: opts.codexBin,
      codexHome: opts.codexHome,
      trustedMcpServers: ['duetlens'],
      onLog: opts.onLog,
    });
    this.server.on('notification', (m, p) => this.mapNotification(m, p));
    this.server.on('error', (e: Error) => this.emitEvent({ kind: 'error', error: e.message }));
    // 反向审批统一观测面:受信 elicitation 自动 accept(expected),其余一律拒绝并上报。
    this.server.on('elicitation', (p: McpServerElicitationRequestParams, action: McpServerElicitationAction) => {
      const accepted = action === 'accept';
      this.emitEvent({
        kind: 'approval',
        method: 'mcpServer/elicitation/request',
        decision: accepted ? 'accepted' : 'declined',
        expected: accepted,
        server: p.serverName,
        message: p.message,
      });
    });
    this.server.on('unexpected-approval', (method: string, params: unknown) => {
      const server = (params as { serverName?: string } | undefined)?.serverName;
      this.emitEvent({ kind: 'approval', method, decision: 'denied', expected: false, server });
    });
  }

  async startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    await this.launchServer(opts.mcpToken);
    const res = await this.server.threadStart({
      cwd: opts.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      baseInstructions: opts.baseInstructions,
      model: opts.model || undefined,
      config: this.threadConfig(opts),
    });
    return { conversationId: res.thread.id };
  }

  async resumeConversation(opts: ResumeConversationOptions): Promise<ConversationHandle> {
    await this.launchServer(opts.mcpToken);
    const res = await this.server.threadResume({
      threadId: opts.conversationId,
      cwd: opts.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      baseInstructions: opts.baseInstructions,
      model: opts.model || undefined,
      config: this.threadConfig(opts),
    });
    return { conversationId: res.thread.id };
  }

  /** 起子进程(带 MCP 令牌 env)并握手。 */
  private async launchServer(mcpToken?: string): Promise<void> {
    this.server.start(mcpToken ? { [MCP_TOKEN_ENV]: mcpToken } : undefined);
    await this.server.initialize({ name: 'duetlens', version: '2.0.0-dev' });
  }

  /** per-thread config 覆盖:注入自建 MCP + reasoning effort(config.toml 形状透传)。 */
  private threadConfig(opts: StartConversationOptions): Record<string, unknown> | undefined {
    const config: Record<string, unknown> = {};
    if (opts.mcpUrl) {
      const duetlens: Record<string, unknown> = { url: opts.mcpUrl };
      if (opts.mcpToken) duetlens.bearer_token_env_var = MCP_TOKEN_ENV;
      config.mcp_servers = { duetlens };
    }
    if (opts.reasoningEffort) config.model_reasoning_effort = opts.reasoningEffort;
    return Object.keys(config).length ? config : undefined;
  }

  /** 发一轮对话;resolve 于 turn 启动,完成经 streamEvents 的 turn-completed。 */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    await this.server.turnStart({
      threadId: conversationId,
      input: [{ type: 'text', text }],
    });
  }

  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  async interrupt(conversationId: string): Promise<void> {
    await this.server.turnInterrupt(conversationId);
  }

  // 受信工具的反向审批由 CodexAppServer 自动 accept;此口子留给未来非受信场景。
  approve(): void {}

  dispose(): void {
    this.server.stop();
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }

  private mapNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case CodexNotification.turnStarted:
        this.emitEvent({ kind: 'turn-started', turnId: turnId(p) });
        break;
      case CodexNotification.agentMessageDelta:
        this.emitEvent({ kind: 'message-delta', text: String(p.delta ?? '') });
        break;
      case CodexNotification.itemStarted:
      case CodexNotification.itemCompleted: {
        const item = p.item as { type?: string } | undefined;
        if (item?.type === CodexItemType.mcpToolCall) {
          const call = item as McpToolCallItem;
          this.emitEvent({
            kind: 'tool-call',
            server: call.server,
            tool: call.tool,
            status: call.status,
            args: call.arguments,
          });
        } else if (item?.type === CodexItemType.contextCompaction) {
          this.emitEvent({
            kind: 'compaction',
            phase: method === CodexNotification.itemStarted ? 'started' : 'completed',
          });
        }
        break;
      }
      case CodexNotification.tokenUsageUpdated: {
        const usage = p.tokenUsage as
          | { total?: { totalTokens?: number }; modelContextWindow?: number | null }
          | undefined;
        this.emitEvent({
          kind: 'token-usage',
          used: usage?.total?.totalTokens ?? 0,
          total: usage?.modelContextWindow ?? undefined,
        });
        break;
      }
      case CodexNotification.turnCompleted: {
        const turn = p.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
        if (turn?.status === 'failed') {
          this.emitEvent({
            kind: 'turn-failed',
            turnId: turn.id ?? '',
            error: turn.error?.message ?? 'turn failed',
          });
        } else {
          this.emitEvent({ kind: 'turn-completed', turnId: turn?.id ?? '' });
        }
        break;
      }
    }
  }
}

function turnId(p: Record<string, unknown>): string {
  const turn = p.turn as { id?: string } | undefined;
  return turn?.id ?? '';
}
