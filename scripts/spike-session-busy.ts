/**
 * 确定性验证「会话什么时候算忙」(不走 codex/不烧 token)。并发上限满了要逐出最久未用的
 * **空闲**会话,判空闲只看 turn 是不够的 —— 会话已经入表、codex thread 与 MCP 还在建的那段
 * 一个 turn 都没起,却同样拆不得:拆掉就把这次审核/续接打断在起跑线上。
 *
 * 用一个卡在 startConversation / resumeConversation 上的 stub agent 把那段窗口撑开来断言。
 *   运行:npm run spike:session-busy
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { Review } from '../src/shared/domain';
import type { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
} from '../src/backend/agent/conversational-agent';

const log = (m: string) => process.stdout.write(`[session-busy] ${m}\n`);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 一道可以按住再放开的闸,用来把某个异步阶段停在半路上。 */
class Gate {
  private release!: () => void;
  readonly passed: Promise<void>;
  constructor() {
    this.passed = new Promise<void>((r) => {
      this.release = r;
    });
  }
  open(): void {
    this.release();
  }
}

/** 建/续会话卡在闸上;turn 只发号,收尾由用例掌控。 */
class GatedAgent extends EventEmitter implements ConversationalAgent {
  turn = 0;
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
  async sendMessage(): Promise<string> {
    return `t${++this.turn}`;
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
 * 为一个纯生命周期计数的用例去切 ABI,会连带弄坏正开着的 app(见 CLAUDE.md「ABI 二选一」)。
 */
function fakeStore(review: Review) {
  const statuses: string[] = [];
  const store = {
    getReview: () => review,
    setCodexThreadId: (_id: string, threadId: string) => {
      review.codexThreadId = threadId;
    },
    setRoundThreadId: () => undefined,
    setReviewStatus: (_id: string, status: string) => {
      statuses.push(status);
    },
    listFindings: () => [],
  };
  return { store: store as unknown as ReviewStore, statuses };
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
    title: 'session-busy spike',
    status: 'scanning',
    summaryBody: null,
    summaryFiles: [],
    summaryRound: null,
    currentRound: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  const { store } = fakeStore(review);
  const gate = new Gate();
  const agent = new GatedAgent(gate);
  const session = new ReviewSession(review.id, store, agent);
  const providers = { getDiff: () => '', getFile: async () => '' };
  return { store, review, gate, agent, session, providers };
}

/** 1. 首轮:从 start 入口到 turn 收尾全程算忙,建 thread 那段也不例外。 */
async function busyWhileStarting(): Promise<() => Promise<void>> {
  const f = fixture();
  assert.equal(f.session.isBusy(), false, '没开跑的会话是空闲的');

  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  assert.equal(f.session.isBusy(), true, 'start 一进来就算忙,不等 turn 起来');

  await tick();
  assert.equal(f.agent.turn, 0, '闸没开,turn 还一个都没起');
  assert.equal(f.session.isBusy(), true, 'MCP/codex thread 还在建 —— 这段被逐出就是凭空打断');

  f.gate.open();
  await tick();
  assert.equal(f.agent.turn, 1, '闸开了,扫描 turn 起来了');
  assert.equal(f.session.isBusy(), true, 'turn 在跑当然是忙');

  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;
  assert.equal(f.session.isBusy(), false, '整轮跑完才算空闲');
  log('✓ start:入口 → 建 thread → turn → 收尾,全程算忙');
  return () => f.session.dispose();
}

/** 2. 续接(app 重启后)同理:恢复 thread 的那段一个 turn 都没有,照样拆不得。 */
async function busyWhileResuming(): Promise<() => Promise<void>> {
  const f = fixture();
  f.review.codexThreadId = 'stub-thread';

  const resumed = f.session.resume({ cwd: process.cwd(), providers: f.providers });
  assert.equal(f.session.isBusy(), true, 'resume 一进来就算忙');
  await tick();
  assert.equal(f.session.isBusy(), true, 'thread 还在恢复,此刻逐出会让续接莫名失败');

  f.gate.open();
  await resumed;
  assert.equal(f.session.isBusy(), false, '恢复完没有在途 turn,回到空闲');
  log('✓ resume:恢复 thread 期间算忙,恢复完回到空闲');
  return () => f.session.dispose();
}

/** 3. 建会话失败也要把忙碌状态还回来,否则这个位子就永远占着了。 */
async function releasedOnStartFailure(): Promise<() => Promise<void>> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();
  f.gate.open();
  await tick();
  f.agent.emitEvent({ kind: 'turn-failed', turnId: 't1', error: 'boom', errorKind: 'other' });
  await assert.rejects(() => scan, /boom/, '首轮失败照常抛给上层');
  assert.equal(f.session.isBusy(), false, '失败收尾后不能一直挂着「忙」');
  log('✓ 首轮失败后忙碌状态归零,位子可被回收');
  return () => f.session.dispose();
}

async function main(): Promise<void> {
  const cases = [busyWhileStarting, busyWhileResuming, releasedOnStartFailure];
  const cleanups: (() => Promise<void>)[] = [];
  try {
    for (const run of cases) cleanups.push(await run());
    log('全部通过');
  } finally {
    for (const c of cleanups) await c().catch(() => undefined);
  }
}

main().catch((e) => {
  process.stderr.write(`[session-busy] 失败: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
