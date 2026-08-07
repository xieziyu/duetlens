/**
 * Headless 端到端验证:讨论里的回写提案(见 docs/design/discussion-proposals.md)。
 *
 * 覆盖三类断言,前两类要真 codex,第三类是纯本地不烧 token:
 *   A. 追问轮的 update / dismiss 只生成**待确认提案**,finding 一个字不动;提案挂到那条 agent 回复上。
 *   B. 采纳 / 撤销走真库:剔除只写 triage 与理由(正文原样保留),撤销按快照还原。
 *   C. 事务边界与机审轮拒绝剔除 —— 用桩制造失败,断言整体回滚。
 *
 * 需 `codex login`;跑之前 `npm run rebuild:node`,跑完 `npm run rebuild:electron` 切回。
 *   运行:npm run spike:proposals
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { CodexAgent } from '../src/backend/agent/codex/codex-agent';
import { ReviewSession } from '../src/backend/review/review-session';
import { ReviewManager } from '../src/backend/review/review-manager';
import { DuetlensMcpServer } from '../src/backend/mcp/duetlens-mcp-server';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
  StartConversationOptions,
} from '../src/backend/agent/conversational-agent';
import { isProposalUndoBlocked, type FindingProposal } from '../src/shared/domain';

const REVIEW_FILE = 'scripts/seed-demo.js';
const SRC = `const db = require('../src/db');

// 一次性数据播种脚本
async function seed(name) {
  const query = "INSERT INTO users (name) VALUES ('" + name + "')";
  return db.query(query);
}

module.exports = { seed };
`;
const DIFF = `diff --git a/${REVIEW_FILE} b/${REVIEW_FILE}
new file mode 100644
--- /dev/null
+++ b/${REVIEW_FILE}
@@ -0,0 +1,10 @@
${SRC.split('\n').map((l) => '+' + l).join('\n')}`;

const log = (m: string) => process.stdout.write(`[proposals] ${m}\n`);
const brief = (s: string, n = 70) => s.replace(/\s+/g, ' ').slice(0, n);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 本 review 名下当前的提案(按落库顺序)。 */
const proposalsOf = (store: ReviewStore, reviewId: string): FindingProposal[] =>
  store.listProposals(reviewId);

