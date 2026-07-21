/**
 * Headless 验证手动新增 finding:ReviewManager.addManualFinding 落库(origin=manual)
 * + 建承载 discussion + 外发 finding/discussion 事件。不烧 token。运行:npm run spike:add-finding
 * ABI 注意:跑过 electron-forge start 后先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import type { ReviewEvent } from '../src/shared/ipc';

function log(msg: string) {
  process.stdout.write(`[add-finding] ${msg}\n`);
}

function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const manager = new ReviewManager(store);
  const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', title: 't' });

  const events: ReviewEvent[] = [];
  manager.on('review-event', (e: ReviewEvent) => events.push(e));

  const f = manager.addManualFinding(review.id, {
    file: 'src/a.ts',
    line: 42,
    severity: 'high',
    category: 'Security',
    title: '手动提出:未校验输入',
    body: '这里直接拼接用户输入。',
    suggestion: 'sanitize(input)',
  });

  // 落库 + origin=manual + 字段
  assert.equal(f.origin, 'manual');
  assert.equal(f.triage, 'open');
  assert.equal(f.submission, 'unsubmitted');
  assert.equal(f.file, 'src/a.ts');
  assert.equal(f.line, 42);
  assert.equal(store.getFinding(f.id)!.title, '手动提出:未校验输入');
  log('落库 + origin=manual + 字段 ok');

  // 建了承载 discussion(kind=finding, origin=manual),供后续追问
  const disc = store.getDiscussion(f.discussionId);
  assert.ok(disc, 'finding 应带一条承载 discussion');
  assert.equal(disc!.kind, 'finding');
  assert.equal(disc!.origin, 'manual');
  assert.equal(disc!.file, 'src/a.ts');
  log('承载 discussion ok');

  // 外发 finding + discussion 两事件
  assert.ok(
    events.some((e) => e.type === 'finding' && (e.payload as { id: string }).id === f.id),
    'finding 事件',
  );
  assert.ok(
    events.some((e) => e.type === 'discussion' && (e.payload as { id: string }).id === f.discussionId),
    'discussion 事件',
  );
  log('事件回推 ok');

  // 出现在 listFindings,可进 triage/提交管线(与 agent finding 同路径)
  assert.ok(store.listFindings(review.id).some((x) => x.id === f.id));
  manager.setTriage(review.id, f.id, 'dismiss');
  assert.equal(store.getFinding(f.id)!.triage, 'dismiss');
  log('同 triage 管线 ok');

  // body 缺省 → 空串;suggestion 缺省 → null
  const f2 = manager.addManualFinding(review.id, {
    file: 'src/b.ts',
    line: 1,
    severity: 'low',
    title: '仅标题',
  });
  assert.equal(f2.body, '');
  assert.equal(f2.suggestion, null);
  assert.equal(f2.category, null);
  log('缺省字段 ok');

  log('────────────────────────');
  log('✅ PASS — 手动新增 finding:落库/origin/承载 discussion/事件/管线/缺省全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[add-finding] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
