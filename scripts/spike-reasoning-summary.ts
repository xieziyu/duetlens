/**
 * Headless spike:**推理摘要能不能开出来**。
 *
 * 背景:203 次真实机审的 rollout 里 3963 条 reasoning,带 summary 的 0 条;同一台机器上
 * Codex Desktop 的会话是 58/478。model / effort / `summary: auto` 三者相同,差别在别处。
 * 本 spike 检验的假设是:**per-thread 注入 `model_reasoning_summary = "detailed"` 就能拿到**。
 *
 * 做的是 A/B 而不是单跑一次:同一 fixture、同一提示词跑两轮,只差这一个配置。
 * 只跑「开」那一轮的话,拿到摘要也分不清是配置生效还是这次模型碰巧愿意说 ——
 * 而基线正是「偶尔会说」(Codex Desktop 那 12%),单跑必然得出可疑结论。
 *
 * 需本机已 `codex login`(真跑模型,消耗 token;两轮,fixture 很小)。
 *   运行:npm run spike:reasoning
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../src/backend/agent/codex/codex-app-server';
import { CodexNotification } from '../src/backend/agent/codex/protocol';
import { DuetlensMcpServer } from '../src/backend/mcp/duetlens-mcp-server';
import { APP_VERSION } from '../src/shared/version';

const TURN_TIMEOUT_MS = 240_000;

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

// 与真实机审同形:有 MCP、要求上报 —— 摘要行为可能受任务形态影响,不能拿闲聊去测
const BASE_INSTRUCTIONS = `你是 Duetlens 的代码审核 agent。请审核本次改动并把发现的每个问题通过 duetlens MCP 的 report_finding 工具上报。
- 先调用 get_diff 查看改动。
- 对每个问题调用一次 report_finding,锚定到 file 与新侧 line。
- 只审核、不修改代码。审完简短总结。`;

function log(tag: string, msg: string) {
  process.stdout.write(`[${tag}] ${msg}\n`);
}

interface Observed {
  /** item/reasoning/summaryTextDelta 的条数与总字数 —— 流式摘要到没到货看它 */
  deltas: number;
  deltaChars: number;
  /** item/reasoning/summaryPartAdded 的条数 */
  parts: number;
  /** item/completed 里 reasoning item 的总数,以及其中 summary 非空的个数 */
  reasoningItems: number;
  withSummary: number;
  /** 首段摘要原文(截断),用于肉眼确认拿到的是人话不是空串 */
  sample: string | null;
  /** 本轮真的在审代码的凭据:MCP 收到的 report_finding 条数 */
  findings: number;
}

