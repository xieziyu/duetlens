/**
 * 确定性验证「讨论里的流式回复」(不走 codex / 不烧 token):stub agent 按脚本重放
 * codex 的 delta 与终局次序,断言外发事件的**归属、顺序与收尾**。
 *
 * 1. 一条追问的完整回执:reply-started → reply-delta* → message → reply-ended(ok),
 *    且 delta 拼起来等于落库正文 —— 顺序错了(残余 delta 排在定稿之后)屏上会多出半句话。
 * 2. **机审轮的 delta 不外发**:它没有讨论归属,渲染出来就是把扫描的收尾话喷进讨论气泡。
 *    同理 `message-delta` 不许出现在 agent-event 这条 firehose 上。
 * 3. **别的 turn 的残余 delta 不许混进这一问**:被叫停那轮常会补发,认领窗口里到达的
 *    也不行(与 spike:stop-scan 第 4 例同一条时序,这里断的是外发面)。
 * 4. 叫停这一问:只停它 —— 不置 session 级 stopped 旗子(那面旗子会连带掐掉自检轮),
 *    reply-ended 记 stopped,问题本身留在线程里,半句回复不落库。
 * 5. 「停止机审」不许殃及正在跑的追问;「停止这一问」也不许去打断扫描。
 * 6. **起跑要报在出队那一刻,不等 turn/start 应答**:那一个来回里到达的工具事件
 *    否则找不到归属,会被 renderer 记进机审动作流(顶高「改动文件已读 N/M」),
 *    而这一问的取证行反倒空着。
 *
 *   运行:npm run spike:reply-stream
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession, type ReviewSessionEvents } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
} from '../src/backend/agent/conversational-agent';

const log = (m: string) => process.stdout.write(`[reply-stream] ${m}\n`);

class StubAgent extends EventEmitter implements ConversationalAgent {
  turn = 0;
  readonly interrupts: string[] = [];
  /** 打断请求到达时重放的事件(模拟「打断把 turn 打挂了」) */
  onInterrupt: ((agent: StubAgent) => void) | null = null;
  async startConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  /** turn/start 应答返回之前做什么 —— 复现「事件早于应答」那段窗口 */
  beforeTurnId: ((agent: StubAgent, turnId: string) => void) | null = null;
  async sendMessage(): Promise<string> {
    const turnId = `t${++this.turn}`;
    this.beforeTurnId?.(this, turnId);
    return turnId;
  }
  emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }
  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
  async interrupt(_conversationId: string, turnId: string): Promise<void> {
    this.interrupts.push(turnId);
    this.onInterrupt?.(this);
  }
  approve(): void {}
  dispose(): void {}
}

/** 外发事件的流水账;断言看的是**次序**,所以记成一条时间线而不是几个计数器。 */
type Trace = { type: string; payload: unknown }[];

function fixture() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'stub',
    repoPath: null,
    title: 'reply-stream spike',
    model: null,
    reasoningEffort: null,
    intensity: 'standard',
  });
  store.startRound(review.id, 1, {});
  const agent = new StubAgent();
  const session = new ReviewSession(review.id, store, agent);
  const trace: Trace = [];
  const watch = <K extends keyof ReviewSessionEvents>(name: K) =>
    session.on(name, (payload) => trace.push({ type: name, payload }));
  watch('reply-started');
  watch('reply-delta');
  watch('reply-ended');
  watch('message');
  watch('agent-event');
  const providers = { getDiff: () => '', getFile: async () => '' };
  return { store, review, agent, session, trace, providers };
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));
/** delta 外发是合流的(见 ReviewSession 的 STREAM_FLUSH_MS),断言前要等它吐出来。 */
const flushed = () => tick(90);
const kinds = (trace: Trace) => trace.map((t) => t.type);
const deltas = (trace: Trace) =>
  trace
    .filter((t) => t.type === 'reply-delta')
    .map((t) => (t.payload as { text: string }).text)
    .join('');

