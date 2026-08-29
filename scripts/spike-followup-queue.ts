/**
 * 确定性验证「会话还没建起来时的追问」(不走 codex/不烧 token)。Discussion 栏空态明说
 * 「不必等它 —— 直接在下方提问」,而 codex thread 要到 startConversation 应答才到手:
 * 这中间按下发送,追问必须**排队等会话**,不能就地回绝 —— 回绝的话输入框已清空、消息还没落库,
 * 用户那一问就凭空没了,界面上只剩一条空讨论。
 *
 * 会话建不起来 / 被释放时则要以原因兑现,不能让追问永远干等。
 *   运行:npm run spike:followup-queue
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { Discussion, Message, Review } from '../src/shared/domain';
import { FOLLOWUP_REPLY_FAILED_CODE } from '../src/shared/ipc';
import type { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
} from '../src/backend/agent/conversational-agent';

const log = (m: string) => process.stdout.write(`[followup-queue] ${m}\n`);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 一道可以按住再放开的闸,用来把建会话停在半路上。 */
class Gate {
  private release!: () => void;
  private fail!: (e: unknown) => void;
  readonly passed: Promise<void>;
  constructor() {
    this.passed = new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
  }
  open(): void {
    this.release();
  }
  break(e: unknown): void {
    this.fail(e);
  }
}

/** 建会话卡在闸上;turn 只发号并记下文本,收尾由用例掌控。 */
class GatedAgent extends EventEmitter implements ConversationalAgent {
  readonly turns: string[] = [];
  constructor(private readonly gate: Gate) {
    super();
  }
  async startConversation(): Promise<ConversationHandle> {
    await this.gate.passed;
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(): Promise<ConversationHandle> {
    await this.gate.passed;
    return { conversationId: 'stub-thread' };
  }
  async sendMessage(_id: string, text: string): Promise<string> {
    this.turns.push(text);
    return `t${this.turns.length}`;
  }
  emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }
  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
  async interrupt(): Promise<void> {}
  approve(): void {}
  dispose(): void {}
}

/**
 * 只兜住本 spike 会走到的那几个 store 调用。刻意不开真库:better-sqlite3 是原生模块,
 * 为一个纯排队用例去切 ABI,会连带弄坏正开着的 app(见 CLAUDE.md「ABI 二选一」)。
 */
function fakeStore(review: Review, discussion: Discussion) {
  const messages: Message[] = [];
  const store = {
    getReview: () => review,
    getDiscussion: (id: string) => (id === discussion.id ? discussion : undefined),
    listMessages: () => messages.slice(),
    addMessage: (discussionId: string, role: Message['role'], text: string) => {
      const m: Message = { id: `m${messages.length + 1}`, discussionId, role, text, createdAt: 0 };
      messages.push(m);
      return m;
    },
    setCodexThreadId: (_id: string, threadId: string) => {
      review.codexThreadId = threadId;
    },
    setRoundThreadId: () => undefined,
    setReviewStatus: () => undefined,
    listFindings: () => [],
  };
  return { store: store as unknown as ReviewStore, messages };
}

function fixture() {
  const review: Review = {
    id: 'r1',
    source: 'local-branch',
    sourceRef: 'stub',
    baseRef: null,
    headRef: null,
    repoPath: null,
    codexThreadId: null,
    model: null,
    reasoningEffort: null,
    intensity: 'standard',
    title: 'followup-queue spike',
    status: 'scanning',
    summaryBody: null,
    summaryFiles: [],
    summaryRound: null,
    currentRound: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  const discussion: Discussion = {
    id: 'd1',
    reviewId: review.id,
    kind: 'user',
    origin: 'manual',
    file: null,
    line: null,
    lineEnd: null,
    createdAt: 0,
  };
  const { store, messages } = fakeStore(review, discussion);
  const gate = new Gate();
  const agent = new GatedAgent(gate);
  const session = new ReviewSession(review.id, store, agent);
  const providers = { getDiff: () => '', getFile: async () => '' };
  return { review, discussion, store, messages, gate, agent, session, providers };
}

/** 1. 建会话途中的追问:排在会话之后跑,一个字都不丢。 */
async function queuesUntilConversationOpens(): Promise<() => Promise<void>> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();

  const sent = f.session.sendMessage(f.discussion.id, '这次改动整体思路是什么?');
  await tick();
  assert.equal(f.messages.length, 0, '会话没建起来之前不该落库(也不该报错回绝)');
  assert.equal(f.agent.turns.length, 0, '闸没开,一个 turn 都还没起');

  f.gate.open();
  await tick();
  // 顺序颠倒会让 agent 还没读改动就先答问题:闸一开只该起扫描那一轮
  assert.equal(f.agent.turns.length, 1, '闸开了只起扫描 turn,追问还压在队里');
  assert.equal(f.agent.turns[0].includes('这次改动整体思路是什么?'), false, '第一轮是扫描不是追问');

  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;
  await tick();
  assert.equal(f.agent.turns.length, 2, '扫描收尾后排队的追问才跑');
  assert.equal(f.agent.turns[1].includes('这次改动整体思路是什么?'), true, '跑的正是那一问,原文没丢');

  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  await sent;
  assert.deepEqual(
    f.messages.map((m) => m.role),
    ['user'],
    '用户那一问已落库(stub 不产出回复文本,故只有 user 一条)',
  );
  log('✓ 会话建立前的追问排队等会话,不被丢弃');
  return () => f.session.dispose();
}

