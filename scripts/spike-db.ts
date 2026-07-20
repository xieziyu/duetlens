/**
 * Headless 验证 sqlite 持久化层(:memory:)。运行:npm run spike:db
 * ABI 注意:若之前跑过 electron-forge start,先 `npm rebuild better-sqlite3`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/ReviewStore';

function log(msg: string) {
  process.stdout.write(`[db] ${msg}\n`);
}

function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);

  // 建 review
  const review = store.createReview({
    source: 'github-pr',
    sourceRef: 'https://github.com/acme/repo/pull/42',
    title: 'Fix login',
  });
  assert.equal(review.status, 'scanning');
  assert.ok(review.id);
  log(`review 建立 ${review.id} (${review.status})`);

  store.setCodexThreadId(review.id, '019f-thread');
  store.setReviewStatus(review.id, 'reviewing');
  assert.equal(store.getReview(review.id)!.codexThreadId, '019f-thread');
  assert.equal(store.getReview(review.id)!.status, 'reviewing');

  // agent 上报两条 finding(模拟 report_finding ingress)
  const f1 = store.addFinding(review.id, {
    severity: 'high',
    category: 'security',
    title: 'SQL 注入',
    body: '用户输入拼接进 SQL',
    file: 'src/login.js',
    line: 5,
  });
  const f2 = store.addFinding(review.id, {
    severity: 'medium',
    category: 'security',
    title: '密码字段暴露',
    body: '返回体含 pass',
    file: 'src/login.js',
    line: 8,
    suggestion: 'return { id: rows[0].id }',
  });
  assert.equal(f1.triage, 'open');
  assert.equal(f1.submission, 'unsubmitted');
  assert.ok(f1.discussionId, 'finding 应挂一条 discussion');
  log(`两条 finding 落库 (${f1.severity}/${f2.severity})`);

  // triage + 就地编辑(update_finding 同路径)
  store.setTriage(f1.id, 'keep');
  store.setTriage(f2.id, 'dismiss');
  const edited = store.updateFinding({ findingId: f1.id, severity: 'high', title: 'SQL 注入(可绕过认证)' });
  assert.equal(edited!.title, 'SQL 注入(可绕过认证)');
  assert.equal(store.getFinding(f1.id)!.triage, 'keep');
  log('triage + updateFinding 生效');

  // finding 的 discussion 上追问
  const msg = store.addMessage(f1.discussionId, 'user', '这个在生产会怎样?');
  store.addMessage(f1.discussionId, 'agent', '可构造 payload 绕过口令校验。');
  assert.equal(store.listMessages(f1.discussionId).length, 2);
  assert.equal(store.listMessages(f1.discussionId)[0].id, msg.id);
  log('discussion 追问 2 条');

  // 提交回填
  store.setSubmission(f1.id, 'submitted', 'https://github.com/acme/repo/pull/42#discussion_r1');
  const submitted = store.getFinding(f1.id)!;
  assert.equal(submitted.submission, 'submitted');
  assert.match(submitted.submittedUrl!, /discussion_r1$/);

  // 列表与计数
  const all = store.listFindings(review.id);
  assert.equal(all.length, 2);
  const kept = all.filter((f) => f.triage === 'keep').length;
  log(`listFindings=${all.length}, keep=${kept}`);

  // UI 设置默认值 + 持久化往返
  assert.equal(store.getUiSettings().dataMode, 'dark');
  store.saveUiSettings({ ...store.getUiSettings(), dataMode: 'light', leftWidth: 300 });
  assert.equal(store.getUiSettings().dataMode, 'light');
  assert.equal(store.getUiSettings().leftWidth, 300);
  log('ui_settings 默认 + 往返 ok');

  // 级联删除:删 review 应清空其 findings/discussions/messages
  db.prepare('DELETE FROM reviews WHERE id = ?').run(review.id);
  assert.equal(store.listFindings(review.id).length, 0);
  assert.equal(store.listMessages(f1.discussionId).length, 0);
  log('级联删除 ok');

  log('────────────────────────');
  log('✅ PASS — 持久化层读写/迁移/级联全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[db] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
