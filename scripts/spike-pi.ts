/**
 * pi 适配层验证(见 docs/design/pi-integration.md)。走公开入口:PiAgent + ReviewSession,不另抄一份 RPC。
 *   运行:npm run spike:pi            跑 ro + s1(零 token)
 *        npm run spike:pi -- scan     一轮真实机审落库 + 续接(烧 token)
 *        npm run spike:pi -- stop     机审中途叫停(烧 token,用便宜模型)
 *        npm run spike:pi -- all      全部
 *
 * ro   只读判据的真值表(纯函数,正反两面)
 * s1   生命周期:起会话 / 握手里的工具集恰是 Duetlens 工具 / 空闲时点名旧 turn 不误伤 / 释放;
 *      extension 加载失败与续接找不到会话两条反例
 * scan ReviewSession 驱动 PiAgent 审一个带 bug 的改动,findings 落库,事件面该有的都有;之后按落库 id 续接
 * stop 扫描中途 stopScan:自编 turn id 点名打断,本轮以「已停止」收场而不是失败
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { DuetlensMcpServer } from '../src/backend/mcp/duetlens-mcp-server';
import { ReviewSession } from '../src/backend/review/review-session';
import {
  PiAgent,
  piErrorKind,
  piExtensionPath,
  unexpectedPiTools,
} from '../src/backend/agent/pi/pi-agent';
import { MCP_TOOL } from '../src/shared/mcp-contract';
import type { AgentEvent } from '../src/shared/agent-events';

const log = (m: string) => process.stdout.write(`[pi] ${m}\n`);

const REPO = path.resolve(__dirname, '..');
const EXTENSION = piExtensionPath({ packaged: false, resourcesPath: '', appPath: REPO });
/** 写全名不写别名:名字在 provider 上不存在时 pi 不报错,只给一轮空跑 */
const SCAN_MODEL = 'anthropic/claude-sonnet-5';
const STOP_MODEL = 'claude-haiku-4-5-20251001';
const onLog = (l: string) => l && process.stderr.write(`[pi-stderr] ${l}\n`);

const REVIEW_FILE = 'src/login.js';
const SRC = `const db = require('./db');

async function login(username, password) {
  const query = "SELECT * FROM users WHERE name = '" + username +
    "' AND pass = '" + password + "'";
  return (await db.query(query))[0];
}

module.exports = { login };
`;
const DIFF = `diff --git a/${REVIEW_FILE} b/${REVIEW_FILE}
new file mode 100644
--- /dev/null
+++ b/${REVIEW_FILE}
@@ -0,0 +1,10 @@
${SRC.split('\n').map((l) => '+' + l).join('\n')}`;

/** 每次跑用独立的会话目录,不往用户自己的 pi 会话列表里掺东西。 */
function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function roTruthTable(): void {
  log('--- ro 只读判据(零 token) ---');
  // 白名单只有 Duetlens 自己的工具:pi 的内置读工具不受仓库边界约束,同样算越界
  const allowed = [MCP_TOOL.reportFinding, MCP_TOOL.getDiff, MCP_TOOL.getFile];
  assert.deepEqual(unexpectedPiTools([...allowed], allowed), [], '全在白名单内应放行');
  assert.deepEqual(unexpectedPiTools([MCP_TOOL.getFile], allowed), [], '白名单的子集也放行');
  assert.deepEqual(unexpectedPiTools([MCP_TOOL.getFile, 'bash', 'edit'], allowed), ['bash', 'edit'], '混入写工具要逐个点名');
  assert.deepEqual(unexpectedPiTools([MCP_TOOL.getFile, 'read', 'grep'], allowed), ['read', 'grep'], '内置读工具也不放行');
  // 白名单而非黑名单的理由:叫不出名字的工具也得拦下
  assert.deepEqual(unexpectedPiTools([MCP_TOOL.getFile, 'deploy'], allowed), ['deploy'], '未知工具同样判出');
  log('白名单:放行 Duetlens 工具 ✓ / 拦下写工具 ✓ / 拦下内置读工具 ✓ / 拦下未知工具 ✓');

  assert.equal(piErrorKind('401 {"error":{"type":"authentication_error"}}'), 'unauthorized');
  assert.equal(piErrorKind('429 rate_limit_error'), 'usage-limit');
  assert.equal(piErrorKind('529 overloaded_error: Overloaded'), 'server-overloaded');
  assert.equal(piErrorKind('prompt is too long: 1200000 tokens'), 'context-exceeded');
  assert.equal(piErrorKind('fetch failed: ECONNRESET'), 'connection');
  assert.equal(piErrorKind('400 model: claude-nope not found'), 'bad-request');
  assert.equal(piErrorKind('something odd'), 'other');
  log('错误归因 ✓');
}

