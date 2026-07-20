/**
 * Headless 端到端垂直验证:ReviewSession(CodexAgent + 自建 MCP + sqlite)。
 *   起真实 codex 审一个含 bug 的改动 → findings 经 MCP 落进 store。
 * 需 `codex login`;若刚跑过 electron-forge start 先 `npm rebuild better-sqlite3`。
 *   运行:npm run spike:review
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/ReviewStore';
import { CodexAgent } from '../src/backend/agent/codex/CodexAgent';
import { ReviewSession } from '../src/backend/review/ReviewSession';

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

const log = (m: string) => process.stdout.write(`[review] ${m}\n`);

async function main() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-review-'));
  mkdirSync(path.join(workdir, 'src'), { recursive: true });
  writeFileSync(path.join(workdir, REVIEW_FILE), SRC);

  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'feature/login',
    repoPath: workdir,
    title: 'Add login',
  });
  log(`review ${review.id} 建立`);

  const agent = new CodexAgent({ onLog: (l) => l && process.stderr.write(`[codex] ${l}\n`) });
  const session = new ReviewSession(review.id, store, agent);

  session.on('finding', (f) => log(`finding 落库 ◀ ${f.severity} · ${f.title} @ ${f.file}:${f.line}`));
  session.on('status', (s) => log(`status → ${s}`));
  session.on('agent-event', (e) => {
    if (e.kind === 'tool-call') log(`agent tool-call ▶ ${e.server}/${e.tool}:${e.status}`);
    if (e.kind === 'token-usage') log(`token-usage ${e.used}${e.total ? '/' + e.total : ''}`);
  });

  try {
    const findings = await session.start({
      cwd: workdir,
      providers: {
        getDiff: () => DIFF,
        getFile: (p) => (p.endsWith('login.js') ? SRC : `// 未知: ${p}`),
      },
    });

    // 权威断言:findings 真的落进了 sqlite
    const persisted = store.listFindings(review.id);
    log('────────────────────────');
    log(`session 返回 findings: ${findings.length};store 持久化: ${persisted.length}`);
    log(`review 状态: ${store.getReview(review.id)!.status}`);
    log(`codex threadId 已存: ${store.getReview(review.id)!.codexThreadId ? 'yes' : 'no'}`);

    assert.ok(persisted.length > 0, 'store 应至少有一条 finding');
    assert.equal(findings.length, persisted.length);
    assert.equal(store.getReview(review.id)!.status, 'reviewing');
    assert.ok(store.getReview(review.id)!.codexThreadId, 'threadId 应落库');
    for (const f of persisted) {
      assert.equal(f.origin, 'agent');
      assert.equal(f.triage, 'open');
      assert.ok(f.discussionId, 'finding 应挂 discussion');
    }
    log('✅ PASS — 垂直回路打通:codex 审核 → MCP → sqlite 落库');
    process.exitCode = 0;
  } finally {
    await session.dispose();
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stdout.write(`[review] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
