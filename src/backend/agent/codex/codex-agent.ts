import { EventEmitter } from 'node:events';
import { CodexAppServer } from './codex-app-server';
import { APP_VERSION } from '@shared/version';
import {
  CodexItemType,
  CodexNotification,
  CodexServerRequest,
  codexErrorKind,
  type CodexErrorNotification,
  type CodexModel,
  type CodexTurnError,
  type McpServerElicitationAction,
  type McpServerElicitationRequestParams,
  type EffectiveThreadPolicy,
  type McpToolCallItem,
  type ThreadResumeResponse,
  type ThreadStartResponse,
} from './protocol';
import { CODEX_TARGET_VERSION } from '@shared/codex';
import { SANDBOX_NOT_APPLIED_CODE } from '@shared/ipc';
import type {
  AgentEvent,
  ConversationHandle,
  ConversationalAgent,
  ResumeConversationOptions,
  StartConversationOptions,
} from '../conversational-agent';

/** 注入 bearer 令牌的 env 变量名(codex config 的 bearer_token_env_var 指向它)。 */
const MCP_TOKEN_ENV = 'DUETLENS_MCP_TOKEN';

/**
 * 把关执行/写入/权限的反向审批 —— 只读 + approvalPolicy=never 的会话里一条都不该出现,
 * 故可当沙箱注入是否失效的哨兵。`mcpElicitation` **不在此列**:那是工具调用的确认,
 * 用户自己在 config.toml 里配的第三方 MCP server 也会发,被拒不能说明我们的注入没生效。
 */
export const POLICY_APPROVALS: ReadonlySet<string> = new Set([
  CodexServerRequest.execCommandApproval,
  CodexServerRequest.applyPatchApproval,
  CodexServerRequest.commandExecutionApproval,
  CodexServerRequest.fileChangeApproval,
  CodexServerRequest.permissionsApproval,
]);

