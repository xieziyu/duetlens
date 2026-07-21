/**
 * Headless 验证 per-review UI 进度态持久化(:memory:)。运行:npm run spike:ui-state
 * ABI 注意:若之前跑过 electron-forge start,先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';

function log(msg: string) {
  process.stdout.write(`[ui-state] ${msg}\n`);
}

function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);

  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'feat/x',
    title: 'per-review ui state',
  });

  // 无记录 → 默认空态
  const empty = store.getReviewUiState(review.id);
  assert.deepEqual(empty.viewedFiles, []);
  assert.equal(empty.lastActiveTab, null);
  log('无记录返回默认空态 ok');

  // 写入 + 往返
  store.saveReviewUiState(review.id, {
    viewedFiles: ['src/a.ts', 'src/b.ts'],
    lastActiveTab: null,
  });
  const got = store.getReviewUiState(review.id);
  assert.deepEqual(got.viewedFiles, ['src/a.ts', 'src/b.ts']);
  log('viewedFiles 往返 ok');

  // upsert:同 review_id 覆盖而非重复插入
  store.saveReviewUiState(review.id, { viewedFiles: ['src/a.ts'], lastActiveTab: 'findings' });
  const after = store.getReviewUiState(review.id);
  assert.deepEqual(after.viewedFiles, ['src/a.ts']);
  assert.equal(after.lastActiveTab, 'findings');
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM review_ui_state WHERE review_id = ?')
    .get(review.id) as { n: number };
  assert.equal(rows.n, 1, 'upsert 应保持单行');
  log('upsert 覆盖 + 单行 ok');

  // 损坏 JSON 降级为空(不抛)
  db.prepare('UPDATE review_ui_state SET viewed_files = ? WHERE review_id = ?').run(
    'not-json',
    review.id,
  );
  assert.deepEqual(store.getReviewUiState(review.id).viewedFiles, []);
  log('损坏 JSON 降级为空 ok');

  // 级联删除:删 review 应清空其 ui state
  store.saveReviewUiState(review.id, { viewedFiles: ['src/a.ts'], lastActiveTab: null });
  db.prepare('DELETE FROM reviews WHERE id = ?').run(review.id);
  const n = db
    .prepare('SELECT COUNT(*) AS n FROM review_ui_state WHERE review_id = ?')
    .get(review.id) as { n: number };
  assert.equal(n.n, 0, '级联删除应清空 review_ui_state');
  log('级联删除 ok');

  log('────────────────────────');
  log('✅ PASS — per-review UI 态读写/默认/upsert/降级/级联全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[ui-state] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
