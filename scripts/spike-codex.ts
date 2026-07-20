/**
 * Headless spike:端到端验证 Duetlens ↔ codex app-server 的协同回路。
 *   起 in-process HTTP MCP → spawn codex app-server → thread/start(注入 MCP + read-only)
 *   → turn/start → 观测 codex 调 report_finding 双向可见 → 断言。
 *
 * 需本机已 `codex login`(真跑模型,消耗 token)。
 *   运行:npm run spike:codex
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../src/backend/agent/codex/CodexAppServer';
import { CodexNotification, type McpToolCallItem } from '../src/backend/agent/codex/protocol';
import { DuetlensMcpServer, type ReportedFinding } from '../src/backend/mcp/DuetlensMcpServer';

const TURN_TIMEOUT_MS = 180_000;

// ---- 1. fixture:一个含明显 bug 的改动 ----
const REVIEW_FILE = 'src/login.js';
const REVIEW_SOURCE = `const db = require('./db');

// 校验用户登录
async function login(username, password) {
  const query = "SELECT * FROM users WHERE name = '" + username +
    "' AND pass = '" + password + "'";
  const rows = await db.query(query);
  return rows[0];
}

module.exports = { login };
`;
const REVIEW_DIFF = `diff --git a/${REVIEW_FILE} b/${REVIEW_FILE}
new file mode 100644
--- /dev/null
+++ b/${REVIEW_FILE}
@@ -0,0 +1,11 @@
${REVIEW_SOURCE.split('\n')
  .map((l) => '+' + l)
  .join('\n')}`;

const BASE_INSTRUCTIONS = `你是 Duetlens 的代码审核 agent。请审核本次改动并把发现的每个问题通过 duetlens MCP 的 report_finding 工具上报。
- 先调用 get_diff 查看改动。
- 对每个问题调用一次 report_finding,锚定到 file 与新侧 line,给出 severity(high/medium/low)、category、title、body。
- 只审核、不修改代码。审完简短总结。`;

function log(tag: string, msg: string) {
  process.stdout.write(`[${tag}] ${msg}\n`);
}

async function main() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-spike-'));
  mkdirSync(path.join(workdir, 'src'), { recursive: true });
  writeFileSync(path.join(workdir, REVIEW_FILE), REVIEW_SOURCE);

  const observed = {
    mcpToolCalls: [] as string[],
    startupStatus: [] as string[],
    elicitations: 0,
    findings: [] as ReportedFinding[],
    turnFailed: null as string | null,
  };

  // ---- 2. in-process HTTP MCP ----
  const mcp = new DuetlensMcpServer({
    getDiff: () => REVIEW_DIFF,
    getFile: (p) => (p.endsWith('login.js') ? REVIEW_SOURCE : `// 未知文件: ${p}`),
  });
  mcp.on('finding', (f: ReportedFinding) => {
    observed.findings.push(f);
    log('MCP', `report_finding ◀ ${f.severity} · ${f.title} @ ${f.file}:${f.line}`);
  });
  const mcpUrl = await mcp.listen();
  log('MCP', `listening ${mcpUrl}`);

  // ---- 3. codex app-server ----
  const codex = new CodexAppServer({
    cwd: workdir,
    trustedMcpServers: ['duetlens'],
    onLog: (l) => l && log('codex.stderr', l),
  });

  const turnDone = new Promise<void>((resolve) => {
    codex.on('notification', (method: string, params: unknown) => {
      switch (method) {
        case CodexNotification.mcpServerStartupStatus: {
          const s = (params as { status?: string }).status ?? JSON.stringify(params);
          observed.startupStatus.push(s);
          log('codex', `mcpServer startup: ${s}`);
          break;
        }
        case CodexNotification.itemStarted:
        case CodexNotification.itemCompleted: {
          const item = (params as { item?: { type?: string } }).item;
          if (item?.type === 'mcpToolCall') {
            const t = item as McpToolCallItem;
            const label = `${t.server}/${t.tool}:${t.status}`;
            observed.mcpToolCalls.push(label);
            log('codex', `item/${method === CodexNotification.itemStarted ? 'started' : 'completed'} ▶ mcpToolCall ${label}`);
          }
          break;
        }
        case CodexNotification.turnCompleted:
          log('codex', 'turn/completed');
          resolve();
          break;
        case CodexNotification.turnStarted:
          log('codex', 'turn/started');
          break;
      }
    });
  });

  codex.on('elicitation', (p: { serverName: string }, action: string) => {
    observed.elicitations++;
    log('codex', `elicitation ◀ server=${p.serverName} → ${action}`);
  });
  codex.on('unexpected-approval', (method: string) =>
    log('codex', `⚠ 意外反向审批: ${method} → denied`),
  );

  codex.start();

  try {
    await codex.initialize({ name: 'duetlens', version: '2.0.0-dev' });
    log('codex', 'initialized');

    const thread = await codex.threadStart({
      cwd: workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: BASE_INSTRUCTIONS,
      config: { mcp_servers: { duetlens: { url: mcpUrl } } },
    });
    log('codex', `thread/start → ${thread.thread.id}`);

    const turn = await codex.turnStart({
      threadId: thread.thread.id,
      input: [{ type: 'text', text: '请审核本次改动,对每个问题调用 report_finding 上报。' }],
    });
    log('codex', `turn/start → ${turn.turn.id} (${turn.turn.status})`);

    await Promise.race([
      turnDone,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error(`turn 超时 ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS),
      ),
    ]);
  } finally {
    codex.stop();
    await mcp.close();
    rmSync(workdir, { recursive: true, force: true });
  }

  // ---- 4. 断言与结论 ----
  log('RESULT', '─'.repeat(48));
  log('RESULT', `mcpServer startup 事件: ${observed.startupStatus.join(', ') || '(无)'}`);
  log('RESULT', `elicitation 自动 accept 次数: ${observed.elicitations}`);
  log('RESULT', `codex 侧 mcpToolCall item: ${observed.mcpToolCalls.length} 次 [${observed.mcpToolCalls.join(', ')}]`);
  log('RESULT', `MCP 侧收到 report_finding: ${observed.findings.length} 条`);
  for (const f of observed.findings) log('RESULT', `  · ${f.severity} ${f.title} @ ${f.file}:${f.line}`);

  // 权威判据:我们自建的 MCP server 真实收到了 report_finding 调用
  //(codex 不经回路无法调到本工具);codex 侧 item 流为佐证。
  const authoritative = observed.findings.length > 0;
  const corroborated = observed.mcpToolCalls.some((c) => c.startsWith('duetlens/'));

  log('RESULT', '─'.repeat(48));
  if (authoritative) {
    log('RESULT', `✅ PASS — report_finding 回路打通(MCP 权威收到 ${observed.findings.length} 条)`);
    log('RESULT', `   佐证:codex 侧 mcpToolCall item 流${corroborated ? '一致可见' : '未解析到(仅影响佐证,不影响结论)'}`);
  } else {
    log('RESULT', '❌ FAIL — MCP 侧未收到任何 report_finding');
  }
  process.exit(authoritative ? 0 : 1);
}

main().catch((e) => {
  log('FATAL', (e as Error).stack ?? String(e));
  process.exit(1);
});
