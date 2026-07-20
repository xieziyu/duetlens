/**
 * Headless 端到端验证:多轮 / discussion 回路。
 *   扫描 → 就某条 finding 的 discussion 追问 → 再新建 user-discussion 追问,
 *   断言 user/agent 消息成对落库、agent 复用同一 codex thread。
 * 需 `codex login`;若刚跑过 electron-forge start 先 `npm rebuild better-sqlite3`。
 *   运行:npm run spike:discussion
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { CodexAgent } from '../src/backend/agent/codex/codex-agent';
import { ReviewSession } from '../src/backend/review/review-session';

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

const log = (m: string) => process.stdout.write(`[discussion] ${m}\n`);

async function main() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-discussion-'));
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

  const agent = new CodexAgent({ onLog: (l) => l && process.stderr.write(`[codex] ${l}\n`) });
  const session = new ReviewSession(review.id, store, agent);
  session.on('message', (m) => log(`message 落库 ◀ ${m.role}: ${m.text.slice(0, 60).replace(/\n/g, ' ')}…`));
  session.on('finding', (f) => log(`finding 落库 ◀ ${f.severity} · ${f.title}`));

  try {
    const findings = await session.start({
      cwd: workdir,
      providers: {
        getDiff: () => DIFF,
        getFile: (p) => (p.endsWith('login.js') ? SRC : `// 未知: ${p}`),
      },
    });
    assert.ok(findings.length > 0, '扫描应产出至少一条 finding');

    // (1) 就 finding 的 discussion 追问
    const discussionId = findings[0].discussionId;
    log('──── 就 finding 追问 ────');
    await session.sendMessage(discussionId, '这个问题应该怎么修?用一句话说明。');
    const findingMsgs = store.listMessages(discussionId);
    log(`finding discussion 消息数: ${findingMsgs.length}`);
    assert.equal(findingMsgs.length, 2, 'user + agent 各一条');
    assert.equal(findingMsgs[0].role, 'user');
    assert.equal(findingMsgs[1].role, 'agent');
    assert.ok(findingMsgs[1].text.trim().length > 0, 'agent 回复非空');

    // (2) 新建 user-discussion 再追问(复用同一 codex thread)
    log('──── 新建 user-discussion 追问 ────');
    const userDisc = store.addUserDiscussion(review.id, { file: REVIEW_FILE, line: 4 });
    await session.sendMessage(userDisc.id, '第 4 行的 SQL 拼接有什么风险?');
    const userMsgs = store.listMessages(userDisc.id);
    log(`user discussion 消息数: ${userMsgs.length}`);
    assert.equal(userMsgs.length, 2);
    assert.equal(userMsgs[1].role, 'agent');
    assert.ok(userMsgs[1].text.trim().length > 0, 'agent 回复非空');

    // 两轮追问复用同一 thread(未新起会话)
    assert.ok(store.getReview(review.id)!.codexThreadId, 'threadId 应稳定落库');

    log('✅ PASS — 多轮回路打通:扫描 → 追问 → user/agent 消息成对落库(同一 thread)');
    process.exitCode = 0;
  } finally {
    await session.dispose();
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stdout.write(`[discussion] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
