/**
 * 确定性验证「只读沙箱注入失效」的判据(不走 codex/不烧 token)。
 *
 * 背景:codex 对请求里的未知字段是**静默忽略**的,所以 thread/start 把 sandbox 送出去
 * 不等于它生效;又因为注入的 approvalPolicy 把审批闸门全关了,策略没落地时 codex 通常**不会来问**,
 * 没有天然哨兵。握手侧的读回校验在 CodexAgent(需真 codex,见 assertReadOnly),
 * 这里验的是 turn 内那条兜底:
 *
 * 1. 收到本不该出现的审批请求(expected=false)→ 本轮就地判死,归因 sandbox-not-applied。
 * 2. 受信 MCP 的正常 elicitation(expected=true)→ 照常放行,不许被这条兜底误杀。
 * 3. 未受信 MCP 的 elicitation 被拒(expected=false 但 gate=mcp)→ 同样不算沙箱失效 ——
 *    只看 expected 的话,用户自己配的第三方 MCP server 会把好好的一轮判死。
 * 4. 建会话阶段(握手校验)抛的普通 Error 要保住归因 —— 塌成 other 就等于这套文案白做。
 * 5. codex 的每种审批方法都得在哨兵集合里(v2 的 commandExecution 曾漏掉),且拒绝的说法
 *    要按各自的应答类型写 —— 没有通用的 `denied`。
 *   运行:npm run spike:sandbox-guard
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { AgentTurnError, ReviewSession } from '../src/backend/review/review-session';
import { describeRoundFailure } from '../src/backend/review/review-manager';
import {
  CodexServerRequest,
  DECLINE_BY_METHOD,
  READ_ONLY_GATES,
} from '../src/backend/agent/codex/protocol';
import { POLICY_APPROVALS, isSilentApproval } from '../src/backend/agent/codex/codex-agent';
import { MCP_UNDELIVERED_CODE, SANDBOX_NOT_APPLIED_CODE } from '../src/shared/ipc';
import { MCP_SERVER_NAME, MCP_TOOL } from '../src/shared/mcp-contract';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
} from '../src/backend/agent/conversational-agent';

const log = (m: string) => process.stdout.write(`[sandbox-guard] ${m}\n`);

class StubAgent extends EventEmitter implements ConversationalAgent {
  constructor(private readonly onTurn: (agent: StubAgent, turnId: string) => void) {
    super();
  }
  async startConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(): Promise<ConversationHandle> {
    return { conversationId: 'stub-thread' };
  }
  async sendMessage(): Promise<string> {
    setTimeout(() => this.onTurn(this, 't1'), 0); // 应答之后再发事件,贴近真实次序
    return 't1';
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
  /** 判死之后 codex 侧必须真的停手 —— 只结束本地等待的话,那个 turn 还在跑 */
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

function fixture(onTurn: (agent: StubAgent, turnId: string) => void) {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'stub',
    repoPath: null,
    title: 'sandbox-guard spike',
    model: null,
    reasoningEffort: null,
    intensity: 'standard',
  });
  store.startRound(review.id, 1, {});
  const agent = new StubAgent(onTurn);
  const session = new ReviewSession(review.id, store, agent);
  return { store, review, agent, session, providers: { getDiff: () => '', getFile: async () => '' } };
}

/** 1. 只读会话里冒出审批请求 —— 策略没落地,本轮必须就地判死。 */
async function unexpectedApprovalKillsRound(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'approval',
      method: CodexServerRequest.commandExecutionApproval,
      decision: 'denied',
      expected: false,
      gate: 'policy',
    });
    // 之后 turn 即便自称跑完了也不作数:判死要基于策略失效本身
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await assert.rejects(
    () => f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 }),
    (e: Error) =>
      e instanceof AgentTurnError &&
      e.errorKind === 'sandbox-not-applied' &&
      e.message.includes(SANDBOX_NOT_APPLIED_CODE),
    '只读会话里出现审批请求 = 沙箱没落地,本轮要以 sandbox-not-applied 失败',
  );
  assert.equal(f.agent.disposed, true, '判死还不够:codex 侧的 turn 必须被真的拆掉,否则它还在跑');
  log('✓ 意料外的审批请求 → 本轮判死并拆会话');
  return () => f.session.dispose();
}

/** 2. 受信 MCP 的正常 elicitation 走的是同一个事件 —— 不许被兜底误杀。 */
async function expectedApprovalIsHarmless(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'approval',
      method: 'mcp_server_elicitation',
      decision: 'accepted',
      expected: true,
      gate: 'mcp',
      server: 'duetlens',
    });
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  assert.notEqual(f.store.getReview(f.review.id)?.status, 'failed', '自建 MCP 的审批是正常流程');
  log('✓ 受信 MCP 的 elicitation 照常放行');
  return () => f.session.dispose();
}

