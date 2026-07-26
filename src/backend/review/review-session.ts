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
  scanDoneStatus,
  updateFindingSchema,
  type Discussion,
  type Finding,
  type Message,
  type Review,
  type ReviewIntensity,
} from '@shared/domain';
import { findDuplicate } from '@shared/finding-dedupe';
import { FOLLOWUP_REPLY_FAILED_CODE } from '@shared/ipc';
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
 * 追问的问题**已落库并上屏**,失败发生在等 agent 回复那一步。
 *
 * 消息里嵌 {@link FOLLOWUP_REPLY_FAILED_CODE}:Electron IPC 只把 message 串过去、自定义字段一律丢失,
 * renderer 认这一段才分得清「这句话没发出去(该原样重发)」与「发出去了、只是没等到回复
 * (重发就是把同一句说两遍)」。
 */
export class FollowupReplyError extends Error {
  constructor(readonly cause: unknown) {
    super(`${FOLLOWUP_REPLY_FAILED_CODE} ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'FollowupReplyError';
  }
}

/**
 * 会话已被释放(退出 / LRU 逐出 / 删除审核),手上与队里的 turn 一律就地作废。
 * codex 进程都拆了,终局事件不会再来 —— 不兑现就是让调用方与 UI 永远等下去。
 */
export class SessionDisposedError extends Error {
  constructor(message = '会话已释放,无法继续') {
    super(message);
    this.name = 'SessionDisposedError';
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
  | { kind: 'ok'; reply: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string; errorKind: AgentErrorKind };

/** turn 的终局:agent 侧的完成/失败,或我们主动叫停/释放会话。 */
type TurnEnd =
  | Extract<AgentEvent, { kind: 'turn-completed' | 'turn-failed' }>
  | { kind: 'stopped' }
  | { kind: 'disposed' };

/**
 * 一次 turn 的终局等待。turnId 要到 turn/start 应答回来才知道,而终局事件可能更早到
 * (stub / 极快的 turn 都会),故 identify 之前先扣住,认领后再比对。
 */
interface TurnWaiter {
  end: Promise<TurnEnd>;
  /** 本次 turn 的 id 到手;空串表示 agent 没给,退回「来什么认什么」。 */
  identify: (turnId: string) => void;
  /** 本次 turn 已收到的回复文本(只含属于它的 delta)。 */
  reply: () => string;
  /** 不再需要这次等待(如 turn 根本没起来),拆掉订阅。 */
  cancel: () => void;
}

/**
 * 一次叫停能作用到的等待。叫停是**针对当时正在跑的那个 turn** 的,
 * 故由 {@link ReviewSession.stopScan} 取快照逐个通知,而不是置一个全局旗子。
 */
interface StopTarget {
  /** 打断已发出、结果未知:此后到达的终局先扣住,等 gate 出结果再定性 */
  begin: (gate: Promise<void>) => void;
  /** 打断成功:本次等待就地按「已停止」收尾,不再等 codex 的终局 */
  stop: () => void;
}

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
  status: 'scanning' | 'reviewing' | 'completed' | 'failed';
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
  /** reviewer 已叫停本轮机审(见 {@link stopScan});收轮时据此记 stopped 而非 done。 */
  private stopped = false;
  /**
   * 正在等终局的那些 turn。叫停只作用于**当下这一批** —— 停完还能继续追问,
   * 后起的 turn 必须按自己的真实终局收尾,不能被一个 session 级的旗子一路判成「已停止」。
   */
  private readonly stopTargets = new Set<StopTarget>();
  /**
   * 会话已释放({@link dispose})。此后新起与排队中的 turn 一律就地作废,
   * 不再去等一个已经没有进程能发出的终局。
   */
  private disposed = false;
  /**
   * 正在等终局的那些 turn 的作废钩子。释放会话时逐个兑现 —— 只 reject 建会话闸门是不够的:
   * 闸门早已放行,等在 awaitTurnEnd 上的追问不会因此醒来。
   */
  private readonly liveWaiters = new Set<() => void>();
  /**
   * 在途活动数:建/续会话与每个 turn 各占一份。>0 = 拆掉这个会话会打断 agent 手上的活,
   * 见 {@link isBusy}。只数 turn 是不够的 —— 会话已入表、MCP 与 codex thread 还在建的那段
   * 同样拆不得,那时被逐出只会让这次审核以一句莫名其妙的失败收场。
   */
  private inFlight = 0;
  /**
   * codex thread 建起来之前的闸门。追问可以早于建会话到达(Discussion 栏空态明说「不必等」),
   * 那一问必须排在建会话之后跑 —— 就地回绝的话,用户按下发送就什么都不剩:输入框已清空,
   * 消息还没落库,界面上只留一条空讨论。会话建不起来 / 被释放时以原因兑现,免得永远干等。
   */
  private readonly conversationReady: Promise<void>;
  private openConversation!: () => void;
  private failConversation!: (reason: unknown) => void;

  constructor(
    private readonly reviewId: string,
    private readonly store: ReviewStore,
    private readonly agent: ConversationalAgent,
  ) {
    this.conversationReady = new Promise<void>((resolve, reject) => {
      this.openConversation = resolve;
      this.failConversation = reject;
    });
    // 没有追问在等时也可能被 reject(会话释放),挂个空 handler 免得成为进程级 unhandledRejection
    this.conversationReady.catch(() => undefined);
  }

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
  start(opts: StartReviewOptions): Promise<Finding[]> {
    return this.gated(() => this.track(() => this.runStart(opts)));
  }

  private async runStart(opts: StartReviewOptions): Promise<Finding[]> {
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
    this.openConversation();
    this.store.setCodexThreadId(this.reviewId, handle.conversationId);
    if (opts.round) this.store.setRoundThreadId(this.reviewId, opts.round, handle.conversationId);
    this.recordModel(handle.model);
    this.setStatus('scanning');

    const outcome = await this.runTurn(opts.scanPrompt ?? DEFAULT_SCAN_PROMPT);
    if (outcome.kind === 'failed') {
      this.setStatus('failed');
      const label = opts.round && opts.round > 1 ? `第 ${opts.round} 轮复审` : '首轮扫描';
      throw new AgentTurnError(`${label}失败: ${outcome.error}`, outcome.errorKind, outcome.error);
    }
    // 对抗档:同一 thread 追加一轮自检。已有扫描结论,自检失败不推翻本轮 —— 吞掉错误保留成果。
    // 叫停是"到此为止",自检轮当然也不再跑;扫描 turn 恰好抢在打断前跑完也照样算叫停。
    if (outcome.kind === 'ok' && !this.stopped && opts.intensity === 'adversarial') {
      await this.runTurn(ADVERSARIAL_SELFCHECK_PROMPT);
    }
    const source = this.store.getReview(this.reviewId)?.source;
    this.setStatus(source ? scanDoneStatus(source) : 'reviewing');
    return this.store.listFindings(this.reviewId);
  }

  /**
   * 续接已存在的 review 会话(app 重启后):按落库的 codexThreadId 从磁盘恢复 codex thread,
   * 重新注入 MCP,不重跑扫描。之后即可 sendMessage 追问。返回已落库的 findings。
   */
  resume(opts: StartReviewOptions): Promise<Finding[]> {
    return this.gated(() => this.track(() => this.runResume(opts)));
  }

  private async runResume(opts: StartReviewOptions): Promise<Finding[]> {
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
    this.openConversation();
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
    await this.conversationReady; // 会话还在建就排在它后面,别把这一问丢掉
    // 等闸门期间会话可能已被拆掉。抢在落库之前回绝,这一问才算「没发出去」——
    // composer 留着原文,重发时管理层会续接一个新会话。
    if (this.disposed) throw new SessionDisposedError('会话已释放,无法追问');
    const discussion = this.store.getDiscussion(discussionId);
    if (!discussion) throw new Error(`discussion 不存在: ${discussionId}`);
    // 只认本 review 名下的线程:串号的话,消息会写进上一条 review 的 discussion,
    // 却由本 review 的 codex thread 作答,两边数据都被污染。
    if (discussion.reviewId !== this.reviewId)
      throw new Error(`discussion 不属于本次审核: ${discussionId}`);

    // 历史要在落库新消息之前取,否则本次追问会被重复叙述一遍
    const history = this.store.listMessages(discussionId);
    const userMsg = this.store.addMessage(discussionId, 'user', text);
    this.emit('message', userMsg);

    // 过了这一行,问题已经落库并推给了 UI:此后再失败都是「没等到回复」,不是「没发出去」。
    // 两者对用户的下一步截然相反,故换上识别串(见 FollowupReplyError)。
    try {
      const outcome = await this.runTurn(this.buildFollowupPrompt(discussion, text, history));
      if (outcome.kind === 'failed')
        throw new AgentTurnError(`追问失败: ${outcome.error}`, outcome.errorKind, outcome.error);
      if (outcome.kind === 'stopped') return userMsg;

      const reply = outcome.reply.trim();
      if (!reply) return userMsg;
      const agentMsg = this.store.addMessage(discussionId, 'agent', reply);
      this.emit('message', agentMsg);
      return agentMsg;
    } catch (e) {
      throw new FollowupReplyError(e);
    }
  }

  /**
   * reviewer 中途叫停本轮机审:打断 agent 当前 turn,已上报的 findings 一条不丢,
   * review 直接进入人工审核阶段。
   *
   * 打断成功后**不再等** codex 为这个 turn 发终局 —— 那条事件不保证会来,
   * 干等就会把这一轮永远挂在「扫描中」;就地兑现等待钩子收轮。
   * 边界行为(打断在途收到终局 / 打断失败 / 终局迟到)见 scripts/spike-stop-scan.ts。
   */
  async stopScan(): Promise<void> {
    if (this.stopped) return;
    const conversationId = this.conversationId;
    if (!conversationId) throw new Error('会话尚未建立,无法停止');

    // 打断的应答与 turn 终局是两条各走各的消息,谁先到都不一定。闸门必须**先于**打断挂上:
    // 在途期间到达的终局一律先扣住,由打断的成败来定性 —— 成了算「已停止」,
    // 没成就还它本来的面目(那一轮确实是自己挂的/跑完的),别让两边各说一套。
    // 快照也要在此刻取:被叫停的是**现在**在跑的那个 turn,之后新起的追问与这次叫停无关。
    const targets = [...this.stopTargets];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    for (const t of targets) t.begin(gate);
    try {
      await this.agent.interrupt(conversationId);
      this.stopped = true;
      for (const t of targets) t.stop();
    } finally {
      openGate(); // 没停成的话,扣住的终局在这里还原本色
    }
  }

  /** 本轮机审是否被 reviewer 叫停(收轮时据此记 stopped 而非 done)。 */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * agent 手上是否有活:建/续会话中,或有在跑的 turn。并发上限逐出会话时据此避让 ——
   * 拆掉忙碌会话等于凭空打断别人的机审,那一轮只会以一句莫名其妙的失败收场。
   */
  isBusy(): boolean {
    return this.inFlight > 0;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 排在闸门后的追问跟着这个会话一起完:不兑现的话它们会一直等一个再也不会来的 codex thread
    this.failConversation(new SessionDisposedError('会话已释放,无法追问'));
    // 会话已经建起来的那批更要管:闸门早放行了,正在等终局的 turn 只能由这里终结。
    // 快照迭代 —— 兑现会顺手把自己从表里摘掉。
    for (const abort of [...this.liveWaiters]) abort();
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
    // 无锚点 = reviewer 在问整体(架构 / 取舍 / 某个跨文件的疑问),得说清范围是本次改动全体,
    // 否则 agent 容易拿上一条讨论的锚点当上下文接着答。
    const head = loc ? `关于 ${loc} 处的代码:\n` : '关于本次改动整体(未锚定到具体代码位置):\n';
    return `${head}${prior}${text}`;
  }

  /**
   * 建/续会话的外层:失败时把 {@link conversationReady} 一并兑现。
   * 已经建起来之后才失败(turn 挂了)的,闸门早已放行,这里是空操作。
   */
  private gated<T>(run: () => Promise<T>): Promise<T> {
    return run().catch((e: unknown) => {
      this.failConversation(e);
      throw e;
    });
  }

  /** 在途期间计入 {@link isBusy};建会话与跑 turn 共用,可嵌套(start 内部还会再跑 turn)。 */
  private async track<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await run();
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * 跑一轮 turn(串行入队):累积 message-delta 作为 agent 回复文本,resolve 于 turn 结束。
   * 前一轮失败不阻断后续轮(链上 catch)。
   */
  private runTurn(text: string): Promise<TurnOutcome> {
    const run = async (): Promise<TurnOutcome> => {
      // 排在队里的那些:轮到自己时会话可能已经拆了,别再发一轮出去等终局
      if (this.disposed) throw new SessionDisposedError();
      const conversationId = this.conversationId!;
      // 订阅要先于发起:极快的 turn(乃至 stub)会在 turn/start 应答之前就把 delta 与终局发出来
      const waiter = this.awaitTurnEnd();
      try {
        waiter.identify(await this.agent.sendMessage(conversationId, text));
      } catch (e) {
        waiter.cancel(); // turn 根本没起来,别把订阅留在那儿等一个不会来的终局
        throw e;
      }
      const outcome = await waiter.end;
      if (outcome.kind === 'disposed') throw new SessionDisposedError();
      if (outcome.kind === 'stopped') return { kind: 'stopped' };
      if (outcome.kind === 'turn-failed')
        return { kind: 'failed', error: outcome.error, errorKind: outcome.errorKind };
      return { kind: 'ok', reply: waiter.reply() };
    };
    // 排队期间也算忙:队里还压着一轮的会话被拆掉,和跑到一半被拆没有区别。
    this.inFlight += 1;
    const result = this.turnChain.then(run, run).finally(() => {
      this.inFlight -= 1;
    });
    this.turnChain = result.catch(() => undefined);
    return result;
  }

  private setStatus(status: 'scanning' | 'reviewing' | 'completed' | 'failed'): void {
    this.store.setReviewStatus(this.reviewId, status);
    this.emit('status', status);
  }

  /**
   * 等下一个 turn 收尾(完成、失败,或被 {@link stopScan} 叫停),并只收集属于它的回复文本。
   *
   * **一切以 turnId 为准**:被叫停的那轮之后往往还会补终局与残余 delta,谁来都收的话,
   * 那条迟到的终局会被下一次追问当成自己的(追问提前返回空回复),残余文本还会混进追问的答案。
   * turnId 要到 turn/start 应答才知道,故认领之前先扣住,认领后再逐条比对。
   */
  private awaitTurnEnd(): TurnWaiter {
    type TerminalEvent = Extract<AgentEvent, { kind: 'turn-completed' | 'turn-failed' }>;
    const cleanup: (() => void)[] = [];
    let settle!: (end: TurnEnd) => void;
    const end = new Promise<TurnEnd>((resolve) => {
      settle = resolve;
    });

    let settled = false;
    const finish = (e: TurnEnd) => {
      if (settled) return; // 定性要等叫停闸门,期间可能被 stop() 抢先兑现
      settled = true;
      for (const c of cleanup) c();
      settle(e);
    };

    // 叫停波及本次等待时由 stopScan 填入;没被波及就一直是空 —— 后起的 turn 照自己的终局收尾
    let gate: Promise<void> | null = null;
    let stoppedMe = false;
    const classify = async (e: TurnEnd) => {
      if (gate) await gate; // 打断在途:由它的成败定性,别把打断引发的失败当成 turn 自己挂了
      finish(stoppedMe ? { kind: 'stopped' } : e);
    };
    const target: StopTarget = {
      begin: (g) => {
        gate = g;
      },
      stop: () => {
        stoppedMe = true;
        finish({ kind: 'stopped' });
      },
    };
    this.stopTargets.add(target);
    cleanup.push(() => this.stopTargets.delete(target));

    // 会话被释放时由 dispose 兑现:此后 codex 不会再发终局,干等就是一条永远「回复中」的线程
    const abort = () => finish({ kind: 'disposed' });
    this.liveWaiters.add(abort);
    cleanup.push(() => this.liveWaiters.delete(abort));

    let mine: string | undefined;
    let identified = false;
    /** 认领前无从判断归属的事件,先按 turnId 分组扣住(无 id 的归到 undefined 这组) */
    const heldEnds: TerminalEvent[] = [];
    const heldDeltas = new Map<string | undefined, string>();
    let reply = '';

    /**
     * 归属判定:**两边都拿得出 id** 才谈得上排除 —— 有一边不知道就只能认下,
     * 退回加此过滤之前的行为。turnId 是 agent 可选给的,一律按「不是我的」丢掉的话,
     * 遇上不带 id 的 agent 就等于每条回复都被吞光。
     */
    const isMine = (turnId: string | undefined): boolean => !turnId || !mine || turnId === mine;
    const takeEnd = (e: TerminalEvent) => {
      if (!identified) {
        heldEnds.push(e);
        return;
      }
      if (isMine(e.turnId)) void classify(e);
    };

    cleanup.push(
      this.agent.streamEvents((e) => {
        if (e.kind === 'message-delta') {
          if (!identified) heldDeltas.set(e.turnId, (heldDeltas.get(e.turnId) ?? '') + e.text);
          else if (isMine(e.turnId)) reply += e.text;
          return;
        }
        if (e.kind === 'turn-completed' || e.kind === 'turn-failed') takeEnd(e);
      }),
    );

    return {
      end,
      reply: () => reply,
      identify: (turnId) => {
        if (identified) return;
        identified = true;
        mine = turnId || undefined; // agent 没给 id 就退回「来什么认什么」
        for (const [from, text] of heldDeltas) if (isMine(from)) reply += text;
        heldDeltas.clear();
        const ends = heldEnds.splice(0);
        for (const e of ends) if (isMine(e.turnId)) void classify(e);
      },
      cancel: () => finish({ kind: 'stopped' }),
    };
  }
}
