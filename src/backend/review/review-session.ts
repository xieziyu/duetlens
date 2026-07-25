import { EventEmitter } from 'node:events';
import {
  DuetlensMcpServer,
  type McpContentProviders,
  type ReportedFinding,
  type ReportedFindingResolution,
  type ReportedFindingUpdate,
} from '../mcp/duetlens-mcp-server';
import {
  isAutoClosedFixed,
  reportFindingSchema,
  resolveFindingSchema,
  updateFindingSchema,
  type Discussion,
  type Finding,
  type Message,
  type Review,
  type ReviewIntensity,
} from '@shared/domain';
import { findDuplicate } from '@shared/finding-dedupe';
import type { AgentErrorKind } from '@shared/agent-events';
import type { AgentEvent, ConversationalAgent } from '../agent/conversational-agent';
import type { ReviewStore } from '../db/review-store';
import { BUILTIN_BASE_INSTRUCTIONS } from '../prompt/review-prompt';

/** 首轮机审的缺省指令(未附加用户上下文时使用)。 */
export const DEFAULT_SCAN_PROMPT = '请审核本次改动,对每个问题调用 report_finding 上报。';

/**
 * 一轮机审因 agent 侧 turn 失败而中止。带上归因是为了让上层能落库、让 UI 能给出处置建议 ——
 * 退化成普通 Error 就只剩一句无从追问的红字。
 */
export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly errorKind: AgentErrorKind,
    /** agent 给的原文(不含我们加的轮次前缀),展开详情里原样呈现 */
    readonly detail: string,
  ) {
    super(message);
    this.name = 'AgentTurnError';
  }
}

/**
 * 对抗强度:扫描/复审 turn 之后追加的自检轮指令。同一 codex thread 内跑,
 * agent 仍记得本轮报过什么,故可就地补漏与给存疑结论降级(codex 侧无删除 finding 的工具)。
 */
export const ADVERSARIAL_SELFCHECK_PROMPT = `现在做一轮对抗式自检,站到刚才结论的对立面复核一遍:
1. 回看你**已上报**的每条 finding:有没有哪条其实站不住(反例不成立 / 是可接受差异 / 属误报)?站不住的用 update_finding 降级严重度,或在 body 里明确标注不确定,不要留下过度自信的结论。
2. 更重要的是审你**没报**的地方:哪个函数、边界或错误分支你只是扫过、并未真正构造反例去验证?对这些补一次证伪 —— 发现真实且可复现的新问题就用 report_finding 上报,已报过的不要重复。
3. 给一句话小结:本轮自检补报了几条、降级/撤回了几条。`;

type TurnOutcome =
  | { ok: true; reply: string }
  | { ok: false; error: string; errorKind: AgentErrorKind };

/** 追问时重述的历史条数上限;够唤起线程脉络,又不至于把整条对话再喂一遍。 */
const FOLLOWUP_RECAP = 6;

/** 把一条 discussion 的既往往来压成一段可注入的回顾;无历史返回空串。 */
function recap(history: readonly Message[]): string {
  if (history.length === 0) return '';
  const lines = history
    .slice(-FOLLOWUP_RECAP)
    .map((m) => `- ${m.role === 'user' ? 'reviewer' : '你'}: ${m.text.trim()}`);
  return `本讨论此前的往来(供你回忆,不必复述):\n${lines.join('\n')}\n\n`;
}

export interface StartReviewOptions {
  cwd: string;
  providers: McpContentProviders;
  baseInstructions?: string;
  scanPrompt?: string;
  /** 用户指定的 codex 模型(空/缺省=账号默认) */
  model?: string | null;
  /** reasoning effort(缺省 codex medium) */
  reasoningEffort?: string | null;
  /** 审核强度;对抗档在扫描 turn 后追加一轮自检 */
  intensity?: ReviewIntensity;
  /** 本次扫描属于第几轮;传入则把新建的 codex thread 记到该轮次上 */
  round?: number;
}

/**
 * ReviewSession 对外事件面的单一来源:事件名 → 载荷。
 * emit/on 都按此收敛,且 ReviewManager 的转发表是 `keyof` 映射 ——
 * 在这里加一条事件而忘了转发给 renderer,编译期就会报错(见 review-manager 的 SESSION_FORWARDERS)。
 */
export interface ReviewSessionEvents {
  /** review 记录本身有更新(如回填实际生效的模型) */
  review: Review;
  /** 已落库的 finding */
  finding: Finding;
  /** finding 的承载 discussion(与 finding 同事务建出,须成对外发) */
  discussion: Discussion;
  /** 已落库的对话消息(user/agent) */
  message: Message;
  /** 归一后的 agent 流事件(原样转发) */
  'agent-event': AgentEvent;
  status: 'scanning' | 'reviewing' | 'failed';
}

/**
 * 一次 review 的编排层:把 ConversationalAgent + 自建 MCP + 持久化串起来。
 * findings 经 MCP report_finding 落库(权威),并归一成领域事件外发给 IPC/UI。
 * 事件面见 {@link ReviewSessionEvents}。
 */
