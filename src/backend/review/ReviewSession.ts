import { EventEmitter } from 'node:events';
import {
  DuetlensMcpServer,
  type McpContentProviders,
  type ReportedFinding,
  type ReportedFindingUpdate,
} from '../mcp/DuetlensMcpServer';
import {
  reportFindingSchema,
  updateFindingSchema,
  type Discussion,
  type Finding,
  type Message,
} from '@shared/domain';
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
 *   'message'     (Message)         — 已落库的对话消息(user/agent)
 *   'agent-event' (AgentEvent)      — 归一后的 agent 流事件(转发)
 *   'status'      ('scanning'|'reviewing'|'failed')
 */
export class ReviewSession extends EventEmitter {
  private mcp?: DuetlensMcpServer;
  private unsubscribe?: () => void;
  private conversationId?: string;
  /** 串行化 turn:codex 单会话不能并发 turn,续问排在扫描/前一轮之后。 */
  private turnChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly reviewId: string,
    private readonly store: ReviewStore,
    private readonly agent: ConversationalAgent,
  ) {
    super();
  }

  /** 起会话 + 注入 + 跑首轮扫描;resolve 于扫描 turn 完成。 */
  async start(opts: StartReviewOptions): Promise<Finding[]> {
    const mcpUrl = await this.setupMcp(opts.providers);

    const handle = await this.agent.startConversation({
      cwd: opts.cwd,
      mcpUrl,
      mcpToken: this.mcp!.token,
      baseInstructions: opts.baseInstructions ?? DEFAULT_SCAN_INSTRUCTIONS,
    });
    this.conversationId = handle.conversationId;
    this.store.setCodexThreadId(this.reviewId, handle.conversationId);
    this.setStatus('scanning');

    const outcome = await this.runTurn(
      opts.scanPrompt ?? '请审核本次改动,对每个问题调用 report_finding 上报。',
    );
    if (!outcome.ok) {
      this.setStatus('failed');
      throw new Error(`首轮扫描失败: ${outcome.error}`);
    }
    this.setStatus('reviewing');
    return this.store.listFindings(this.reviewId);
  }

  /**
   * 续接已存在的 review 会话(app 重启后):按落库的 codexThreadId 从磁盘恢复 codex thread,
   * 重新注入 MCP,不重跑扫描。之后即可 sendMessage 追问。返回已落库的 findings。
   */
  async resume(opts: StartReviewOptions): Promise<Finding[]> {
    const review = this.store.getReview(this.reviewId);
    const threadId = review?.codexThreadId;
    if (!threadId) throw new Error('该 review 无 codex thread,无法续接');

    const mcpUrl = await this.setupMcp(opts.providers);
    const handle = await this.agent.resumeConversation({
      conversationId: threadId,
      cwd: opts.cwd,
      mcpUrl,
      mcpToken: this.mcp!.token,
      baseInstructions: opts.baseInstructions ?? DEFAULT_SCAN_INSTRUCTIONS,
    });
    this.conversationId = handle.conversationId;
    return this.store.listFindings(this.reviewId);
  }

  /**
   * 就某条 discussion 向 agent 追问:落库用户消息 → 带上下文续一轮 → 落库 agent 回复。
   * 复用同一 codex thread(全局视野);轮次串行,不与扫描/前一轮并发。
   */
  async sendMessage(discussionId: string, text: string): Promise<Message> {
    if (!this.conversationId) throw new Error('会话尚未建立,无法追问');
    const discussion = this.store.getDiscussion(discussionId);
    if (!discussion) throw new Error(`discussion 不存在: ${discussionId}`);

    const userMsg = this.store.addMessage(discussionId, 'user', text);
    this.emit('message', userMsg);

    const outcome = await this.runTurn(this.buildFollowupPrompt(discussion, text));
    if (!outcome.ok) throw new Error(`追问失败: ${outcome.error}`);

    const reply = outcome.reply.trim();
    if (!reply) return userMsg;
    const agentMsg = this.store.addMessage(discussionId, 'agent', reply);
    this.emit('message', agentMsg);
    return agentMsg;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.agent.dispose();
    await this.mcp?.close();
  }

  /** 建自建 MCP(finding 上报/回写落库)+ 订阅 agent 流事件外发;返回注入用的 HTTP 端点。 */
  private async setupMcp(providers: McpContentProviders): Promise<string> {
    this.mcp = new DuetlensMcpServer(providers);
    this.mcp.on('finding', (raw: ReportedFinding) => {
      const parsed = reportFindingSchema.safeParse(raw);
      if (!parsed.success) return; // 非法上报忽略;后续可回错误内容给 agent
      // 用 MCP 生成的 id 落库,使 codex 侧 id 与存储 id 一致(update_finding 可定位)
      const finding = this.store.addFinding(this.reviewId, parsed.data, 'agent', raw.id);
      this.emit('finding', finding);
    });
    this.mcp.on('finding-update', (raw: ReportedFindingUpdate) => {
      const parsed = updateFindingSchema.safeParse(raw);
      if (!parsed.success) return;
      const updated = this.store.updateFinding(parsed.data);
      if (updated) this.emit('finding', updated); // 复用 finding 事件;renderer upsert
    });
    const mcpUrl = await this.mcp.listen();
    this.unsubscribe = this.agent.streamEvents((e) => this.emit('agent-event', e));
    return mcpUrl;
  }

  /** 把追问拼上锚点/finding 上下文,让 agent 知道在聊哪一处(codex thread 已含扫描历史)。 */
  private buildFollowupPrompt(discussion: Discussion, text: string): string {
    const loc = discussion.file
      ? `${discussion.file}:${discussion.line ?? ''}${discussion.lineEnd ? `-${discussion.lineEnd}` : ''}`
      : '';
    if (discussion.kind === 'finding') {
      const finding = this.store.getFindingByDiscussion(discussion.id);
      if (finding) {
        return (
          `关于你上报的 finding「${finding.title}」(${finding.file}:${finding.line}):\n${text}\n` +
          `如需修改该 finding,调用 update_finding(finding_id="${finding.id}", ...)。`
        );
      }
    }
    return loc ? `关于 ${loc} 处的代码:\n${text}` : text;
  }

  /**
   * 跑一轮 turn(串行入队):累积 message-delta 作为 agent 回复文本,resolve 于 turn 结束。
   * 前一轮失败不阻断后续轮(链上 catch)。
   */
  private runTurn(text: string): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
    const run = async (): Promise<{ ok: true; reply: string } | { ok: false; error: string }> => {
      const conversationId = this.conversationId!;
      let reply = '';
      const offDelta = this.agent.streamEvents((e) => {
        if (e.kind === 'message-delta') reply += e.text;
      });
      const turnDone = this.nextTurnEnd();
      try {
        await this.agent.sendMessage(conversationId, text);
        const outcome = await turnDone;
        if (outcome.kind === 'turn-failed') return { ok: false, error: outcome.error };
        return { ok: true, reply };
      } finally {
        offDelta();
      }
    };
    const result = this.turnChain.then(run, run);
    this.turnChain = result.catch(() => undefined);
    return result;
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
