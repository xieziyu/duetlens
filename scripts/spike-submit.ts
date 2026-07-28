/**
 * Headless 验证 GitHub 提交路径:payload 组装 + ReviewManager.submitReview 的
 * success/invalid/failed 状态流转(注入假 submitter,不烧真 PR、不碰网络)。
 * 运行:npm run spike:submit  · ABI:跑过 electron-forge start 后先 `npm run rebuild:node`。
 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import {
  buildPrReviewPayload,
  hasAnchor,
  isAnchorLive,
  isStaleAnchor,
  isSubmittable,
  nearestLiveLine,
  needsRecheckFollowUp,
} from '../src/shared/github-review';
import { parseUnifiedDiff } from '../src/shared/diff';
import type { GitHubSubmitter } from '../src/backend/review/github-submitter';
import type { PrReviewPayload } from '../src/shared/github-review';
import { recheckNote } from '../src/shared/domain';
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
    suggestion: '    const c = new Atomic(0);',
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
    // 缩进是补丁的一部分:被削掉的话 author 一键采纳就把那行的缩进也改了
    assert.match(payload.comments[0].body, /```suggestion\n {4}const c = new Atomic\(0\);\n```/, 'suggestion 块逐字保留缩进');
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

    // 增量:已提交项不再进待提交集 → 二次提交只发 review body,不重发任何 inline 评论。
    // (review body 本身就是一次合法的 GitHub review,故这里是 success 而非 failed)
    const again = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(again.status, 'success');
    assert.equal(fake.last!.payload.comments.length, 0, '已提交项不得重发为 inline 评论');
    assert.equal(fake.last!.payload.body, '改后的摘要', 'body 仍取落库的 summary');
    assert.equal(store.getFinding(f1.id)!.submittedUrl, 'https://gh/x#r1', '首次提交的链接不被覆盖');
    log('增量:已提交锁定不重发,body 单独成立 ok');
  }

  // ---- 复核追评:上一轮已提交、本轮复核仍存在 → 追发一条以复核说明为主体的评论 ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const { review, f1 } = seed(store);
    const fake = new FakeSubmitter({ status: 'success', url: 'https://gh/x#r1', submittedCount: 2 });
    const manager = new ReviewManager(store, undefined, { submitter: fake });
    await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(store.getFinding(f1.id)!.submittedRound, 1, '提交记下轮次');

    // 第 2 轮:agent 复核判定仍存在
    store.startRound(review.id, 2, {});
    store.setFindingResolution(f1.id, 2, 'still_present', '第 2 轮复核:换成了 RefCell,跨线程仍不安全。');
    const f1r2 = store.getFinding(f1.id)!;
    assert.equal(needsRecheckFollowUp(f1r2, 2), true, '上一轮已提交 + 本轮仍存在 → 欠一条追评');
    assert.equal(isSubmittable(f1r2, 2), true, '追评项回到待提交集');

    const res = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(res.status, 'success');
    const body = fake.last!.payload.comments.find((c) => c.line === 20)!.body;
    assert.match(body, /↻ 第 2 轮复核追评/, '追评自报身份,别看着像重复上报');
    assert.match(body, /换成了 RefCell/, '正文取本轮复核说明');
    assert.ok(!body.includes('用 Atomic 替代'), '首轮正文写在改动之前,被复核说明取代而非附在后面');
    assert.ok(!body.includes('首次报出时的说明'), '分隔小标题随首轮正文一起废掉');
    // 首轮 suggestion 是一键补丁,挂到改动后的锚点上会盖掉作者刚改的代码
    assert.ok(!body.includes('```suggestion'), '首轮 suggestion 随首轮正文一起作废');

    // 同一轮内不重复追发:提交时记下的轮次即本轮
    const after = store.getFinding(f1.id)!;
    assert.equal(after.submittedRound, 2, '追评后轮次推进到本轮');
    assert.equal(needsRecheckFollowUp(after, 2), false, '同轮不再追发第二条');
    assert.equal(isSubmittable(after, 2), false, '同轮不再进待提交集');

    // 第 3 轮只被去重兜底命中(agent 没有再表态)→ 上一轮的说明必须失效,不能拿旧话再发一遍
    store.startRound(review.id, 3, {});
    store.touchFindingSeen(f1.id, 3);
    const f1r3 = store.getFinding(f1.id)!;
    assert.equal(f1r3.lastSeenRound, 3, '去重兜底前推轮次');
    assert.equal(recheckNote(f1r3, 3), null, '本轮没有说明,不复用上一轮的话');
    assert.equal(needsRecheckFollowUp(f1r3, 3), false, '没有新说明就不追评');
    log('复核追评:跨轮追发一次 + 同轮不重复 + 旧说明不复用 ok');
  }

  // ---- 脱锚 finding 并入摘要:多段正文整体缩进在列表项内 ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#7', title: 't' });
    const f = store.addFinding(review.id, {
      severity: 'high',
      title: '架构点',
      body: '第一段。\n\n第二段带列表:\n- 甲\n- 乙',
      file: 'src/p.ts',
      line: 0,
    });
    const payload = buildPrReviewPayload(store.getReview(review.id)!, [store.getFinding(f.id)!], 'comment');
    const tail = payload.body.split('### 整体意见')[1];
    const orphan = tail
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('- ') && !l.startsWith('  '));
    assert.deepEqual(orphan, [], '正文每一行都缩进在列表项内,不会掉出去');
    log('脱锚项并入摘要:多段正文不逃逸列表项 ok');
  }

  // ---- blocked:Comment 既无 body 也无 finding → 前置校验拦下,不走 submitter ----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#8', title: 't' });
    const fake = new FakeSubmitter({ status: 'success', url: 'https://gh/x#r9', submittedCount: 0 });
    const manager = new ReviewManager(store, undefined, { submitter: fake });

    const res = await manager.submitReview(review.id, { event: 'comment' });
    assert.equal(res.status, 'failed');
    assert.match(res.message, /需要填写 Review 意见/);
    assert.equal(fake.last, undefined, '被前置校验拦下时不该调用 submitter');

    // 同样空手,APPROVE 却是合法表态(干净通过)
    const approved = await manager.submitReview(review.id, { event: 'approve' });
    assert.equal(approved.status, 'success');
    assert.equal(fake.last!.payload.event, 'APPROVE');
    assert.equal(fake.last!.payload.comments.length, 0);
    log('blocked:空 Comment 被拦 / 空 Approve 放行 ok');
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

  // ---- 行锚点存活预判 + 修锚点/降级为摘要(422 定位)----
  {
    // src/p.ts 新侧活行 20..24;off-diff 行 99 不在其中
    const diff = parseUnifiedDiff(
      [
        'diff --git a/src/p.ts b/src/p.ts',
        'index 111..222 100644',
        '--- a/src/p.ts',
        '+++ b/src/p.ts',
        '@@ -18,3 +20,4 @@',
        ' ctx20',
        '+add21',
        '+add22',
        ' ctx23',
      ].join('\n'),
    );
    assert.equal(isAnchorLive('src/p.ts', 21, diff), true, '新增行 21 可锚');
    assert.equal(isAnchorLive('src/p.ts', 20, diff), true, '上下文行 20 可锚');
    assert.equal(isAnchorLive('src/p.ts', 99, diff), false, 'off-diff 行不可锚');
    assert.equal(isAnchorLive('nope.ts', 20, diff), false, '不在 diff 的文件不可锚');
    assert.equal(isAnchorLive('src/p.ts', 20, []), true, '无 diff 时不误报');
    assert.equal(nearestLiveLine('src/p.ts', 99, diff), 23, '最近改动行取 23');
    assert.equal(nearestLiveLine('nope.ts', 5, diff), null, '无可锚行返回 null');

    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#7' });
    store.setReviewSummary(review.id, '整体 OK。');
    const live = store.addFinding(review.id, { severity: 'high', title: '活锚点', body: 'b', file: 'src/p.ts', line: 21 });
    const stale = store.addFinding(review.id, { severity: 'medium', title: '失效锚点', body: '架构点', file: 'src/p.ts', line: 99 });
    assert.equal(isStaleAnchor(store.getFinding(live.id)!, diff, 1), false, '活锚点不算 stale');
    assert.equal(isStaleAnchor(store.getFinding(stale.id)!, diff, 1), true, 'off-diff 锚点算 stale');

    const manager = new ReviewManager(store, undefined, {
      submitter: new FakeSubmitter({ status: 'success', url: 'u', submittedCount: 0 }),
    });
    // 降级为摘要:line=0 只脱锚 → 从 inline 移到 review body,行号留着给摘要写锚点
    manager.setFindingAnchor(review.id, stale.id, 0);
    assert.equal(store.getFinding(stale.id)!.line, 99, '降级不清行号');
    assert.equal(store.getFinding(stale.id)!.anchorDropped, true, '记为已脱锚');
    assert.equal(hasAnchor(store.getFinding(stale.id)!), false, '脱锚后不再作为 inline 提交');
    const degraded = buildPrReviewPayload(
      store.getReview(review.id)!,
      [store.getFinding(live.id)!, store.getFinding(stale.id)!],
      'comment',
    );
    assert.equal(degraded.comments.length, 1, '降级后只剩 1 条 inline');
    assert.match(degraded.body, /失效锚点/, '降级项并入 review body');
    assert.match(degraded.body, /`src\/p\.ts:99`/, '摘要条目自带 file:line,否则作者无从定位');

    // 改回行评论:降级留着的行号原样传回即可复原
    manager.setFindingAnchor(review.id, stale.id, store.getFinding(stale.id)!.line);
    assert.equal(hasAnchor(store.getFinding(stale.id)!), true, '传回原行号即撤销降级');
    manager.setFindingAnchor(review.id, stale.id, 0);

    // 改锚点:把另一条改到最近活行 → 回到 inline
    const stale2 = store.addFinding(review.id, { severity: 'low', title: '再失效', body: 'x', file: 'src/p.ts', line: 88 });
    const near = nearestLiveLine('src/p.ts', 88, diff)!;
    manager.setFindingAnchor(review.id, stale2.id, near);
    assert.equal(isStaleAnchor(store.getFinding(stale2.id)!, diff, 1), false, '改锚点后不再 stale');
    log('行锚点预判 + 降级为摘要 + 改锚点 ok');
  }

  // ---- 现拉最新 diff(422 后定位失效锚点的依据;走 local-git source 免网络)----
  {
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const manager = new ReviewManager(store, undefined, {
      submitter: new FakeSubmitter({ status: 'success', url: 'u', submittedCount: 0 }),
    });

    const review = store.createReview({
      source: 'local-branch',
      sourceRef: '',
      repoPath: process.cwd(),
      title: 't',
    });
    store.setDiff(review.id, 'SNAPSHOT');
    // 轮次记的 headSha 与实际 head 不同 → headMoved,即「审核后代码又推进过」
    store.startRound(review.id, 1, { headSha: 'deadbeefdeadbeef' });

    const moved = await manager.getLatestDiff(review.id);
    assert.equal(moved.ok, true, '本地仓库能现拉最新 diff');
    if (moved.ok) {
      assert.equal(moved.headMoved, true, 'head 与轮次记录不同 → headMoved');
      assert.ok(moved.headSha && moved.headSha.length > 0, '带回最新 head sha');
    }
    assert.equal(store.getRawDiff(review.id), 'SNAPSHOT', '现拉不覆盖审核时的 diff 快照');

    // 同一 head 记进轮次 → 不再算 moved
    if (moved.ok && moved.headSha) {
      store.startRound(review.id, 2, { headSha: moved.headSha });
      const same = await manager.getLatestDiff(review.id);
      assert.equal(same.ok && same.headMoved, false, 'head 未变 → headMoved 为 false');
    }

    // 拉不到时返回失败结果而非抛错:提交屏据此提示「无法定位」并给退路
    const broken = store.createReview({
      source: 'local-branch',
      sourceRef: '',
      repoPath: '/nonexistent-repo-for-spike',
      title: 't',
    });
    const failed = await manager.getLatestDiff(broken.id);
    assert.equal(failed.ok, false, '拉不到时 ok=false');
    log('现拉最新 diff:不覆盖快照 + headMoved 判定 + 失败不抛 ok');
  }

  log('────────────────────────');
  log('✅ PASS — 提交:payload/成功锁定/增量/复核追评/被拒不改态/source 守卫/锚点预判/现拉最新 diff 全通过');
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(`[submit] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  },
);
