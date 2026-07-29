/**
 * 确定性验证重复上报的兜底吸收(ReviewSession.absorbDuplicate),经真实 MCP 工具面驱动:
 * stub agent 扮演 codex 拿到注入的端点,spike 以 MCP client 身份跨轮次调 resolve_finding /
 * report_finding。不起 codex、不烧 token。运行:npm run spike:absorb
 *
 * 盯的是同一处代码上「本轮判 fixed」与「同处另一个问题」撞在一起的那一格:
 * dedupe 只看文件 + 行距 + 标题相似度,分不开这两者,一旦当成回归就会既翻掉结案、又吞掉新上报。
 * ABI 注意:跑过 electron-vite dev 后先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
  StartConversationOptions,
} from '../src/backend/agent/conversational-agent';
import { isAutoClosedFixed, type Finding } from '../src/shared/domain';
import { isSameFinding, titleSimilarity } from '../src/shared/finding-dedupe';

const log = (m: string) => process.stdout.write(`[absorb] ${m}\n`);

/**
 * 把墙钟往前挪一格。真实世界里「上一次尝试判了 fixed」与「重试重开这一轮」之间隔着一次 turn 失败
 * 和一次点击,库里的毫秒时间戳自然分得开;脚本里两行紧邻,不挪就落在同一毫秒。
 */
function tick(ms = 2): void {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

const FILE = 'apps/booking-ticket-service/src/applications/web/detail-page/detail-page-web.application.ts';
/** 第 1 轮的原意见 */
const TITLE_A = '入队失败会把 ticket 永久留在不可重试的 BOOKING 状态';
/** 同一处代码上的另一个问题:入队前那次缓存写落在补偿之外 */
const TITLE_B = '入队前缓存写失败仍会把 ticket 卡在 BOOKING';

/** 扮演 codex:只交出注入的 MCP 端点,turn 里什么都不做 —— 工具调用由 spike 自己按轮次发。 */
class StubAgent extends EventEmitter implements ConversationalAgent {
  mcpUrl = '';
  mcpToken = '';
  private turn = 0;

  async startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    this.mcpUrl = opts.mcpUrl ?? '';
    this.mcpToken = opts.mcpToken ?? '';
    assert.ok(this.mcpUrl && this.mcpToken, 'session 应注入 MCP 端点与令牌');
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    return this.startConversation(opts);
  }
  async sendMessage(): Promise<string> {
    const turnId = `t${++this.turn}`;
    this.emit('event', { kind: 'turn-completed', turnId } satisfies AgentEvent);
    return turnId;
  }
  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
  async interrupt(): Promise<void> {}
  approve(): void {}
  dispose(): void {}
}