/**
 * 3. 未受信 MCP server 的 elicitation 被拒 —— 同样是 expected=false,但它**不是**沙箱哨兵:
 * 用户自己在 config.toml 里配的第三方 MCP server 就会发,被拒只说明我们没批准那次工具调用。
 * 据此判死会把本可继续的审核拦腰砍断,还倒打一耙让用户去升 codex。
 */
async function declinedMcpElicitationIsNotABreach(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'approval',
      method: 'mcpServer/elicitation/request',
      decision: 'declined',
      expected: false,
      gate: 'mcp',
      server: 'some-third-party',
    });
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  assert.notEqual(
    f.store.getReview(f.review.id)?.status,
    'failed',
    '第三方 MCP 的 elicitation 被拒不等于沙箱失效,不该判死这一轮',
  );
  log('✓ 未受信 MCP 的 elicitation 被拒 → 不误判为沙箱失效');
  return () => f.session.dispose();
}

/**
 * 4. 建会话阶段抛的是普通 Error(没有 turn,也就没有 codexErrorInfo 可映射)。
 * 归因要认得出这两类,否则界面只给一句泛泛的失败、还把「重试」摆成主操作 ——
 * 而这两类重试必然复现。握手校验正是走这条路,是沙箱判据最主要的入口。
 *
 * 反过来也要钉住:协议判据只认 JSON-RPC 错误码那个尾巴。source / gh / git 的报错里
 * 「Invalid request」「missing field」这类词面随处可见,扫 prose 会把它们全打成版本不匹配。
 */
function launchFailuresKeepTheirKind(): void {
  const cases: [string, string][] = [
    [`${SANDBOX_NOT_APPLIED_CODE} codex 没有按只读沙箱起会话(sandbox=workspaceWrite)`, 'sandbox-not-applied'],
    ['Invalid request: missing field `turnId` (code -32600)', 'codex-version-mismatch'],
    ['Invalid request: unknown variant `turn/nope` (code -32600)', 'codex-version-mismatch'],
    ['Could not resolve host: github.com', 'other'],
    // 下面这些**不是**协议问题,而且是两个相反方向的误伤。判成 codex-version-mismatch
    // 就会把真实原因盖掉,还扣一个不可重试的「去升级 codex」。
    //
    // 一、词面像但没有 JSON-RPC 尾巴 —— source / gh / git 的报错:
    ['HTTP 400: Invalid request — pull request not found', 'other'],
    ['fatal: missing field `url` in .gitmodules', 'other'],
    ['gh: unknown variant of --json field', 'other'],
    // 二、有尾巴但是 codex 自己的**业务**拒绝 —— 这条是真机原文,codex 把 -32600
    //     也用在业务条件上,所以光认错误码同样会翻车:
    ['no active turn to interrupt (code -32600)', 'other'],
  ];
  for (const [message, expected] of cases) {
    const got = describeRoundFailure(new Error(message)).errorKind;
    assert.equal(got, expected, `「${message.slice(0, 40)}…」应归到 ${expected},实得 ${got}`);
  }
  log('✓ 建会话失败保住各自归因,不塌成 other');
}

/**
 * 5. 审批方法表与哨兵集合必须同步。这次漏的就是 v2 的 `item/commandExecution/requestApproval`
 * —— 它掉进「未知反向请求」那一档、`gate` 被标成 mcp,于是**真正的命令执行审批**悄悄绕过了哨兵:
 * 沙箱失效时既不判死也不拆会话。故用不变式钉住,而不是靠记得。
 */
function everyApprovalIsASentinel(): void {
  for (const [name, method] of Object.entries(CodexServerRequest)) {
    if (method === CodexServerRequest.mcpElicitation) continue; // 工具确认,不是策略哨兵
    assert.ok(
      POLICY_APPROVALS.has(method),
      `${name}(${method})没进哨兵集合 —— 沙箱失效时这类审批会被当成普通 MCP 请求放过`,
    );
  }
  // permissions 的应答里没有 decision 字段(要回一份授权档),表达不了拒绝 ——
  // 它是唯一只能回 JSON-RPC 错误的一条;再多一条就说明有人加了方法却没想清楚怎么拒。
  assert.deepEqual(
    [...POLICY_APPROVALS].filter((m) => DECLINE_BY_METHOD[m] === undefined),
    [CodexServerRequest.permissionsApproval],
    '除 permissions 外,每种审批都得有按其应答类型写的拒绝说法',
  );
  log('✓ 审批方法表与哨兵集合同步,拒绝说法齐备');
}

/**
 * 6. codex 没把调用交给自建 MCP —— findings 回不来,本轮必须判死。
 *
 * 这条兜底最容易被写过头:工具自己回的业务拒绝(schema 不合法)也是 `status: 'failed'`,
 * 而那种 agent 看得到原文、改对了会重来,是正常来回。分界不在措辞上,在 `undelivered`
 * 有没有值 —— 未送达才有,业务拒绝没有。两种形状都在这里钉住。
 */