/** 跑到「首轮扫描已收尾」,后面几例都从这里起步。 */
async function scanned(f: ReturnType<typeof fixture>) {
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();
  f.agent.emitEvent({ kind: 'message-delta', text: '审核完成,已上报 0 条。', turnId: 't1' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;
}

/** 1 + 2:完整回执的顺序,以及机审轮的 delta 一个字都不外发。 */
async function fullRoundTrip(): Promise<() => Promise<void>> {
  const f = fixture();
  await scanned(f);
  assert.equal(
    deltas(f.trace).length,
    0,
    '扫描轮的回复文本没有讨论归属,不该以 reply-delta 外发',
  );
  assert.equal(
    f.trace.filter(
      (t) => t.type === 'agent-event' && (t.payload as AgentEvent).kind === 'message-delta',
    ).length,
    0,
    'message-delta 不该出现在 agent-event 这条 firehose 上',
  );

  const d = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  f.trace.length = 0;
  const followup = f.session.sendMessage(d.id, '这里为什么这么写?');
  await tick();
  for (const seg of ['因为', '要复用']) {
    f.agent.emitEvent({ kind: 'message-delta', text: seg, turnId: 't2' });
    await flushed();
  }
  // 末段**不等合流窗口**就收尾:残余 delta 与定稿的先后正是这一例要钉住的东西
  f.agent.emitEvent({ kind: 'message-delta', text: '同一条流。', turnId: 't2' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  const msg = await followup;

  assert.equal(msg.text, '因为要复用同一条流。');
  assert.equal(deltas(f.trace), msg.text, 'delta 拼起来必须等于落库正文');
  const order = kinds(f.trace).filter((k) => k !== 'agent-event');
  assert.equal(order[0], 'message', '第一条是 reviewer 那句问题');
  assert.equal(order[1], 'reply-started', '起跑要报在任何正文之前');
  assert.equal(order[order.length - 1], 'reply-ended', '收尾排在最后');
  assert.equal(
    order[order.length - 2],
    'message',
    '定稿的回复要排在残余 delta 之后 —— 反了的话屏上会在定稿旁边多出半句在途文本',
  );
  assert.equal(
    (f.trace[f.trace.length - 1].payload as { outcome: string }).outcome,
    'ok',
    '正常收尾记 ok',
  );
  log('✓ 完整回执:起跑 → 逐段出字 → 定稿 → 收尾;机审轮的 delta 不外发');
  return () => f.session.dispose();
}

/** 3:别的 turn 的残余 delta 不许混进这一问(认领窗口里到达的也不行)。 */
async function foreignDeltasStayOut(): Promise<() => Promise<void>> {
  const f = fixture();
  await scanned(f);
  const d = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  f.trace.length = 0;
  const followup = f.session.sendMessage(d.id, '这里为什么这么写?');
  await tick();
  // 被叫停/已收尾那轮的补发
  f.agent.emitEvent({ kind: 'message-delta', text: '【扫描残留】', turnId: 't1' });
  f.agent.emitEvent({ kind: 'message-delta', text: '只有一个写者。', turnId: 't2' });
  await flushed();
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  const msg = await followup;

  assert.equal(msg.text, '只有一个写者。');
  assert.equal(deltas(f.trace), '只有一个写者。', '别的 turn 的残余不许混进这一问的流');
  log('✓ 别的 turn 的残余 delta 不进这一问');
  return () => f.session.dispose();
}

/** 4:叫停这一问 —— 只停它,残文不落库,session 级 stopped 旗子不动。 */
async function stopOneReply(): Promise<() => Promise<void>> {
  const f = fixture();
  await scanned(f);
  const d = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  f.trace.length = 0;
  f.agent.onInterrupt = (agent) =>
    agent.emitEvent({ kind: 'turn-failed', turnId: 't2', error: 'aborted', errorKind: 'other' });
  const followup = f.session.sendMessage(d.id, '这里为什么这么写?');
  await tick();
  f.agent.emitEvent({ kind: 'message-delta', text: '这是半句', turnId: 't2' });
  await flushed();

  await f.session.stopReply(d.id);
  const msg = await followup;

  assert.deepEqual(f.agent.interrupts, ['t2'], '打断要点名到这一问的 turn');
  assert.equal(msg.role, 'user', '被停的那一问只回显问题本身,不产出 agent 消息');
  assert.equal(
    f.store.listMessages(d.id).filter((m) => m.role === 'agent').length,
    0,
    '中断的半句不落库 —— 落了会被下一轮追问的历史回顾原样重述',
  );
  const ended = f.trace.filter((t) => t.type === 'reply-ended');
  assert.equal(ended.length, 1, 'reply-ended 只发一次(失败路径会走两遍定性)');
  assert.equal((ended[0].payload as { outcome: string }).outcome, 'stopped');
  assert.equal(deltas(f.trace), '这是半句', '已出的半句照样外发过,屏上才留得住');
  assert.equal(
    f.session.isStopped(),
    false,
    '停一句追问不该置机审的 stopped 旗子 —— 那面旗子会连带掐掉排在后面的自检轮',
  );
  log('✓ 叫停这一问:只停它、残文不落库、机审旗子不动');
  return () => f.session.dispose();
}

/** 5:两个叫停各管各的 —— 停机审不碰追问,停追问不碰扫描。 */
async function stopsDoNotCross(): Promise<() => Promise<void>> {
  const f = fixture();
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await tick();
  const d = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  // 扫描还在跑,这一问排在队里:没有可打断的 turn
  const followup = f.session.sendMessage(d.id, '这里为什么这么写?');
  await tick();
  await assert.rejects(
    () => f.session.stopReply(d.id),
    /没有在跑的轮次/,
    '还排在队里的一问没有 turn 可打断,要如实说停不下来',
  );
  assert.deepEqual(f.agent.interrupts, [], '不许因此去打断正在跑的扫描');

  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' }); // 扫描自然收尾
  await scan;
  await tick(); // 追问起跑并认领 t2

  await f.session.stopScan();
  assert.deepEqual(f.agent.interrupts, [], '扫描已收尾,「停止机审」不该去打断用户的追问');

  f.agent.emitEvent({ kind: 'message-delta', text: '因为只有一个写者。', turnId: 't2' });
  await flushed();
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  const msg = await followup;
  assert.equal(msg.role, 'agent', '追问没被殃及');
  assert.equal(msg.text, '因为只有一个写者。');
  log('✓ 停机审与停这一问各管各的');
  return () => f.session.dispose();
}

/** 6:turn/start 应答之前到达的工具事件,也必须落在「已起跑」之后。 */
async function startedBeatsEarlyTools(): Promise<() => Promise<void>> {
  const f = fixture();
  await scanned(f);
  const d = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  f.trace.length = 0;
  // 应答还压在路上,agent 已经开读了 —— 归属窗口晚开一步,这条就没人认领
  f.agent.beforeTurnId = (agent) =>
    agent.emitEvent({
      kind: 'command',
      command: 'cat a.ts',
      status: 'inProgress',
      actions: [{ type: 'read', path: 'a.ts' }],
    });
  const followup = f.session.sendMessage(d.id, '这里为什么这么写?');
  await tick();
  f.agent.emitEvent({ kind: 'message-delta', text: '因为只有一个写者。', turnId: 't2' });
  await flushed();
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  await followup;

  const order = kinds(f.trace);
  const started = order.indexOf('reply-started');
  const firstTool = f.trace.findIndex(
    (t) => t.type === 'agent-event' && (t.payload as AgentEvent).kind === 'command',
  );
  assert.notEqual(started, -1, '要报起跑');
  assert.notEqual(firstTool, -1, '这一例的前提是工具事件确实来了');
  assert.ok(
    started < firstTool,
    '起跑必须排在这一问的第一条工具事件之前 —— 晚一步,那条动作就会被算进机审的取证覆盖',
  );
  log('✓ 应答之前到达的工具事件仍落在「已起跑」之后');
  return () => f.session.dispose();
}

async function main(): Promise<void> {
  const cases = [
    fullRoundTrip,
    foreignDeltasStayOut,
    stopOneReply,
    stopsDoNotCross,
    startedBeatsEarlyTools,
  ];
  for (const t of cases) {
    const dispose = await t();
    await dispose(); // MCP server 不关,event loop 就一直醒着,进程退不了
  }
  log('全部通过');
}

main().catch((e) => {
  process.stderr.write(`[reply-stream] 失败: ${(e as Error).stack}\n`);
  process.exit(1);
});