/** 抹平大小写与分隔符再比:`readOnly` / `read-only` / `read_only` 说的是同一件事。 */
const norm = (v: string | undefined): string => (v ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * 证实只读注入**真的落地**,否则拒绝开工。见 {@link SANDBOX_NOT_APPLIED_CODE} ——
 * 请求发出去不算数,codex 会静默吞掉它不认识的字段。
 *
 * 读不到策略同样判死(失败关闭):这一侧宁可误伤 —— 误伤是「装不上、去升级」,
 * 漏判是「审核 agent 在未知策略下对你的仓库动手,且没有任何提示」。
 */
function assertReadOnly(res: ThreadStartResponse | ThreadResumeResponse): void {
  const sandbox = (res as EffectiveThreadPolicy).sandbox?.type;
  const approval = (res as EffectiveThreadPolicy).approvalPolicy;
  if (norm(sandbox) === 'readonly' && norm(approval) === 'never') return;
  const seen = `sandbox=${sandbox ?? '(未回显)'}, approvalPolicy=${approval ?? '(未回显)'}`;
  throw new Error(
    `${SANDBOX_NOT_APPLIED_CODE} codex 没有按只读沙箱起会话(${seen})。` +
      `本机 codex ${res.thread.cliVersion ?? '版本未知'},这版 Duetlens 对齐的是 ${CODEX_TARGET_VERSION}。`,
  );
}

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
        gate: 'mcp',
        server: p.serverName,
        message: p.message,
      });
    });
    this.server.on('unexpected-approval', (method: string, params: unknown) => {
      const server = (params as { serverName?: string } | undefined)?.serverName;
      this.emitEvent({
        kind: 'approval',
        method,
        decision: 'denied',
        expected: false,
        gate: POLICY_APPROVALS.has(method) ? 'policy' : 'mcp',
        server,
      });
    });
  }

  /**
   * 列举账号可用模型:起一次性 app-server、握手、`model/list`(分页取全)后即关。
   * 不注入 MCP、不起 thread、不发 turn,故不烧 token;复用本机 codex 登录态。
   */
  static async listModels(opts: CodexAgentOptions = {}): Promise<CodexModel[]> {
    const server = new CodexAppServer({ codexBin: opts.codexBin, codexHome: opts.codexHome, onLog: opts.onLog });
    try {
      server.start();
      await server.initialize({ name: 'duetlens', version: APP_VERSION });
      const models: CodexModel[] = [];
      let cursor: string | null | undefined;
      // 分页兜底:cursor 续取,上限防御异常服务端不收敛
      for (let page = 0; page < 20; page++) {
        const res = await server.listModels({ cursor, includeHidden: false });
        models.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return models.filter((m) => !m.hidden);
    } finally {
      server.stop();
    }
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
    this.acceptOrStop(res);
    return { conversationId: res.thread.id, model: res.model || undefined };
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
    this.acceptOrStop(res);
    return { conversationId: res.thread.id, model: res.model || undefined };
  }

  /**
   * 校验不过就顺手把自己起的子进程收掉 —— 这一步已经在 launchServer 之后,
   * 光抛错的话会留下一个谁也用不了的 codex 进程活到 app 退出。
   */
  private acceptOrStop(res: ThreadStartResponse | ThreadResumeResponse): void {
    try {
      assertReadOnly(res);
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  /** 起子进程(带 MCP 令牌 env)并握手。 */
  private async launchServer(mcpToken?: string): Promise<void> {
    this.server.start(mcpToken ? { [MCP_TOKEN_ENV]: mcpToken } : undefined);
    await this.server.initialize({ name: 'duetlens', version: APP_VERSION });
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

  /** 发一轮对话;resolve 于 turn 启动(带回 turnId),完成经 streamEvents 的 turn-completed。 */
  async sendMessage(conversationId: string, text: string): Promise<string> {
    const started = await this.server.turnStart({
      threadId: conversationId,
      input: [{ type: 'text', text }],
    });
    return started.turn?.id ?? '';
  }

  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  async interrupt(conversationId: string, turnId: string): Promise<void> {
    await this.server.turnInterrupt({ threadId: conversationId, turnId });
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
        this.emitEvent({
          kind: 'message-delta',
          text: String(p.delta ?? ''),
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
        });
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
        // last = 本轮真实占用的上下文;total 是全 thread 累计(含每轮重发的 cached input),
        // 拿 total 比窗口会得到几百 % 的假数。
        // reasoning 要扣掉:那部分只活在产出它的那一次请求里,下一次就不再回传,留着会高估占用。
        // modelContextWindow 已是有效窗口(codex 按模型的 effective 比例折算,如 272K → 258.4K)。
        const usage = p.tokenUsage as
          | {
              total?: { totalTokens?: number };
              last?: { totalTokens?: number; reasoningOutputTokens?: number };
              modelContextWindow?: number | null;
            }
          | undefined;
        const last = usage?.last;
        this.emitEvent({
          kind: 'token-usage',
          used: Math.max(0, (last?.totalTokens ?? 0) - (last?.reasoningOutputTokens ?? 0)),
          cumulative: usage?.total?.totalTokens ?? 0,
          total: usage?.modelContextWindow ?? undefined,
        });
        break;
      }
      // codex 内部退避重试期间的中途失败。只在它还会再试时外发 —— 不再试的那次紧跟着
      // turn/completed(failed),两边都发会把同一次失败报两遍。
      case CodexNotification.error: {
        const n = p as unknown as CodexErrorNotification;
        if (!n.willRetry) break;
        this.emitEvent({
          kind: 'turn-retrying',
          turnId: n.turnId ?? '',
          error: n.error?.message ?? 'turn error',
          errorKind: codexErrorKind(n.error?.codexErrorInfo),
        });
        break;
      }
      case CodexNotification.turnCompleted: {
        const turn = p.turn as { id?: string; status?: string; error?: CodexTurnError } | undefined;
        if (turn?.status === 'failed') {
          this.emitEvent({
            kind: 'turn-failed',
            turnId: turn.id ?? '',
            error: turnErrorText(turn.error),
            errorKind: codexErrorKind(turn.error?.codexErrorInfo),
          });
        } else {
          this.emitEvent({ kind: 'turn-completed', turnId: turn?.id ?? '' });
        }
        break;
      }
    }
  }
}

/** 失败原文:additionalDetails 常常才是可诊断的那半(HTTP 状态、上游错误码),别丢。 */
function turnErrorText(e: CodexTurnError | undefined): string {
  const message = e?.message?.trim();
  const details = e?.additionalDetails?.trim();
  if (!message) return details || 'turn failed';
  return details && !message.includes(details) ? `${message}\n${details}` : message;
}

function turnId(p: Record<string, unknown>): string {
  const turn = p.turn as { id?: string } | undefined;
  return turn?.id ?? '';
}