async function runTurn(label: string, reasoningSummary: string | null): Promise<Observed> {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-reasoning-'));
  mkdirSync(path.join(workdir, 'src'), { recursive: true });
  writeFileSync(path.join(workdir, REVIEW_FILE), REVIEW_SOURCE);

  const observed: Observed = {
    deltas: 0,
    deltaChars: 0,
    parts: 0,
    reasoningItems: 0,
    withSummary: 0,
    sample: null,
    findings: 0,
  };

  const mcp = new DuetlensMcpServer({
    getDiff: () => REVIEW_DIFF,
    getFile: (p) => (p.endsWith('login.js') ? REVIEW_SOURCE : `// 未知文件: ${p}`),
  });
  mcp.on('finding', () => observed.findings++);
  const mcpUrl = await mcp.listen();

  const codex = new CodexAppServer({ cwd: workdir, trustedMcpServers: ['duetlens'] });
  // MCP server 一律校验 bearer(见 DuetlensMcpServer),令牌不给就是每次工具调用 401 ——
  // agent 会转去瞎试别的路子,那样跑出来的 reasoning 不是真实机审的形状。

  const turnDone = new Promise<void>((resolve) => {
    codex.on('notification', (method: string, params: unknown) => {
      switch (method) {
        case CodexNotification.reasoningSummaryDelta: {
          const d = String((params as { delta?: string }).delta ?? '');
          observed.deltas++;
          observed.deltaChars += d.length;
          if (!observed.sample && d.trim()) observed.sample = d.trim().slice(0, 90);
          break;
        }
        case CodexNotification.reasoningSummaryPartAdded:
          observed.parts++;
          break;
        case CodexNotification.itemCompleted: {
          const item = (params as { item?: { type?: string; summary?: unknown[] } }).item;
          if (item?.type !== 'reasoning') break;
          observed.reasoningItems++;
          const summary = Array.isArray(item.summary) ? item.summary : [];
          if (summary.length) {
            observed.withSummary++;
            if (!observed.sample) {
              const first = summary[0];
              const text = typeof first === 'string' ? first : String((first as { text?: string })?.text ?? '');
              if (text.trim()) observed.sample = text.trim().slice(0, 90);
            }
          }
          break;
        }
        case CodexNotification.turnCompleted:
          resolve();
          break;
      }
    });
  });

  codex.start({ DUETLENS_MCP_TOKEN: mcp.token });
  try {
    await codex.initialize({ name: 'duetlens', version: APP_VERSION });
    // 只有这一个键不同 —— A/B 的全部差异所在
    const config: Record<string, unknown> = {
      mcp_servers: { duetlens: { url: mcpUrl, bearer_token_env_var: 'DUETLENS_MCP_TOKEN' } },
    };
    if (reasoningSummary) config.model_reasoning_summary = reasoningSummary;

    const thread = await codex.threadStart({
      cwd: workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: BASE_INSTRUCTIONS,
      config,
    });
    log(label, `thread/start → ${thread.thread.id}(codex ${thread.thread.cliVersion ?? '?'})`);

    await codex.turnStart({
      threadId: thread.thread.id,
      input: [{ type: 'text', text: '请审核本次改动,对每个问题调用 report_finding 上报。' }],
    });
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
  return observed;
}

function report(label: string, o: Observed) {
  log('RESULT', `${label}`);
  log('RESULT', `  reasoning item ${o.reasoningItems} 条,其中 summary 非空 ${o.withSummary} 条`);
  log('RESULT', `  summaryTextDelta ${o.deltas} 条 / ${o.deltaChars} 字,summaryPartAdded ${o.parts} 条`);
  log('RESULT', `  摘要样例:${o.sample ?? '(无)'}`);
  log('RESULT', `  本轮 report_finding:${o.findings} 条${o.findings ? '' : ' ← 这轮没在正常审代码,结论要打折'}`);
}

async function main() {
  log('SPIKE', '两轮真跑,只差 model_reasoning_summary 一个配置。');

  log('SPIKE', '① 对照组:不注入(= 现在 Duetlens 的行为)');
  const control = await runTurn('control', null);

  log('SPIKE', '② 实验组:注入 model_reasoning_summary = "detailed"');
  const detailed = await runTurn('detailed', 'detailed');

  log('RESULT', '─'.repeat(56));
  report('对照组(不注入)', control);
  log('RESULT', '─'.repeat(56));
  report('实验组(detailed)', detailed);
  log('RESULT', '─'.repeat(56));

  // 判据是**流式摘要到没到货**:UI 要的是边跑边报,拿到落库 item 才有摘要等于晚了一整轮
  const gotLive = detailed.deltas > 0;
  const controlGot = control.deltas > 0 || control.withSummary > 0;
  if (gotLive && !controlGot) {
    log('RESULT', '✅ 配置有效 —— 注入后拿到流式摘要,不注入则没有。可以据此做「agent 在想什么」。');
  } else if (gotLive && controlGot) {
    log('RESULT', '⚠️ 两组都有 —— 差别不在这个配置,别把它当开关;要另找 0/3963 的成因。');
  } else if (!gotLive && detailed.withSummary > 0) {
    log('RESULT', '⚠️ 只有落库 item 带摘要、没有流式增量 —— 拿不到实时播报,只能事后补,不值得做。');
  } else {
    log('RESULT', '❌ 配置无效 —— 注入 detailed 仍拿不到摘要。「agent 在想什么」这条路当前走不通。');
  }
  process.exit(0);
}

main().catch((e) => {
  log('FATAL', (e as Error).message);
  process.exit(1);
});
