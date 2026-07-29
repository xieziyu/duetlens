/**
 * 确定性验证「中途叫停机审」的三条边界(不走 codex/不烧 token):
 * stub agent 按脚本重放 codex 那几种消息次序,断言轮次收成什么、追问会不会被殃及。
 *
 * 1. 打断在途时 turn 以 **failed** 收尾(codex 打断常就长这样)—— 应记「已停止」而非「失败」。
 * 2. 打断请求失败 —— 不许把还在跑的一轮记成已停止,原终局照样作数。
 * 3. 叫停之后的追问要能正常拿到 agent 回复 —— 叫停只作用于当时那个 turn,不是往后一直有效。
 * 4. 被叫停那轮**补发**的终局与残余 delta —— 哪怕赶在下一轮 turn/start 应答之前到达,
 *    也不许被追问的等待认领、不许混进追问的回复。
 * 5. delta 不带 turnId(该字段是可选的)—— 归属判不了就得照收,不能把回复吞光。
 * 6. turn/start 应答还没回来(拿不到 turnId)时按停止 —— 打断点名不到 turn,
 *    不许谎称已停止(codex 那边还在跑),要如实抛回。
 * 7. agent 压根不给 turnId —— 与 6 长得一样但等下去也不会有,结论必须不同,
 *    否则用户被卡在一个永远不成立的「稍等再停」里。
 *   运行:npm run spike:stop-scan
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
} from '../src/backend/agent/conversational-agent';

const log = (m: string) => process.stdout.write(`[stop-scan] ${m}\n`);

/** 每个用例自己决定:打断时做什么、turn 何时以什么方式收尾。 */
interface Script {
  /** 收到打断请求时;抛错即模拟打断失败 */
  onInterrupt: (agent: StubAgent) => Promise<void>;
  /** turn/start 应答返回 turnId 之前做什么 —— 复现「事件早于应答」那段窗口 */
  beforeTurnId?: (agent: StubAgent, turnId: string) => void;
  /** turn/start 应答挂在这里不返回 —— 复现「turn 已发出、id 还没到手」那段窗口 */
  holdTurnId?: () => Promise<void>;
  /** sendMessage 返回空串 —— 接口允许的「这个 agent 不给 turnId」 */
  emptyTurnId?: boolean;
}

class StubAgent extends EventEmitter implements ConversationalAgent {
  turn = 0;
  /** 收到的每次打断:打断点名到哪个 turn 是协议必填项,得断言而不能只看它被调过 */
  readonly interrupts: { conversationId: string; turnId: string }[] = [];
  constructor(private readonly script: Script) {
    super();
  }
  async startConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  /** 只起 turn,不自己收尾 —— 收尾时机由用例掌控 */
  async sendMessage(): Promise<string> {
    const turnId = `t${++this.turn}`;
    this.script.beforeTurnId?.(this, turnId);
    await this.script.holdTurnId?.();
    return this.script.emptyTurnId ? '' : turnId;
  }
  emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }
  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
  interrupt(conversationId: string, turnId: string): Promise<void> {
    this.interrupts.push({ conversationId, turnId });
    return this.script.onInterrupt(this);
  }
  approve(): void {}
  dispose(): void {}
}

const FAILED = (turnId: string): AgentEvent => ({
  kind: 'turn-failed',
  turnId,
  error: 'turn aborted',
  errorKind: 'other',
});

function fixture(script: Script) {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'stub',
    repoPath: null,
    title: 'stop-scan spike',
    model: null,
    reasoningEffort: null,
    intensity: 'standard',
  });
  store.startRound(review.id, 1, {});
  const agent = new StubAgent(script);
  const session = new ReviewSession(review.id, store, agent);
  const providers = { getDiff: () => '', getFile: async () => '' };
  return { store, review, agent, session, providers };
}

