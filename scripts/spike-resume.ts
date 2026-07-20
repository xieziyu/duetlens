/**
 * Headless 端到端验证:thread/resume 续接。
 *   session1 扫描 → 落 findings + codexThreadId → dispose(模拟 app 重启,codex 子进程退出)。
 *   session2(全新 CodexAgent)按落库的 threadId 从磁盘续接 → 追问 → agent 复用同一 thread 回答。
 * 需 `codex login`;若刚跑过 electron-forge start 先 `npm rebuild better-sqlite3`。
 *   运行:npm run spike:resume
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

const providers = {
  getDiff: () => DIFF,
  getFile: (p: string) => (p.endsWith('login.js') ? SRC : `// 未知: ${p}`),
};

const log = (m: string) => process.stdout.write(`[resume] ${m}\n`);

async function main() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-resume-'));
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

  // ---- session1:扫描,拿到 threadId,然后 dispose(模拟重启)----
  const agent1 = new CodexAgent({ onLog: (l) => l && process.stderr.write(`[codex1] ${l}\n`) });
  const session1 = new ReviewSession(review.id, store, agent1);
  let findings;
  try {
    findings = await session1.start({ cwd: workdir, providers });
    assert.ok(findings.length > 0, '扫描应产出 finding');
  } finally {
    await session1.dispose();
  }
  const threadId = store.getReview(review.id)!.codexThreadId!;
  log(`session1 扫描完成:${findings.length} findings,threadId=${threadId.slice(0, 8)}… 已 dispose`);

  // ---- session2:全新 agent,按 threadId 续接 ----
  const agent2 = new CodexAgent({ onLog: (l) => l && process.stderr.write(`[codex2] ${l}\n`) });
  const session2 = new ReviewSession(review.id, store, agent2);
  session2.on('message', (m) => log(`message 落库 ◀ ${m.role}: ${m.text.slice(0, 70).replace(/\n/g, ' ')}…`));
  try {
    log('──── 续接 thread ────');
    const resumed = await session2.resume({ cwd: workdir, providers });
    assert.equal(resumed.length, findings.length, '续接后应看到同样的 findings');

    // 追问一个需要「记得扫描历史」才能答的问题
    const discussionId = findings[0].discussionId;
    log('──── 续接后追问(考察 thread 记忆)────');
    await session2.sendMessage(discussionId, '你之前上报的第一个 finding 是关于什么的?用一句话复述。');
    const msgs = store.listMessages(discussionId);
    log(`discussion 消息数: ${msgs.length}`);
    assert.equal(msgs.length, 2, 'user + agent 各一条');
    assert.equal(msgs[1].role, 'agent');
    assert.ok(msgs[1].text.trim().length > 0, 'agent 回复非空');

    log('✅ PASS — thread/resume 打通:重启后按 threadId 续接、复用会话记忆追问');
    process.exitCode = 0;
  } finally {
    await session2.dispose();
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stdout.write(`[resume] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
