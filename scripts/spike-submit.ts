/**
 * Headless 验证 GitHub 提交路径:payload 组装 + ReviewManager.submitReview 的
 * success/invalid/failed 状态流转(注入假 submitter,不烧真 PR、不碰网络)。
 * 运行:npm run spike:submit  · ABI:跑过 electron-forge start 后先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { buildPrReviewPayload } from '../src/shared/github-review';
import type { GitHubSubmitter } from '../src/backend/review/github-submitter';
import type { PrReviewPayload } from '../src/shared/github-review';
import type { Review } from '../src/shared/domain';
import type { ReviewEvent, SubmitReviewResult } from '../src/shared/ipc';

function log(msg: string) {
  process.stdout.write(`[submit] ${msg}\n`);
}

/** 记录最后一次收到的 payload,并按预设返回结果。 */
class FakeSubmitter implements GitHubSubmitter {
  last?: { review: Review; payload: PrReviewPayload };
  constructor(private readonly result: SubmitReviewResult) {}
  async submit(review: Review, payload: PrReviewPayload): Promise<SubmitReviewResult> {
    this.last = { review, payload };
    return this.result;
  }
}

function seed(store: ReviewStore) {
  const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#7', title: 't' });
  store.setReviewSummary(review.id, '整体方向 OK,收口并发。');
  const f1 = store.addFinding(review.id, {
    severity: 'high',
    category: 'Correctness',
    title: '数据竞争',
    body: '用 Atomic 替代。',
    file: 'src/p.ts',
    line: 20,
    suggestion: 'const c = new Atomic(0);',
  });
  const f2 = store.addFinding(review.id, {
    severity: 'low',
    category: 'Naming',
    title: '命名差',
    body: '',
    file: 'src/p.ts',
    line: 22,
  });
  return { review, f1, f2 };
}

async function main() {
  // ---- payload 组装(纯函数)----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const { review, f1, f2 } = seed(store);
    const fresh = store.getReview(review.id)!;
    const findings = [store.getFinding(f1.id)!, store.getFinding(f2.id)!];
    const payload = buildPrReviewPayload(fresh, findings, 'request_changes');
    assert.equal(payload.event, 'REQUEST_CHANGES');
    assert.equal(payload.comments.length, 2, '两条有锚点 → 两条 inline');
    assert.equal(payload.comments[0].side, 'RIGHT');
    assert.equal(payload.comments[0].line, 20);
    assert.match(payload.comments[0].body, /```suggestion\nconst c = new Atomic/, 'suggestion 块');
    assert.match(payload.body, /整体方向 OK/, 'review body = summary');
    log('payload 组装 ok');
  }

  // ---- success:待提交项锁定 submitted + review 状态 submitted + 事件回推 ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const { review, f1, f2 } = seed(store);
    const fake = new FakeSubmitter({ status: 'success', url: 'https://gh/x#r1', submittedCount: 2 });
    const manager = new ReviewManager(store, undefined, { submitter: fake });
    const events: ReviewEvent[] = [];
    manager.on('review-event', (e: ReviewEvent) => events.push(e));

    const res = await manager.submitReview(review.id, { event: 'comment', summaryBody: '改后的摘要' });
    assert.equal(res.status, 'success');
    assert.equal(fake.last!.payload.body, '改后的摘要', 'summaryBody 提交前落库并进 payload');
    assert.equal(store.getFinding(f1.id)!.submission, 'submitted');
    assert.equal(store.getFinding(f1.id)!.submittedUrl, 'https://gh/x#r1');
    assert.equal(store.getFinding(f2.id)!.submission, 'submitted');
    assert.equal(store.getReview(review.id)!.status, 'submitted');
    assert.ok(events.some((e) => e.type === 'status' && e.payload === 'submitted'), 'status 事件');
    log('success 锁定 + 状态 + 事件 ok');

    // 增量:已提交项不再进待提交集 → 二次提交无可提交
    const again = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(again.status, 'failed');
    assert.match(again.message, /没有.*可提交/);
    log('增量:已提交锁定不重发 ok');
  }

  // ---- invalid / failed:不改任何状态 ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const { review, f1 } = seed(store);
    const manager = new ReviewManager(store, undefined, {
      submitter: new FakeSubmitter({ status: 'invalid', message: '行锚点失效' }),
    });
    const res = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(res.status, 'invalid');
    assert.equal(store.getFinding(f1.id)!.submission, 'unsubmitted', 'invalid 不改提交态');
    assert.notEqual(store.getReview(review.id)!.status, 'submitted', 'invalid 不置 submitted');
    log('invalid 不改状态 ok');
  }

  // ---- 非 github source:拒绝提交 ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'local-branch', sourceRef: 'feat/x' });
    store.addFinding(review.id, { severity: 'low', title: 'x', body: '', file: 'a.ts', line: 1 });
    const manager = new ReviewManager(store, undefined, {
      submitter: new FakeSubmitter({ status: 'success', url: 'u', submittedCount: 0 }),
    });
    const res = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(res.status, 'failed');
    assert.match(res.message, /github-pr/);
    log('非 github source 拒绝 ok');
  }

  log('────────────────────────');
  log('✅ PASS — 提交:payload/成功锁定/增量/被拒不改态/source 守卫全通过');
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(`[submit] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  },
);