async function main() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-proposals-'));
  mkdirSync(path.join(workdir, 'scripts'), { recursive: true });
  writeFileSync(path.join(workdir, REVIEW_FILE), SRC);

  // 真库(内存版走同一套迁移与 SQL,含 V13 的 finding_proposals)
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'chore/seed-script',
    repoPath: workdir,
    title: 'Add seed script',
  });

  // 采纳 / 撤销一律走 manager 的公开入口 —— spike 里另抄一份就只是在测自己刚写的那几行
  const manager = new ReviewManager(store);
  const agent = new CodexAgent({ onLog: (l) => l && process.stderr.write(`[codex] ${l}\n`) });
  const session = new ReviewSession(review.id, store, agent);
  session.on('finding', (f) => log(`finding 事件 ◀ ${f.severity} · ${brief(f.title, 40)}`));
  session.on('finding-proposal', (p) =>
    log(`proposal 事件 ◀ ${p.kind} · ${p.status} · msg=${p.messageId ?? '(未挂)'}`),
  );

  try {
    // ── C1. 机审轮拒绝 dismiss_finding(纯本地,不起 codex)────────────────────
    log('──── C1. 机审轮不接受 dismiss_finding ────');
    await assertScanRejectsDismiss();

    // ── C2. 事务边界:第二步失败要整体回滚(纯本地)──────────────────────────
    log('──── C2. 采纳中途失败 → 整体回滚 ────');
    assertApplyRollsBack();

    // ── C3. 并发:扫描在跑时插一条追问,两边的写语义不得互相污染(纯本地)────────
    log('──── C3. 扫描在跑 + 追问排队 ────');
    await assertModeIsPerTurn();

    // ── C4. 改写正文作废复核说明,撤销要把它交还(纯本地)────────────────────
    log('──── C4. 采纳改写正文 → 复核说明作废;撤销 → 还原 ────');
    assertUndoRestoresRecheckNote();

    // ── A. 扫描 ────────────────────────────────────────────────────────────
    log('──── A. 首轮扫描 ────');
    const findings = await session.start({
      cwd: workdir,
      providers: {
        getDiff: () => DIFF,
        getFile: (p) => (p.endsWith('seed-demo.js') ? SRC : `// 未知: ${p}`),
      },
    });
    assert.ok(findings.length > 0, '扫描应产出至少一条 finding');
    assert.equal(proposalsOf(store, review.id).length, 0, '机审轮不该产出提案');

    const target = findings[0];
    log(`选中 finding: ${target.severity} · ${brief(target.title, 50)}`);

    // ── A1. 追问诱发 update 提案 ────────────────────────────────────────────
    log('──── A1. 追问 → 期待 update 提案 ────');
    await session.sendMessage(
      target.discussionId,
      '这个脚本只在本机手动跑一次、参数由我自己输入,没有外部输入源。' +
        '按这个前提,你这条的严重度是不是定高了?如果同意,请把它改准一些。',
    );
    const afterA1 = proposalsOf(store, review.id);
    const update = afterA1.find((p) => p.kind === 'update');
    assert.ok(update, `追问后应有一条 update 提案(实际: ${afterA1.map((p) => p.kind).join(',') || '无'})`);
    assert.equal(update.status, 'pending', '提案应停在待确认,不能直接生效');

    // 关键:提案期间 finding 一个字都不能变
    const untouched = store.getFinding(target.id)!;
    assert.equal(untouched.title, target.title, 'pending 期间标题不得改动');
    assert.equal(untouched.body, target.body, 'pending 期间正文不得改动');
    assert.equal(untouched.severity, target.severity, 'pending 期间严重度不得改动');
    log(`✓ 提案已记下但未生效:${JSON.stringify(update.patch).slice(0, 90)}`);

    // 提案要挂在解释它的那条回复上(不然会排在那句话上面)
    const msgs = store.listMessages(target.discussionId);
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'agent');
    assert.ok(lastAgent, 'agent 应有回复');
    assert.equal(update.messageId, lastAgent.id, '提案应挂到本轮 agent 回复上');
    assert.equal(update.discussionId, target.discussionId, '提案应落在被追问的那条讨论上');
    log('✓ 提案挂到了本轮 agent 回复上');

    // ── B1. 采纳 update ────────────────────────────────────────────────────
    log('──── B1. 采纳 update ────');
    const applied = manager.applyProposal(review.id, update.id);
    assert.equal(applied.status, 'applied');
    const updated = store.getFinding(target.id)!;
    for (const key of Object.keys(update.patch) as (keyof typeof update.patch)[]) {
      assert.deepEqual(updated[key] ?? null, update.patch[key] ?? null, `${key} 应已按提案落库`);
    }
    // 快照只含这次真正改动的字段 —— 拍全量会让撤销顺手回滚应用之后的编辑。
    // 是 patch 字段的子集:提案把某字段写回了同一个值时不进快照(还原它等于没还原)。
    assert.ok(
      Object.keys(applied.before ?? {}).every((k) => k in update.patch),
      'before 快照不应超出该提案动过的字段',
    );
    log(`✓ 已落库,快照字段: ${Object.keys(applied.before ?? {}).join(',')}`);

    // ── B2. 撤销 ───────────────────────────────────────────────────────────
    log('──── B2. 撤销 ────');
    const undone = manager.undoProposal(review.id, update.id);
    assert.equal(undone.status, 'skipped', '撤销后退回可重新应用的已忽略态');
    const restored = store.getFinding(target.id)!;
    assert.equal(restored.title, target.title, '标题应还原');
    assert.equal(restored.body, target.body, '正文应还原');
    assert.equal(restored.severity, target.severity, '严重度应还原');
    log('✓ 撤销后逐字段还原');

    // ── A2. 追问诱发 dismiss 提案 ──────────────────────────────────────────
    log('──── A2. 追问 → 期待 dismiss 提案 ────');
    await session.sendMessage(
      target.discussionId,
      '再补一个前提:这个文件在本次改动的下一个提交里已经被删掉了,不会进主干,也没有任何调用点。' +
        '这条 finding 还成立吗?如果不成立,请把它剔除掉。',
    );
    const dismiss = proposalsOf(store, review.id).find((p) => p.kind === 'dismiss');
    assert.ok(dismiss, '应产出一条 dismiss 提案');
    assert.equal(dismiss.status, 'pending');
    const stillIntact = store.getFinding(target.id)!;
    assert.equal(stillIntact.triage, 'open', 'pending 期间不得剔除');
    assert.equal(stillIntact.body, target.body, 'dismiss 提案不得改动正文');
    log(`✓ dismiss 提案(理由 ${(dismiss.patch as { reason: string }).reason.length} 字)已记下,finding 未动`);

    // ── B3. 采纳 dismiss:只写 triage 与理由,正文原样保留 ────────────────────
    log('──── B3. 采纳 dismiss ────');
    manager.applyProposal(review.id, dismiss.id);
    const dropped = store.getFinding(target.id)!;
    const reason = (dismiss.patch as { reason: string }).reason;
    assert.equal(dropped.triage, 'dismiss', '应已剔除');
    assert.equal(dropped.dismissReason, reason, '剔除理由应是 agent 的原话');
    assert.equal(dropped.title, target.title, '★ 标题必须原样保留(本次要修的 bug)');
    assert.equal(dropped.body, target.body, '★ 正文必须原样保留(本次要修的 bug)');
    assert.equal(dropped.autoClosed, false, '人点的头不算自动结案');
    log('✓ 剔除只改了 triage + 理由,原文完好');

    log('✅ PASS — 提案回路打通:追问只提议不落库 → 采纳/撤销走真库 → 剔除保留原文');
    process.exitCode = 0;
  } finally {
    await session.dispose();
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * 采纳的两步(改 finding / 落定提案)必须同进同退。
 *
 * **必须打在 manager 的公开入口上**:在 spike 里另写一份带事务的实现,等于测自己刚写的那几行 ——
 * 生产代码里的 `store.transaction` 被拿掉也照样绿,这个断言就白立了。
 * 桩打在 store 的第二步上,让它在事务中途抛错。
 */
function assertApplyRollsBack(): void {
  const store = new ReviewStore(openDatabase(':memory:'));
  const manager = new ReviewManager(store);
  const reviewId = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' }).id;
  const finding = store.addFinding(
    reviewId,
    { severity: 'high', title: '原标题', body: '原正文', file: 'a.ts', line: 1 },
    'agent',
  );
  const disc = store.addUserDiscussion(reviewId, { file: 'a.ts', line: 1 });
  const proposalId = store.addProposal({
    reviewId,
    discussionId: disc.id,
    findingId: finding.id,
    kind: 'update',
    patch: { severity: 'low', title: '新标题' },
    baseUpdatedAt: finding.updatedAt,
  }).id;
  const findingId = finding.id;
  const before = store.getFinding(findingId)!;
  const real = store.setProposalStatus.bind(store);
  (store as { setProposalStatus: unknown }).setProposalStatus = () => {
    throw new Error('注入的落库失败');
  };
  let threw = false;
  try {
    manager.applyProposal(reviewId, proposalId);
  } catch {
    threw = true;
  } finally {
    (store as { setProposalStatus: unknown }).setProposalStatus = real;
  }
  assert.ok(threw, '第二步失败应把错误抛出去');
  const after = store.getFinding(findingId)!;
  assert.equal(after.title, before.title, '★ 回滚后标题不应变');
  assert.equal(after.body, before.body, '★ 回滚后正文不应变');
  assert.equal(after.severity, before.severity, '★ 回滚后严重度不应变');
  assert.equal(store.getProposal(proposalId)!.status, 'pending', '★ 回滚后提案仍是待确认');
  log('✓ 第二步失败 → finding 与提案一起回滚,没有半状态');
}

/**
 * 采纳一条改写正文的提案时,本轮的复核说明与首轮补丁一并作废(它们写在这份正文之前,
 * 而复核说明会取代正文发出去)。撤销则要把两者一起交还 —— 它们不在 patch 的字段里,
 * 快照漏拍的话,撤销交回的是一条被剥掉复核说明的旧 finding。
 */
function assertUndoRestoresRecheckNote(): void {
  const store = new ReviewStore(openDatabase(':memory:'));
  const manager = new ReviewManager(store);
  const reviewId = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' }).id;
  const finding = store.addFinding(
    reviewId,
    { severity: 'high', title: '数据竞争', body: '原正文', file: 'a.ts', line: 1, suggestion: '  const c = 0;' },
    'agent',
  );
  const NOTE = '第 2 轮复核:换成了 RefCell,跨线程仍不安全。';
  store.startRound(reviewId, 2, {});
  store.setFindingResolution(finding.id, 2, 'still_present', NOTE);

  const disc = store.addUserDiscussion(reviewId, { file: 'a.ts', line: 1 });
  const proposalId = store.addProposal({
    reviewId,
    discussionId: disc.id,
    findingId: finding.id,
    kind: 'update',
    patch: { body: '跨线程共享仍需 Mutex。' },
    baseUpdatedAt: store.getFinding(finding.id)!.updatedAt,
  }).id;

  const applied = manager.applyProposal(reviewId, proposalId);
  const after = store.getFinding(finding.id)!;
  assert.equal(after.resolutionNote, null, '★ 采纳改写正文 → 复核说明作废');
  assert.equal(after.suggestion, null, '★ 首轮补丁同源作废');
  assert.equal(after.bodyRound, 2, '正文轮次推到本轮');
  assert.equal(after.resolution, 'still_present', '判定本身不受影响,只是说明被新正文取代');
  assert.deepEqual(
    Object.keys(applied.before ?? {}).sort(),
    ['body', 'bodyRound', 'resolutionNote', 'suggestion'],
    '★ 快照要连作废的几项一起拍下,否则撤不回来',
  );

  // 应用之后 agent 又写了一份新的复核说明 → 撤销会拿旧值把它顶掉,必须先拦下
  store.setFindingResolution(finding.id, 2, 'still_present', '第 2 轮补充:另一条路径也会踩到。');
  assert.equal(
    isProposalUndoBlocked(store.getProposal(proposalId)!, store.getFinding(finding.id)),
    true,
    '★ 连带清空的字段被重新写过 → 不给撤销',
  );
  assert.throws(() => manager.undoProposal(reviewId, proposalId), /又被改过/, '★ 权威层也要拦');

  // 退回应用后的样子(说明仍是空的),撤销才该放行
  store.restoreFinding(finding.id, { resolutionNote: null });
  manager.undoProposal(reviewId, proposalId);
  const restored = store.getFinding(finding.id)!;
  assert.equal(restored.body, '原正文', '正文应还原');
  assert.equal(restored.resolutionNote, NOTE, '★ 复核说明应交还');
  assert.equal(restored.suggestion, '  const c = 0;', '★ 补丁应交还');
  assert.equal(restored.bodyRound, 1, '★ 正文轮次应交还 —— 否则旧正文冒充本轮新话再追评一次');
  log('✓ 改写正文作废复核说明与补丁,撤销一并交还;期间被重写过则拦下');

  // 应用时**没有**说明可清(去重兜底命中那种),于是它进不了快照;此后新写的一份不受任何
  // 守卫保护,只能靠撤销自己不去派生 —— 借 updateFinding 写回旧正文的话,它会顺手清掉这份新的。
  const g = store.addFinding(
    reviewId,
    { severity: 'high', title: '另一条', body: '原正文', file: 'b.ts', line: 1 },
    'agent',
  );
  store.touchFindingSeen(g.id, 2);
  const gBefore = store.getFinding(g.id)!;
  const gProposalId = store.addProposal({
    reviewId,
    discussionId: disc.id,
    findingId: g.id,
    kind: 'update',
    patch: { body: '改写过的正文。' },
    baseUpdatedAt: store.getFinding(g.id)!.updatedAt,
  }).id;
  const gApplied = manager.applyProposal(reviewId, gProposalId);
  assert.ok(!('resolutionNote' in (gApplied.before ?? {})), '本来就没有说明 → 不进快照');

  const LATE = '第 2 轮复核:仍然踩得到。';
  store.setFindingResolution(g.id, 2, 'still_present', LATE);
  manager.undoProposal(reviewId, gProposalId);
  const gRestored = store.getFinding(g.id)!;
  assert.equal(gRestored.body, '原正文', '正文应还原');
  assert.equal(gRestored.bodyRound, gBefore.bodyRound, '正文轮次应还原');
  assert.equal(gRestored.resolutionNote, LATE, '★ 撤销之后写下的说明不得被回滚顺手清掉');
  log('✓ 撤销只碰快照点名的字段,应用之后新写的复核说明原样留着');
}

/**
 * 机审轮(apply 模式)不接受 dismiss_finding —— 剔除始终是 reviewer 的判断,
 * 没有人在场确认时就地放行,等于让 agent 自己关掉自己报的问题。
 * 直接对 MCP server 断言,不起 codex。
 */
async function assertScanRejectsDismiss(): Promise<void> {
  const mcp = new DuetlensMcpServer({ getDiff: () => '', getFile: () => '' });
  let proposed = 0;
  mcp.on('finding-proposal', () => (proposed += 1));
  const url = await mcp.listen();
  const client = new Client({ name: 'spike-proposals', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } },
    }),
  );
  try {
    // 缺省即 apply 模式(机审轮)。走真实工具调用,不去戳私有处理器 —— 那种写法会随重构静默失效。
    const res = (await client.callTool({
      name: 'dismiss_finding',
      arguments: { finding_id: 'x', reason: '误报' },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    assert.equal(res.isError, true, '机审轮应拒绝 dismiss_finding');
    assert.equal(proposed, 0, '机审轮不应产出提案');
    log(`✓ 机审轮拒绝剔除:${brief(res.content?.[0]?.text ?? '', 46)}`);

    // 顺带验 propose 模式的两道 ingress:空理由、以及 update 一个字段都不给
    mcp.setWriteMode('propose');
    const noReason = (await client.callTool({
      name: 'dismiss_finding',
      arguments: { finding_id: 'x', reason: '   ' },
    })) as { isError?: boolean };
    assert.equal(noReason.isError, true, '空理由应被拒收');
    const emptyPatch = (await client.callTool({
      name: 'update_finding',
      arguments: { finding_id: 'x' },
    })) as { isError?: boolean };
    assert.equal(emptyPatch.isError, true, '不给任何待改字段应被拒收');
    assert.equal(proposed, 0, '被拒的调用不应留下提案');
    log('✓ 空理由 / 空 patch 均被 ingress 拒收');
  } finally {
    await client.close();
    await mcp.close();
  }
}

/**
 * 回归:提案模式必须绑在**真正执行**的那个 turn 上,不能是队列外的一个标志位。
 *
 * 复现原来的错法:追问一入队就把模式翻成 propose,于是**正在跑的扫描 turn** 的 report_finding
 * 会被记成那条讨论的提案(而不是一条真 finding);扫描收尾时的复位又会让排在后面的那一问
 * 退回直接落库 —— 一次绕过 reviewer 确认的静默改动。
 *
 * 用桩 agent 精确编排时序,不烧 token:桩在自己的 turn 里经真实 MCP 端点调工具,
 * 与 codex 走的是同一条路。
 */
async function assertModeIsPerTurn(): Promise<void> {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' });

  const scanGate = new Gate();
  const agent = new StubAgent(scanGate);
  const session = new ReviewSession(review.id, store, agent);
  try {
    const scanning = session.start({
      cwd: '/tmp',
      providers: { getDiff: () => 'DIFF', getFile: () => 'SRC' },
      scanPrompt: 'SCAN',
    });
    await agent.conversationStarted;

    // 扫描 turn 已经在跑(卡在 gate 上),此刻插一条追问 —— 它会排在扫描后面
    const disc = store.addUserDiscussion(review.id, { file: 'a.ts', line: 1 });
    const asking = session.sendMessage(disc.id, 'ASK');
    await tick(30);
    assert.equal(store.listMessages(disc.id).length, 1, '追问此刻只落库了问题,还没轮到它');

    // 放行扫描:它的 report_finding 必须落成**真 finding**,不能变成那条讨论的提案
    scanGate.open();
    const findings = await scanning;
    assert.equal(findings.length, 1, '扫描应落库一条真 finding');
    assert.equal(store.listProposals(review.id).length, 0, '★ 扫描轮的上报不得变成提案');
    log('✓ 扫描在跑时插入追问,扫描的 report_finding 仍直接落库');

    // 轮到追问:它的 update_finding 必须变成提案,且挂在这条讨论上
    await asking;
    const proposals = store.listProposals(review.id);
    assert.equal(proposals.length, 1, '★ 排队的追问仍应走提案,不能被前一轮的复位打回直接落库');
    assert.equal(proposals[0].kind, 'update');
    assert.equal(proposals[0].discussionId, disc.id, '提案应落在发起追问的那条讨论上');
    assert.equal(
      store.getFinding(findings[0].id)!.title,
      findings[0].title,
      '★ 追问轮的 update 不得直接改动 finding',
    );
    log('✓ 排队的追问轮走提案,finding 未被直接改动');
  } finally {
    await session.dispose();
  }
}

/** 可按住再放开的一道闸(同 spike-followup-queue 的用法)。 */
class Gate {
  private release!: () => void;
  readonly passed: Promise<void>;
  constructor() {
    this.passed = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  open(): void {
    this.release();
  }
}

/**
 * 桩 agent:不连 codex,但在自己的每个 turn 里经**真实 MCP 端点**调工具 ——
 * 走的正是 codex 会走的那条路,故写语义(直接落库 / 提案)由被测代码而非桩决定。
 */
class StubAgent implements ConversationalAgent {
  private handlers = new Set<(e: AgentEvent) => void>();
  private mcpUrl = '';
  private mcpToken = '';
  private turnSeq = 0;
  private started!: () => void;
  readonly conversationStarted: Promise<void>;
  private findingId = '';

  constructor(private readonly scanGate: Gate) {
    this.conversationStarted = new Promise<void>((r) => {
      this.started = r;
    });
  }

  async startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    this.mcpUrl = opts.mcpUrl!;
    this.mcpToken = opts.mcpToken!;
    return { conversationId: 'stub-thread' };
  }
  resumeConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    return this.startConversation(opts);
  }

  async sendMessage(_conversationId: string, text: string): Promise<string> {
    const turnId = `t${++this.turnSeq}`;
    void this.runTurn(turnId, text);
    return turnId;
  }

  /** 每个 turn:调一次工具,再发终局。扫描 turn 的工具调用卡在闸上,好让追问排到它后面。 */
  private async runTurn(turnId: string, text: string): Promise<void> {
    if (text === 'SCAN') {
      this.started();
      await this.scanGate.passed;
      const res = await this.callTool('report_finding', {
        severity: 'high',
        title: '桩上报',
        body: 'b',
        file: 'a.ts',
        line: 1,
      });
      this.findingId = /id=([0-9a-f-]+)/.exec(res)?.[1] ?? '';
    } else {
      await this.callTool('update_finding', { finding_id: this.findingId, severity: 'low' });
    }
    for (const h of this.handlers) {
      h({ kind: 'message-delta', turnId, text: 'ok' } as AgentEvent);
      h({ kind: 'turn-completed', turnId } as AgentEvent);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const client = new Client({ name: 'stub', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${this.mcpToken}` } },
      }),
    );
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    await client.close();
    return res.content?.[0]?.text ?? '';
  }

  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async interrupt(): Promise<void> {}
  approve(): void {}
  dispose(): void {
    this.handlers.clear();
  }
}

main().catch((e) => {
  process.stdout.write(`[proposals] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
