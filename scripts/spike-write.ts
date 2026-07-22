/**
 * Headless 验证 finding 写路径:ReviewManager.setTriage / updateFinding 落库 + emit review-event。
 * 不烧 token(不起 codex)。运行:npm run spike:write
 * ABI 注意:若之前跑过 electron-forge start,先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import type { ReviewEvent } from '../src/shared/ipc';

function log(msg: string) {
  process.stdout.write(`[write] ${msg}\n`);
}

function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const manager = new ReviewManager(store);

  const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', title: 't' });
  const f = store.addFinding(review.id, {
    severity: 'medium',
    category: 'Naming',
    title: '命名可读性差',
    body: 'c 改名',
    file: 'src/a.ts',
    line: 3,
    suggestion: undefined,
  });
  assert.equal(f.triage, 'open');

  const events: ReviewEvent[] = [];
  manager.on('review-event', (e: ReviewEvent) => events.push(e));

  // triage: 剔除 → 恢复(open)
  const dropped = manager.setTriage(review.id, f.id, 'dismiss');
  assert.equal(dropped.triage, 'dismiss');
  assert.equal(store.getFinding(f.id)!.triage, 'dismiss');
  const kept = manager.setTriage(review.id, f.id, 'open');
  assert.equal(kept.triage, 'open');
  log('setTriage dismiss→open 落库 + 返回一致');

  // 就地编辑:改 severity/title/body,开 suggestion
  const edited = manager.updateFinding(review.id, {
    findingId: f.id,
    severity: 'high',
    title: '命名可读性差(建议 completedCount)',
    body: 'c 统计已完成分片数',
    suggestion: 'const completedCount = 0;',
  });
  assert.equal(edited.severity, 'high');
  assert.match(edited.title, /completedCount/);
  assert.equal(edited.suggestion, 'const completedCount = 0;');
  assert.equal(edited.triage, 'open', '编辑不应重置 triage');
  log('updateFinding 改字段 + 保留 triage');

  // 清空 suggestion(null)
  const cleared = manager.updateFinding(review.id, { findingId: f.id, suggestion: null });
  assert.equal(cleared.suggestion, null);

  // 每次写都应外发一条 finding 事件(setTriage×2 + updateFinding×2 = 4)
  const findingEvents = events.filter((e) => e.type === 'finding' && e.reviewId === review.id);
  assert.equal(findingEvents.length, 4, `期望 4 条 finding 事件,实得 ${findingEvents.length}`);
  log(`review-event 外发 ${findingEvents.length} 条 finding`);

  // 不存在的 finding 应抛错
  assert.throws(() => manager.setTriage(review.id, 'nope', 'open'));
  log('未知 findingId 抛错');

  log('────────────────────────');
  log('✅ PASS — finding 写路径落库 + 事件外发全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[write] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