async function lifecycle(): Promise<void> {
  log('--- s1 生命周期(零 token) ---');
  const sessionDir = tempDir('duetlens-pi-sessions-');
  const mcp = new DuetlensMcpServer({ getDiff: () => '', getFile: () => '' });
  const mcpUrl = await mcp.listen();
  try {
    const agent = new PiAgent({ extensionPath: EXTENSION, sessionDir, onLog });
    const h = await agent.startConversation({ cwd: REPO, mcpUrl, mcpToken: mcp.token });
    assert.ok(h.conversationId, '没拿到会话 id');
    log(`起会话 ✓ id=${h.conversationId} model=${h.model ?? '(未回)'};握手里的工具集已过白名单`);
    // 叫停的快照已经过时(那一轮早收了):不能落成一次会话级 abort 去误伤下一轮
    await agent.interrupt(h.conversationId, 'pi-turn-stale');
    log('空闲时点名旧 turn → 不动手 ✓');
    agent.dispose();
    log('释放 ✓');

    const broken = new PiAgent({ extensionPath: path.join(REPO, 'no-such-extension.ts'), sessionDir, onLog });
    const t0 = Date.now();
    await assert.rejects(
      () => broken.startConversation({ cwd: REPO, mcpUrl, mcpToken: mcp.token }),
      /pi 没有完成握手/,
      'extension 加载失败应当在起会话时就报出来',
    );
    log(`extension 加载失败 → 起会话即报错 ✓(${Date.now() - t0}ms,没等满握手超时)`);

    const orphan = new PiAgent({ extensionPath: EXTENSION, sessionDir, onLog });
    await assert.rejects(
      () =>
        orphan.resumeConversation({
          conversationId: '00000000-0000-4000-8000-000000000000',
          cwd: REPO,
          mcpUrl,
          mcpToken: mcp.token,
        }),
      /找不到会话/,
      '--session-id 会静默新建空会话,续接必须把它认出来',
    );
    log('续接一个不存在的会话 → 拒绝 ✓');
  } finally {
    await mcp.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  log('s1 ✓');
}

function fixture(): { workdir: string; store: ReviewStore; reviewId: string } {
  const workdir = tempDir('duetlens-pi-review-');
  fs.mkdirSync(path.join(workdir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workdir, REVIEW_FILE), SRC);
  const store = new ReviewStore(openDatabase(':memory:'));
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'feature/login',
    repoPath: workdir,
    title: 'Add login',
  });
  return { workdir, store, reviewId: review.id };
}

const providers = {
  getDiff: () => DIFF,
  getFile: (p: string) => (p.endsWith('login.js') ? SRC : `// 未知: ${p}`),
};

async function scan(): Promise<void> {
  log('--- scan 一轮真实机审(烧 token) ---');
  const { workdir, store, reviewId } = fixture();
  const sessionDir = tempDir('duetlens-pi-sessions-');
  const kinds = new Set<string>();
  const tools: string[] = [];
  let usage: Extract<AgentEvent, { kind: 'token-usage' }> | undefined;

  const session = new ReviewSession(reviewId, store, new PiAgent({ extensionPath: EXTENSION, sessionDir, onLog }));
  session.on('finding', (f) => log(`finding 落库 ◀ ${f.severity} · ${f.title} @ ${f.file}:${f.line}`));
  session.on('status', (s) => log(`status → ${s}`));
  session.on('agent-event', (e) => {
    kinds.add(e.kind);
    if (e.kind === 'tool-call' && e.status === 'inProgress') tools.push(e.tool);
    if (e.kind === 'command' && e.status === 'inProgress') log(`  取证 ▶ ${e.command}`);
    if (e.kind === 'token-usage') usage = e;
  });

  try {
    const t0 = Date.now();
    await session.start({ cwd: workdir, providers, model: SCAN_MODEL });
    log(`一轮用时 ${Math.round((Date.now() - t0) / 1000)}s,工具:${tools.join(', ') || '无'}`);

    const review = store.getReview(reviewId)!;
    const persisted = store.listFindings(reviewId);
    assert.ok(persisted.length > 0, '一轮真实机审没有任何 finding 落库');
    assert.ok(tools.includes(MCP_TOOL.reportFinding), 'report_finding 没经桥调到');
    assert.ok(review.agentSessionId, '会话 id 应落库,续接要用');
    assert.equal(review.model, SCAN_MODEL, '实际生效的模型应回填');
    assert.ok(usage && usage.used > 0 && usage.total, `用量没有派生出来(${JSON.stringify(usage)})`);
    log(`落库 ${persisted.length} 条 ✓;用量 ${usage.used}/${usage.total} ✓;事件面:${[...kinds].sort().join(', ')}`);
    await session.dispose();

    // app 重启后的路径:新 agent、按落库 id 续接。续接本身不发 turn,不烧 token
    const resumed = new ReviewSession(reviewId, store, new PiAgent({ extensionPath: EXTENSION, sessionDir, onLog }));
    try {
      await resumed.resume({ cwd: workdir, providers });
      assert.equal(resumed.isOpen(), true, '续接后会话应当是开着的');
      log('按落库 id 续接 ✓');
    } finally {
      await resumed.dispose();
    }
  } finally {
    await session.dispose();
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  log('scan ✓');
}

async function stop(): Promise<void> {
  log('--- stop 中途叫停(烧 token) ---');
  const { workdir, store, reviewId } = fixture();
  const sessionDir = tempDir('duetlens-pi-sessions-');
  const session = new ReviewSession(reviewId, store, new PiAgent({ extensionPath: EXTENSION, sessionDir, onLog }));
  let busy!: () => void;
  const firstAction = new Promise<void>((r) => (busy = r));
  session.on('agent-event', (e) => {
    if ((e.kind === 'tool-call' || e.kind === 'command') && e.status === 'inProgress') busy();
  });
  try {
    const run = session.start({ cwd: workdir, providers, model: STOP_MODEL });
    await firstAction;
    const t0 = Date.now();
    await session.stopScan();
    await run;
    assert.equal(session.isStopped(), true, '打断成功就该算已停止');
    assert.notEqual(store.getReview(reviewId)!.status, 'failed', '叫停不是失败');
    log(`首个动作后叫停 → 已停止 ✓(abort 到收轮 ${Date.now() - t0}ms)`);
  } finally {
    await session.dispose();
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  log('stop ✓');
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (!only || only === 'ro' || only === 'all') roTruthTable();
  if (!only || only === 's1' || only === 'all') await lifecycle();
  if (only === 'scan' || only === 'all') await scan();
  if (only === 'stop' || only === 'all') await stop();
  log('全过 ✓');
}

main().catch((e: Error) => {
  process.stderr.write(`[pi] 失败:${e.stack ?? e.message}\n`);
  process.exitCode = 1;
});