async function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'github-pr',
    sourceRef: 'acme/repo#3989',
    title: 'PR#3989',
  });
  store.startRound(review.id, 1, { headSha: 'aaaa1111' });
  const origin = store.addFinding(review.id, {
    severity: 'medium',
    category: 'Correctness',
    title: TITLE_A,
    body: '`send` 抛错后没有补偿,ticket 停在不可重试的 BOOKING。',
    file: FILE,
    line: 187,
  });

  const agent = new StubAgent();
  const session = new ReviewSession(review.id, store, agent);
  const emitted: Finding[] = [];
  session.on('finding', (f: Finding) => emitted.push(f));
  await session.start({ cwd: process.cwd(), providers: { getDiff: () => 'DIFF', getFile: () => 'FILE' } });

  const client = new Client({ name: 'stub-codex', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(agent.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${agent.mcpToken}` } },
    }),
  );

  // ---- 第 2 轮:先判 fixed(自动结案),再在同一处报另一个问题 ----
  store.startRound(review.id, 2, { headSha: 'bbbb2222' });
  await client.callTool({
    name: 'resolve_finding',
    arguments: {
      finding_id: origin.id,
      status: 'fixed',
      note: '两条抢票路径已统一通过 `startClaiming` 入队;`send` 抛错时会把 ticket 置回可重试的失败态。',
    },
  });
  const closed = store.getFinding(origin.id)!;
  assert.equal(closed.triage, 'dismiss', 'fixed 应自动结案');
  assert.equal(isAutoClosedFixed(closed), true, '右栏的「已修复」分组(isFixedResolved)就看这一格');
  log('第 2 轮 resolve fixed → 自动结案 ✓');

  // 前提:这条新上报确实会被 dedupe 判成同一条(否则下面测的根本不是这条路)
  const candidate = { file: FILE, line: 187, title: TITLE_B };
  assert.ok(titleSimilarity(TITLE_A, TITLE_B) >= 0.5, 'dedupe 的近行阈值');
  assert.ok(isSameFinding(candidate, closed), 'dedupe 会把这两条判成同一处同一问题');

  await client.callTool({
    name: 'report_finding',
    arguments: { ...candidate, severity: 'medium', category: 'Correctness', body: '第一次 `redisCache.set` 在补偿 try/catch 之外。' },
  });
  const afterReport = store.listFindings(review.id);
  assert.equal(afterReport.length, 2, '同轮已判 fixed 的不是回归,这条新问题必须落库,不能被吞掉');
  const fresh = afterReport.find((f) => f.id !== origin.id)!;
  assert.equal(fresh.title, TITLE_B);
  assert.equal(fresh.round, 2, '算本轮新增');
  assert.ok(emitted.some((f) => f.id === fresh.id), '新 finding 要外发,否则本轮界面上根本看不到它');
  assert.equal(store.getRound(review.id, 2)!.suppressedCount, 0, '没有任何东西该被抑制');
  // 结案的那条不受牵连:翻回保留态会让它一边挂着 fixed 结论一边排进待处理(两套 UI 判据打架)
  const untouched = store.getFinding(origin.id)!;
  assert.equal(untouched.triage, 'dismiss', '本轮的 fixed 结案不该被同处的新上报翻掉');
  assert.equal(untouched.resolution, 'fixed');
  assert.equal(isAutoClosedFixed(untouched), true);
  log('同轮同处的另一个问题 → 新建落库,结案条目原样 ✓');

  // ---- 同轮自我推翻:标题几乎一致的重报是「其实没修好」,该纠正原条目而不是另立一条 ----
  // 对抗档的自检轮就在同一轮同一次扫描里干这个(站到刚才结论的对立面复核一遍)。
  const restated = { file: FILE, line: 187, title: '入队失败会把 ticket 留在不可重试的 BOOKING 状态' };
  assert.ok(titleSimilarity(TITLE_A, restated.title) >= 0.8, '这条是把同一条换个说法重述');
  store.setFindingResolution(origin.id, 2, 'fixed', '看走眼了,先按已修复记一次。');
  await client.callTool({
    name: 'report_finding',
    arguments: { ...restated, severity: 'medium', category: 'Correctness', body: '自检轮复核:补偿其实没覆盖 send 抛错。' },
  });
  assert.equal(store.listFindings(review.id).length, 2, '自我推翻要纠正原条目,不能再立一条同名的');
  const overturned = store.getFinding(origin.id)!;
  assert.equal(overturned.triage, 'open', '推翻了 fixed → 恢复保留');
  assert.equal(overturned.resolution, 'still_present');
  assert.equal(overturned.autoClosed, false);
  log('同轮自我推翻(标题几乎一致)→ 纠正回仍存在 ✓');

  // ---- 失败轮重试:沿用原轮号重开,上一次尝试遗留的 fixed 不能算「本次刚判的」----
  // 换一处独立的 finding 来验:上面那处已经有一条同标题的落库条目,去重会优先匹到它,测不到这条路。
  const idem = store.addFinding(review.id, {
    severity: 'high',
    category: 'Correctness',
    title: '重复消费未做幂等,重试会双写库存',
    body: 'consumer 没有幂等键。',
    file: FILE,
    line: 400,
  });
  const idemAgain = { file: FILE, line: 400, title: '重复消费缺幂等,重试会双写两次库存' };
  // 措辞落在「近似但不算重述」那一档:重述档会走纠正,测不出尝试边界
  assert.ok(titleSimilarity(idem.title, idemAgain.title) >= 0.5);
  assert.ok(titleSimilarity(idem.title, idemAgain.title) < 0.8);
  store.setFindingResolution(idem.id, 2, 'fixed', '这次尝试判了已修复,随后 turn 失败。');
  store.finishRound(review.id, 2, 'failed', { errorMessage: 'turn 挂了', errorKind: 'connection' });
  tick();
  store.startRound(review.id, 2, { headSha: 'bbbb2222' }); // 重试:同一轮号覆盖,startedAt 刷新
  const beforeRetry = store.listFindings(review.id).length;
  await client.callTool({
    name: 'report_finding',
    arguments: { ...idemAgain, severity: 'high', category: 'Correctness', body: '重试后又报了一次。' },
  });
  assert.equal(
    store.listFindings(review.id).length,
    beforeRetry,
    '上一次尝试遗留的结案不算本次刚判 —— 否则重试会凭空多出一条重复 finding',
  );
  const retried = store.getFinding(idem.id)!;
  assert.equal(retried.triage, 'open', '重试里被重报 → 按回归恢复保留');
  assert.equal(retried.resolution, 'still_present');
  log('失败轮重试:上一次尝试的 fixed 不被误判为本次刚判 ✓');

  // ---- 第 3 轮:真回归(往轮结案的条目被重报)仍要恢复保留 ----
  store.setFindingResolution(origin.id, 2, 'fixed', '第 2 轮最终判定已修复。');
  store.startRound(review.id, 3, { headSha: 'cccc3333' });
  const beforeRegression = store.listFindings(review.id).length;
  await client.callTool({
    name: 'report_finding',
    arguments: {
      file: FILE,
      line: 189,
      title: TITLE_A,
      severity: 'medium',
      category: 'Correctness',
      body: '补偿又被改回去了,`send` 抛错后 ticket 仍停在 BOOKING。',
    },
  });
  assert.equal(store.listFindings(review.id).length, beforeRegression, '回归走恢复原条目,不新建重复条目');
  const regressed = store.getFinding(origin.id)!;
  assert.equal(regressed.triage, 'open', '往轮结案的条目被重报 → 恢复保留');
  assert.equal(regressed.autoClosed, false);
  assert.equal(regressed.dismissReason, null, '自动剔除理由要清掉');
  assert.equal(regressed.resolution, 'still_present', '本轮结论必须覆盖旧的 fixed,否则 UI 一边显示已修复一边排进待处理');
  assert.equal(regressed.resolutionNote, null, '说明属于写下它的那一轮');
  assert.equal(regressed.lastSeenRound, 3);
  log('往轮结案条目被重报 → 恢复保留 + 本轮记为仍存在 ✓');

  // ---- reviewer 自己剔除的照旧抑制:那是他的判断,不是「问题没了」----
  const dropped = store.addFinding(review.id, {
    severity: 'low',
    category: 'Complexity',
    title: '旧 helper 可以顺手删掉',
    body: '没人再调用。',
    file: FILE,
    line: 40,
  });
  store.setTriage(dropped.id, 'dismiss', '留给下个 PR 一起清。');
  await client.callTool({
    name: 'report_finding',
    arguments: {
      file: FILE,
      line: 40,
      title: '旧 helper 可以顺手删掉',
      severity: 'low',
      category: 'Complexity',
      body: '没人再调用。',
    },
  });
  assert.equal(store.listFindings(review.id).length, beforeRegression + 1, '被抑制的上报不落库(只多出 dropped 那条)');
  assert.equal(store.getRound(review.id, 3)!.suppressedCount, 1, '抑制要计数留痕');
  assert.equal(store.getFinding(dropped.id)!.dismissReason, '留给下个 PR 一起清。');
  log('reviewer 剔除项照旧抑制 + 计数 ✓');

  await client.close();
  await session.dispose();
  db.close();
  log('PASS');
}

main().catch((e) => {
  process.stderr.write(`[absorb] FAIL: ${(e as Error).message}\n`);
  process.exit(1);
});
