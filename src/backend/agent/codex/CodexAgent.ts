import { EventEmitter } from 'node:events';
import { CodexAppServer } from './CodexAppServer';
import { CodexNotification, type McpToolCallItem } from './protocol';
import type {
  AgentEvent,
  ConversationHandle,
  ConversationalAgent,
  StartConversationOptions,
} from '../ConversationalAgent';

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
  }

  async startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    this.server.start();
    await this.server.initialize({ name: 'duetlens', version: '2.0.0-dev' });
    const res = await this.server.threadStart({
      cwd: opts.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      baseInstructions: opts.baseInstructions,
      config: opts.mcpUrl ? { mcp_servers: { duetlens: { url: opts.mcpUrl } } } : undefined,
    });
    return { conversationId: res.thread.id };
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
        const item = p.item as McpToolCallItem | undefined;
        if (item?.type === 'mcpToolCall') {
          this.emitEvent({
            kind: 'tool-call',
            server: item.server,
            tool: item.tool,
            status: item.status,
            args: item.arguments,
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
