/**
 * Headless 验证 discussion→finding 提升(:memory:)。运行:npm run spike:promote
 * ABI 注意:若之前跑过 electron-forge start,先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';

function log(msg: string) {
  process.stdout.write(`[promote] ${msg}\n`);
}

function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);

  const review = store.createReview({ source: 'local-branch', sourceRef: 'feat/x', title: 'promote' });

  // 用户发起一条锚定 discussion + 一轮对话
  const disc = store.addUserDiscussion(review.id, { file: 'src/a.ts', line: 12 });
  assert.equal(disc.kind, 'user');
  store.addMessage(disc.id, 'user', '这里 done += 1 在并发下会不会丢更新?想听 codex 意见。');
  store.addMessage(disc.id, 'agent', '会;done 被多个 task 共享写,需要原子类型。');

  // 提升为 finding
  const finding = store.promoteDiscussion(disc.id, { severity: 'medium', title: '这里 done += 1 并发下会丢更新' });
  assert.equal(finding.origin, 'promoted');
  assert.equal(finding.discussionId, disc.id, 'finding 应挂在原 discussion 上');
  assert.equal(finding.file, 'src/a.ts');
  assert.equal(finding.line, 12);
  assert.equal(finding.triage, 'open');
  assert.equal(finding.submission, 'unsubmitted');
  log('提升生成 finding(origin=promoted、锚点沿用 discussion)ok');

  // discussion 翻转为 finding kind,且会话历史保留
  const flipped = store.getDiscussion(disc.id)!;
  assert.equal(flipped.kind, 'finding');
  assert.equal(flipped.origin, 'promoted');
  assert.equal(store.getFindingByDiscussion(disc.id)!.id, finding.id);
  assert.equal(store.listMessages(disc.id).length, 2, '提升后原对话历史应保留');
  log('discussion 翻转 kind + 会话历史保留 ok');

  // findings 列表可见 + 数量正确
  assert.equal(store.listFindings(review.id).length, 1);

  // 重复提升 / 无锚点提升应报错
  assert.throws(() => store.promoteDiscussion(disc.id, { severity: 'low', title: 'x' }), /已是 finding/);
  const bare = store.addUserDiscussion(review.id, { file: '', line: 0 });
  db.prepare('UPDATE discussions SET file = NULL, line = NULL WHERE id = ?').run(bare.id);
  assert.throws(() => store.promoteDiscussion(bare.id, { severity: 'low', title: 'x' }), /无代码锚点/);
  assert.throws(() => store.promoteDiscussion('nope', { severity: 'low', title: 'x' }), /不存在/);
  log('重复/无锚点/未知 id 提升报错 ok');

  log('────────────────────────');
  log('✅ PASS — discussion→finding 提升(锚点/历史/翻转/守卫)全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[promote] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