/** 1. 打断在途时 turn 以 failed 收尾 —— 定性必须是「已停止」,不是「失败」。 */
async function failedDuringInterrupt(): Promise<() => Promise<void>> {
  const f = fixture({
    // 打断的应答尚未返回,turn 先以 failed 收尾:典型的「打断把 turn 打挂了」
    onInterrupt: async (agent) => {
      agent.emitEvent(FAILED('t1'));
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await f.session.stopScan();
  await scan; // 不该抛:用户按的是「停止」,不是这一轮挂了
  assert.equal(f.session.isStopped(), true, '打断成功即算已停止');
  assert.deepEqual(
    f.agent.interrupts,
    [{ conversationId: 'stub-thread', turnId: 't1' }],
    '打断要点名到正在跑的那个 turn(turnId 是 codex 的必填项)',
  );
  assert.notEqual(f.store.getReview(f.review.id)?.status, 'failed', 'review 不该落到失败态');
  log('✓ 打断在途收到 turn-failed → 记为已停止,start 正常 resolve');
  return () => f.session.dispose();
}

/** 2. 打断请求本身失败 —— 不许把还在跑的一轮记成已停止。 */
async function interruptRejects(): Promise<() => Promise<void>> {
  const f = fixture({
    onInterrupt: async () => {
      throw new Error('turn/interrupt failed');
    },
  });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(() => f.session.stopScan(), /interrupt failed/, '打断失败要如实抛给上层');
  assert.equal(f.session.isStopped(), false, '打断没成功就不算停住了');

  // 这一轮此后自己挂掉:仍该按失败收尾,不能被那次没成功的叫停改写
  f.agent.emitEvent(FAILED('t1'));
  await assert.rejects(() => scan, /失败/, '原终局照常作数');
  log('✓ 打断请求失败 → 不记已停止,原终局照常作数');
  return () => f.session.dispose();
}

/** 3. 叫停只作用于当时那个 turn:之后的追问必须照常拿到 agent 回复。 */
async function followupStillAnswered(): Promise<() => Promise<void>> {
  const f = fixture({ onInterrupt: async () => undefined });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await f.session.stopScan();
  await scan;

  const discussion = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  const followup = f.session.sendMessage(discussion.id, '这里为什么这么写?');
  await new Promise((r) => setTimeout(r, 10));
  f.agent.emitEvent({ kind: 'message-delta', text: '因为要复用同一条流。', turnId: 't2' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });

  const msg = await followup;
  assert.equal(msg.role, 'agent', '停完扫描仍要能拿到 agent 回复,不能只回显用户消息');
  assert.equal(msg.text, '因为要复用同一条流。');
  log('✓ 叫停后追问照常拿到 agent 回复');
  return () => f.session.dispose();
}

/** 4. 被叫停那轮补发的终局与残余 delta,赶在下一轮 turn/start 应答之前到达也不许串台。 */
async function lateEventsDoNotLeak(): Promise<() => Promise<void>> {
  const stale = { fire: false };
  const f = fixture({
    onInterrupt: async () => undefined,
    // 追问的 turn/start 还没应答(t2 尚未认领)时,扫描那轮 t1 补发终局与残余文本
    beforeTurnId: (agent, turnId) => {
      if (!stale.fire || turnId !== 't2') return;
      agent.emitEvent({ kind: 'message-delta', text: '【扫描残留】', turnId: 't1' });
      agent.emitEvent(FAILED('t1'));
    },
  });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await f.session.stopScan();
  await scan;

  stale.fire = true;
  const discussion = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  let settled = false;
  const followup = f.session.sendMessage(discussion.id, '这段为什么不加锁?').then((m) => {
    settled = true;
    return m;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, '认领窗口里到达的 t1 终局不该结束追问的 t2');

  f.agent.emitEvent({ kind: 'message-delta', text: '因为只有一个写者。', turnId: 't2' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  const msg = await followup;
  assert.equal(msg.role, 'agent');
  assert.equal(msg.text, '因为只有一个写者。', '扫描那轮的残余文本不许混进追问回复');
  log('✓ 认领窗口里的迟到终局与残余 delta 都不串台');
  return () => f.session.dispose();
}

/**
 * 5. delta 不带 turnId(turn/start 给了 id、但 delta 通知没有)—— 归属无从判定,
 * 只能照收;一律当成「别人的」丢掉,遇上这种 agent 就是每条回复都被吞光。
 */
async function deltaWithoutTurnIdStillCounts(): Promise<() => Promise<void>> {
  const f = fixture({
    onInterrupt: async () => undefined,
    // 认领窗口里也来一段无 id 的 delta:扣住之后同样要认下
    beforeTurnId: (agent, turnId) => {
      if (turnId === 't2') agent.emitEvent({ kind: 'message-delta', text: '因为' });
    },
  });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;

  const discussion = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  const followup = f.session.sendMessage(discussion.id, '为什么?');
  await new Promise((r) => setTimeout(r, 10));
  f.agent.emitEvent({ kind: 'message-delta', text: '只有一个写者。' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });

  const msg = await followup;
  assert.equal(msg.role, 'agent', '无 turnId 的 delta 也要算数,否则回复全丢');
  assert.equal(msg.text, '因为只有一个写者。', '认领前后的无 id delta 都要收下且保序');
  log('✓ delta 不带 turnId 时照收不误');
  return () => f.session.dispose();
}

/**
 * 6. turn/start 应答还没回来 —— 打断点名不到 turn(codex 侧 turnId 必填),
 * 谎称已停止的话 codex 会继续跑到底、继续烧 token,故如实抛回让用户重按。
 */
async function stopBeforeTurnIdArrives(): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const f = fixture({ onInterrupt: async () => undefined, holdTurnId: () => held });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  // 结论要与用例 7 的「停不下来」互斥 —— 只断言笼统的「turn id」的话,
  // 两种成因给同一句话也能过,而它们对用户的下一步正好相反(重按 vs 别按了)
  await assert.rejects(
    () => f.session.stopScan(),
    (e: Error) => /稍等/.test(e.message) && !/停不下来/.test(e.message),
    '应答在途要说「稍等再停」,点名不到 turn 就不算停住了',
  );
  assert.equal(f.session.isStopped(), false, '没停成不许记已停止');
  assert.equal(f.agent.interrupts.length, 0, '没有可打断的对象就不该发打断请求');

  // 应答回来后这一轮照常跑完:那次没成功的叫停不许改写它的终局
  release();
  await new Promise((r) => setTimeout(r, 10));
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;
  log('✓ turnId 未到手时按停止 → 如实抛回,轮次照常跑完');
  return () => f.session.dispose();
}

/**
 * 7. agent 压根不给 turnId(sendMessage 返回空串,接口允许)—— 与「应答未回」不是一回事:
 * 等下去也不会有,提示「稍等再停」就是把用户卡在一个永远不成立的重试里。
 */
async function stopWhenAgentGivesNoTurnId(): Promise<() => Promise<void>> {
  const f = fixture({ onInterrupt: async () => undefined, emptyTurnId: true });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    () => f.session.stopScan(),
    (e: Error) => /停不下来/.test(e.message) && !/稍等/.test(e.message),
    '没有 id 可打断要如实说,不能伪装成「等一下就好」',
  );
  assert.equal(f.session.isStopped(), false, '没停成不许记已停止');
  assert.equal(f.agent.interrupts.length, 0, '没有 id 就不该发打断请求');

  // 这一轮照常跑完:停不下来不等于这一轮就此作废
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' });
  await scan;
  log('✓ agent 不给 turnId 时按停止 → 说清停不下来,不提示「稍等再试」');
  return () => f.session.dispose();
}

/**
 * 8. 追问排在扫描后面:扫描自然收尾、队里的追问接着开跑,此时按停止 ——
 * 叫停的对象是**本轮机审**,不能顺手把用户的追问打断、更不能把整轮记成已停止。
 */
async function stopDoesNotHitFollowup(): Promise<() => Promise<void>> {
  const f = fixture({ onInterrupt: async () => undefined });
  const scan = f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  await new Promise((r) => setTimeout(r, 10));

  // 扫描还在跑时就排一条追问(UI 允许);它要等扫描 turn 收尾才真正发出
  const discussion = f.store.addUserDiscussion(f.review.id, { file: 'a.ts', line: 1 });
  const followup = f.session.sendMessage(discussion.id, '这里为什么这么写?');
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't1' }); // 扫描自然收尾
  await scan;
  await new Promise((r) => setTimeout(r, 10)); // 追问的 turn 起来并认领 t2

  await f.session.stopScan();
  assert.deepEqual(f.agent.interrupts, [], '扫描已自然收尾,叫停不该去打断用户的追问');

  f.agent.emitEvent({ kind: 'message-delta', text: '因为要复用同一条流。', turnId: 't2' });
  f.agent.emitEvent({ kind: 'turn-completed', turnId: 't2' });
  const msg = await followup;
  assert.equal(msg.role, 'agent', '追问没被殃及,要照常拿到 agent 回复');
  assert.equal(msg.text, '因为要复用同一条流。');
  log('✓ 扫描收尾后叫停不殃及队里的追问');
  return () => f.session.dispose();
}

async function main(): Promise<void> {
  const cases = [
    failedDuringInterrupt,
    interruptRejects,
    followupStillAnswered,
    lateEventsDoNotLeak,
    deltaWithoutTurnIdStillCounts,
    stopBeforeTurnIdArrives,
    stopWhenAgentGivesNoTurnId,
    stopDoesNotHitFollowup,
  ];
  for (const t of cases) {
    const dispose = await t();
    await dispose(); // MCP server 不关,event loop 就一直醒着,进程退不了
  }
  log('全部通过');
}

main().catch((e) => {
  process.stderr.write(`[stop-scan] 失败: ${(e as Error).stack}\n`);
  process.exit(1);
});
