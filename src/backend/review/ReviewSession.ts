import { EventEmitter } from 'node:events';
import { DuetlensMcpServer, type McpContentProviders } from '../mcp/DuetlensMcpServer';
import { reportFindingSchema, type Finding } from '@shared/domain';
import type { AgentEvent, ConversationalAgent } from '../agent/ConversationalAgent';
import type { ReviewStore } from '../db/ReviewStore';

/** 首轮机审的默认提示词(review-only,自建 MCP 扫描;多层级提示词后续经此注入)。 */
export const DEFAULT_SCAN_INSTRUCTIONS = `你是 Duetlens 的代码审核 agent。审核本次改动,把发现的每个问题通过 duetlens MCP 的 report_finding 上报。
- 先调用 get_diff 查看改动,需要上下文时用 get_file 读取。
- 每个问题调用一次 report_finding,锚定 file 与新侧 line,给出 severity(high/medium/low)、category、title、body。
- 只审核、不修改代码。审完给一句话总结。`;

export interface StartReviewOptions {
  cwd: string;
  providers: McpContentProviders;
  baseInstructions?: string;
  scanPrompt?: string;
}

/**
 * 一次 review 的编排层:把 ConversationalAgent + 自建 MCP + 持久化串起来。
 * findings 经 MCP report_finding 落库(权威),并归一成领域事件外发给 IPC/UI。
 *
 * 事件:
 *   'finding'     (Finding)         — 已落库的 finding
 *   'agent-event' (AgentEvent)      — 归一后的 agent 流事件(转发)
 *   'status'      ('scanning'|'reviewing'|'failed')
 */
export class ReviewSession extends EventEmitter {
  private mcp?: DuetlensMcpServer;
  private unsubscribe?: () => void;

  constructor(
    private readonly reviewId: string,
    private readonly store: ReviewStore,
    private readonly agent: ConversationalAgent,
  ) {
    super();
  }

  /** 起会话 + 注入 + 跑首轮扫描;resolve 于扫描 turn 完成。 */
  async start(opts: StartReviewOptions): Promise<Finding[]> {
    this.mcp = new DuetlensMcpServer(opts.providers);
    this.mcp.on('finding', (raw) => {
      const parsed = reportFindingSchema.safeParse(raw);
      if (!parsed.success) return; // 非法上报忽略;后续可回错误内容给 agent
      const finding = this.store.addFinding(this.reviewId, parsed.data, 'agent');
      this.emit('finding', finding);
    });
    const mcpUrl = await this.mcp.listen();

    this.unsubscribe = this.agent.streamEvents((e) => this.emit('agent-event', e));

    const handle = await this.agent.startConversation({
      cwd: opts.cwd,
      mcpUrl,
      baseInstructions: opts.baseInstructions ?? DEFAULT_SCAN_INSTRUCTIONS,
    });
    this.store.setCodexThreadId(this.reviewId, handle.conversationId);
    this.setStatus('scanning');

    const turnDone = this.nextTurnEnd();
    await this.agent.sendMessage(
      handle.conversationId,
      opts.scanPrompt ?? '请审核本次改动,对每个问题调用 report_finding 上报。',
    );
    const outcome = await turnDone;

    if (outcome.kind === 'turn-failed') {
      this.setStatus('failed');
      throw new Error(`首轮扫描失败: ${outcome.error}`);
    }
    this.setStatus('reviewing');
    return this.store.listFindings(this.reviewId);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.agent.dispose();
    await this.mcp?.close();
  }

  private setStatus(status: 'scanning' | 'reviewing' | 'failed'): void {
    this.store.setReviewStatus(this.reviewId, status);
    this.emit('status', status);
  }

  /** 解析于下一个 turn 结束(完成或失败)。 */
  private nextTurnEnd(): Promise<Extract<AgentEvent, { kind: 'turn-completed' | 'turn-failed' }>> {
    return new Promise((resolve) => {
      const off = this.agent.streamEvents((e) => {
        if (e.kind === 'turn-completed' || e.kind === 'turn-failed') {
          off();
          resolve(e);
        }
      });
    });
  }
}