async function undeliveredMcpCallKillsRound(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'tool-call',
      server: MCP_SERVER_NAME,
      tool: MCP_TOOL.reportFinding,
      status: 'failed',
      undelivered: 'MCP tool call requires approval, but approval policy is never',
    });
    // 未送达之后 turn 照样会 completed —— 正是这一点让它伪装成「审核完成,0 findings」
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await assert.rejects(
    () => f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 }),
    (e: Error) =>
      e instanceof AgentTurnError &&
      e.errorKind === 'mcp-undelivered' &&
      e.message.includes(MCP_UNDELIVERED_CODE),
    'codex 侧拒掉的 MCP 调用 = 回传链路断了,本轮要以 mcp-undelivered 失败',
  );
  assert.equal(f.agent.disposed, true, '同沙箱那条:会话得真拆掉,留着下一条追问也白跑');
  log('✓ 未送达的 MCP 调用 → 本轮判死并拆会话');
  return () => f.session.dispose();
}

/** 7. 工具自己回的业务拒绝走同一个事件 —— 不许被上面那条误杀。 */
async function toolRejectionIsHarmless(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'tool-call',
      server: MCP_SERVER_NAME,
      tool: MCP_TOOL.writeSummary,
      // 实测形状:server 答过话了,拒绝原文在 result 里,故 undelivered 无值
      status: 'failed',
    });
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  assert.equal(f.agent.disposed, false, 'server 已答话的业务拒绝不该拆会话 —— agent 还要改对了重来');
  log('✓ 工具回的业务拒绝 → 不误判为链路断开');
  return () => f.session.dispose();
}

/**
 * 8. 回显策略的真值表。这里是**失败关闭**的那一侧:判错成「静默」就等于放一份没证实的
 * 策略过关,而 assertReadOnly 之后不会再问第二遍。
 *
 * 最容易漏的是空 granular —— 只查「现有值是否都为 false」的写法会因空集恒真而放行。
 */
function silentApprovalTruthTable(): void {
  const gates = { ...READ_ONLY_GATES };
  const cases: [unknown, boolean, string][] = [
    ['never', true, '旧版说法'],
    [{ granular: gates }, true, '我们请求的那份,原样回显'],
    [{ granular: {} }, false, '空 granular:什么都没证实,不能因空集恒真而放行'],
    [{ granular: { ...gates, mcp_elicitations: true } }, false, '有闸门开着'],
    [
      { granular: Object.fromEntries(Object.entries(gates).slice(1)) },
      false,
      '少回显一个闸门:那一个的状态是未知,不是关',
    ],
    [{ granular: { ...gates, future_gate: true } }, false, '多出一个我们没请求过的闸门且开着'],
    [{ granular: { ...gates, future_gate: false } }, true, '多出的闸门关着 —— 仍算静默'],
    ['on-request', false, '会来问'],
    [undefined, false, '没回显 = 没证实'],
  ];
  for (const [policy, expected, why] of cases) {
    const got = isSilentApproval(policy as Parameters<typeof isSilentApproval>[0]);
    assert.equal(got, expected, `${why}:应判 ${expected},实得 ${got}`);
  }
  log('✓ 回显策略真值表:空/缺项/多出的 granular 都不放行');
}

/**
 * 9. codex 自带的 MCP 探测工具失败 —— 也挂在 `server: 'duetlens'` 名下,但不是我们的工具。
 *
 * 实测:codex 0.149 会自作主张调 list_mcp_resources(它的工具说明还鼓励「优先用 resources」),
 * 而我们不发布 resources。这类探测失败在事件上与真·未送达同形,拿它判死会毙掉一轮好机审。
 */
async function builtinProbeFailureIsHarmless(): Promise<() => Promise<void>> {
  const f = fixture((agent, turnId) => {
    agent.emitEvent({
      kind: 'tool-call',
      server: MCP_SERVER_NAME,
      tool: 'list_mcp_resources',
      status: 'failed',
      undelivered: 'resources/list failed for `duetlens`: Mcp error: -32601: Method not found',
    });
    agent.emitEvent({ kind: 'turn-completed', turnId });
  });
  await f.session.start({ cwd: process.cwd(), providers: f.providers, round: 1 });
  assert.equal(f.agent.disposed, false, 'codex 自带工具探不到东西不是链路故障,本轮得照常跑完');
  log('✓ codex 自带探测工具失败 → 不判死本轮');
  return () => f.session.dispose();
}

async function main(): Promise<void> {
  everyApprovalIsASentinel();
  launchFailuresKeepTheirKind();
  silentApprovalTruthTable();
  for (const t of [
    unexpectedApprovalKillsRound,
    expectedApprovalIsHarmless,
    declinedMcpElicitationIsNotABreach,
    undeliveredMcpCallKillsRound,
    toolRejectionIsHarmless,
    builtinProbeFailureIsHarmless,
  ]) {
    const dispose = await t();
    await dispose(); // MCP server 不关,event loop 就一直醒着,进程退不了
  }
  log('全部通过');
}

main().catch((e) => {
  process.stderr.write(`[sandbox-guard] 失败: ${(e as Error).stack}\n`);
  process.exit(1);
});