export class ReviewSession {
  /** 组合而非继承 EventEmitter:对外只暴露收窄过的 on/off,emit 留在类内。 */
  private readonly events = new EventEmitter();
  private mcp?: DuetlensMcpServer;
  private unsubscribe?: () => void;
  private conversationId?: string;
  /** 串行化 turn:codex 单会话不能并发 turn,续问排在扫描/前一轮之后。 */
  private turnChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly reviewId: string,
    private readonly store: ReviewStore,
    private readonly agent: ConversationalAgent,
  ) {}

  /** 订阅会话事件(事件面见 {@link ReviewSessionEvents});事件名与载荷由事件表收敛。 */
  on<K extends keyof ReviewSessionEvents>(
    event: K,
    listener: (payload: ReviewSessionEvents[K]) => void,
  ): this {
    this.events.on(event, listener);
    return this;
  }

  off<K extends keyof ReviewSessionEvents>(
    event: K,
    listener: (payload: ReviewSessionEvents[K]) => void,
  ): this {
    this.events.off(event, listener);
    return this;
  }

  /** 只有会话自身发事件;外部只能订阅。 */
  private emit<K extends keyof ReviewSessionEvents>(
    event: K,
    payload: ReviewSessionEvents[K],
  ): void {
    this.events.emit(event, payload);
  }

  /**
   * 起一个新的 codex thread + 注入 + 跑一轮机审;resolve 于该 turn 完成。
   * 首轮与每次重跑都走这里 —— 复审不复用上一轮会话,靠 scanPrompt 把上下文结构化带过来
   * (复用会话会让新旧 diff 的行号在同一上下文里互相污染)。
   */
  async start(opts: StartReviewOptions): Promise<Finding[]> {
    const mcpUrl = await this.setupMcp(opts.providers);

    const handle = await this.agent.startConversation({
      cwd: opts.cwd,
      mcpUrl,
      mcpToken: this.mcp!.token,
      baseInstructions: opts.baseInstructions ?? BUILTIN_BASE_INSTRUCTIONS,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    });
    this.conversationId = handle.conversationId;
    this.store.setCodexThreadId(this.reviewId, handle.conversationId);
    if (opts.round) this.store.setRoundThreadId(this.reviewId, opts.round, handle.conversationId);
    this.recordModel(handle.model);
    this.setStatus('scanning');

    const outcome = await this.runTurn(opts.scanPrompt ?? DEFAULT_SCAN_PROMPT);
    if (!outcome.ok) {
      this.setStatus('failed');
      const label = opts.round && opts.round > 1 ? `第 ${opts.round} 轮复审` : '首轮扫描';
      throw new AgentTurnError(`${label}失败: ${outcome.error}`, outcome.errorKind, outcome.error);
    }
    // 对抗档:同一 thread 追加一轮自检。已有扫描结论,自检失败不推翻本轮 —— 吞掉错误保留成果。
    if (opts.intensity === 'adversarial') {
      await this.runTurn(ADVERSARIAL_SELFCHECK_PROMPT);
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
      baseInstructions: opts.baseInstructions ?? BUILTIN_BASE_INSTRUCTIONS,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    });
    this.conversationId = handle.conversationId;
    this.recordModel(handle.model);
    return this.store.listFindings(this.reviewId);
  }

  /**
   * 回填 agent 侧实际生效的模型:用户可以不指定模型(走账号默认),
   * 那时只有起会话的应答里带着真名,不落库 UI 就永远只能显示「codex」。
   */
  private recordModel(model: string | undefined): void {
    if (!model) return;
    const review = this.store.getReview(this.reviewId);
    if (!review || review.model === model) return;
    this.store.setReviewModel(this.reviewId, model);
    const updated = this.store.getReview(this.reviewId);
    if (updated) this.emit('review', updated);
  }

  /**
   * 就某条 discussion 向 agent 追问:落库用户消息 → 带上下文续一轮 → 落库 agent 回复。
   * 复用同一 codex thread(全局视野);轮次串行,不与扫描/前一轮并发。
   */
  async sendMessage(discussionId: string, text: string): Promise<Message> {
    if (!this.conversationId) throw new Error('会话尚未建立,无法追问');
    const discussion = this.store.getDiscussion(discussionId);
    if (!discussion) throw new Error(`discussion 不存在: ${discussionId}`);

    // 历史要在落库新消息之前取,否则本次追问会被重复叙述一遍
    const history = this.store.listMessages(discussionId);
    const userMsg = this.store.addMessage(discussionId, 'user', text);
    this.emit('message', userMsg);

    const outcome = await this.runTurn(this.buildFollowupPrompt(discussion, text, history));
    if (!outcome.ok) throw new AgentTurnError(`追问失败: ${outcome.error}`, outcome.errorKind, outcome.error);

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
      if (this.absorbDuplicate(parsed.data)) return;
      // 用 MCP 生成的 id 落库,使 codex 侧 id 与存储 id 一致(update_finding 可定位)
      const finding = this.store.addFinding(this.reviewId, parsed.data, 'agent', raw.id);
      // 承载 discussion 与 finding 同事务建出;不一并外发的话,本轮会话内 Discussion 栏拿不到它,
      // 要等下次进 review 全量拉取才出现。先发 discussion 再发 finding,保证卡片可点即可用。
      const discussion = this.store.getDiscussion(finding.discussionId);
      if (discussion) this.emit('discussion', discussion);
      this.emit('finding', finding);
    });
    this.mcp.on('finding-update', (raw: ReportedFindingUpdate) => {
      const parsed = updateFindingSchema.safeParse(raw);
      if (!parsed.success) return;
      const updated = this.store.updateFinding(parsed.data);
      if (updated) this.emit('finding', updated); // 复用 finding 事件;renderer upsert
    });
    this.mcp.on('finding-resolution', (raw: ReportedFindingResolution) => {
      const parsed = resolveFindingSchema.safeParse(raw);
      if (!parsed.success) return;
      const { findingId, status, note } = parsed.data;
      // 只认本 review 名下的 id,防 agent 编造 / 串号写到别处
      const existing = this.store.getFinding(findingId);
      if (!existing || existing.reviewId !== this.reviewId) return;
      this.store.setFindingResolution(findingId, this.currentRound(), status, note);
      const updated = this.store.getFinding(findingId);
      if (updated) this.emit('finding', updated);
    });
    const mcpUrl = await this.mcp.listen();
    this.unsubscribe = this.agent.streamEvents((e) => this.emit('agent-event', e));
    return mcpUrl;
  }

  private currentRound(): number {
    return this.store.getReview(this.reviewId)?.currentRound ?? 1;
  }

  /**
   * 重复上报的兜底吸收(prompt 是软约束,这里是硬约束)。
   * 命中 reviewer 剔除项 → 抑制、只计数不落库;命中保留中的项 → 等价于 agent 表态「仍存在」;
   * 命中「复核已修复」自动结案的项 → 视作回归,恢复保留而不是继续抑制。
   * 返回 true 表示该上报已被吸收,不应新建 finding。
   */
  private absorbDuplicate(candidate: { file: string; line: number; title: string }): boolean {
    const dup = findDuplicate(candidate, this.store.listFindings(this.reviewId));
    if (!dup) return false;
    const round = this.currentRound();
    // 自动结案不是 reviewer 的判断,不能拿它当黑名单:否则修好又改回来的问题会被静默吞掉
    if (isAutoClosedFixed(dup)) {
      this.store.setTriage(dup.id, 'open');
    } else if (dup.triage === 'dismiss') {
      this.store.bumpSuppressed(this.reviewId, round);
      return true;
    }
    this.store.touchFindingSeen(dup.id, round);
    const updated = this.store.getFinding(dup.id);
    if (updated) this.emit('finding', updated);
    return true;
  }

  /**
   * 把追问拼上锚点/finding 上下文,让 agent 知道在聊哪一处。
   * 讨论历史一并重述:每轮复审都换新 thread,且 codex 会 auto-compact ——
   * 都不能指望会话自身还记得这条线程之前说过什么。
   */
  private buildFollowupPrompt(discussion: Discussion, text: string, history: Message[]): string {
    const loc = discussion.file
      ? `${discussion.file}:${discussion.line ?? ''}${discussion.lineEnd ? `-${discussion.lineEnd}` : ''}`
      : '';
    const prior = recap(history);
    if (discussion.kind === 'finding') {
      const finding = this.store.getFindingByDiscussion(discussion.id);
      if (finding) {
        return (
          `关于你上报的 finding「${finding.title}」(${finding.file}:${finding.line}):\n` +
          prior +
          `${text}\n` +
          `请在对话中直接回答,默认不要改动这条 finding。` +
          `只有当我明确要求「更新 / 回写 finding」时,才调用 update_finding(finding_id="${finding.id}", ...)。`
        );
      }
    }
    const head = loc ? `关于 ${loc} 处的代码:\n` : '';
    return `${head}${prior}${text}`;
  }

  /**
   * 跑一轮 turn(串行入队):累积 message-delta 作为 agent 回复文本,resolve 于 turn 结束。
   * 前一轮失败不阻断后续轮(链上 catch)。
   */
  private runTurn(text: string): Promise<TurnOutcome> {
    const run = async (): Promise<TurnOutcome> => {
      const conversationId = this.conversationId!;
      let reply = '';
      const offDelta = this.agent.streamEvents((e) => {
        if (e.kind === 'message-delta') reply += e.text;
      });
      const turnDone = this.nextTurnEnd();
      try {
        await this.agent.sendMessage(conversationId, text);
        const outcome = await turnDone;
        if (outcome.kind === 'turn-failed')
          return { ok: false, error: outcome.error, errorKind: outcome.errorKind };
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