/** 2. 会话根本没建起来:排队的追问要以同一个原因兑现,不能永远干等。 */
async function rejectsWhenConversationFails(): Promise<() => Promise<void>> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();
  const sent = f.session.sendMessage(f.discussion.id, '排在建会话后面的一问');
  await tick();

  f.gate.break(new Error('codex 起不来'));
  await assert.rejects(() => scan, /codex 起不来/, '建会话失败照常抛给上层');
  await assert.rejects(() => sent, /codex 起不来/, '排队的追问必须跟着失败,而不是挂着');
  assert.equal(f.messages.length, 0, '没跑成的追问不该在库里留下半条消息');
  log('✓ 建会话失败时排队的追问就地兑现,不干等');
  return () => f.session.dispose();
}

/**
 * 3. 问题落库之后才失败(agent 没能回复):错误要带上识别串。
 * renderer 靠它分辨「没发出去(该重发)」与「发出去了、只是没等到回复」—— 认错了就会把
 * 已经躺在线程里的那句话再劝用户发一遍。
 */
async function marksReplyFailureAfterStoring(): Promise<() => Promise<void>> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  f.gate.open();
  await tick();
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;

  const sent = f.session.sendMessage(f.discussion.id, '这里为什么不用现成的 helper?');
  await tick();
  assert.equal(f.messages.length, 1, '问题先落库再等回复 —— 这条已经推给 UI 了');

  f.agent.emitEvent({ kind: 'turn-failed', turnId: 't2', error: '上游过载', errorKind: 'server-overloaded' });
  await assert.rejects(
    () => sent,
    (e: Error) => e.message.includes(FOLLOWUP_REPLY_FAILED_CODE) && e.message.includes('上游过载'),
    '回复失败要带识别串与原因,别退化成一句「没发出去」',
  );
  assert.equal(f.messages.length, 1, '回复没拿到,但用户那句话该留在库里');
  log('✓ 问题已落库后的失败带识别串,不会被当成「没发出去」');
  return () => f.session.dispose();
}

/** 4. 会话被释放(并发上限逐出 / 重跑前 teardown):同理要兑现,否则那一问永远悬着。 */
async function rejectsWhenDisposed(): Promise<void> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();
  const sent = f.session.sendMessage(f.discussion.id, '会话被拆掉时在排队的一问');
  await tick();

  await f.session.dispose();
  await assert.rejects(() => sent, /会话已释放/, '会话没了,排队的追问不能一直等');
  // 真实世界里 dispose 会连 codex 进程一起收掉,建会话那步随之失败;收掉它免得留下悬着的 promise
  f.gate.break(new Error('会话已拆'));
  await scan.catch(() => undefined);
  log('✓ 会话释放后排队的追问就地兑现');
}

async function main(): Promise<void> {
  const cleanups: (() => Promise<void>)[] = [];
  try {
    cleanups.push(await queuesUntilConversationOpens());
    cleanups.push(await rejectsWhenConversationFails());
    cleanups.push(await marksReplyFailureAfterStoring());
    await rejectsWhenDisposed();
    log('全部通过');
  } finally {
    for (const c of cleanups) await c().catch(() => undefined);
  }
}

main().catch((e) => {
  process.stderr.write(`[followup-queue] 失败: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
