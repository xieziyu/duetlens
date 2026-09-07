/**
 * Headless 验证「PR 内的提交范围」的确定性部分:容器 / 子行的形状、切范围不起 agent、
 * 按需机审的闸、updated_at 冒泡与保留清理、列表聚合、以及首轮 prompt 的位置段。
 * 不起 codex、不烧 token。运行:npm run spike:scope
 *
 * gh 用一个假二进制顶掉(setToolPath),桩打在 CLI 边界上 —— GitHubPrSource 与 ReviewManager
 * 都跑的是生产代码,只有网络那一步是假的。**必须在 manager 建好之后再设**:构造函数会把
 * ui_settings 里的路径覆盖同步回去,先设就被清掉了。
 *
 * ABI 注意:跑过 electron 之后先在 node_modules/better-sqlite3 里 `npx prebuild-install -r node`。
 */
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { setToolPath } from '../src/backend/config/tool-paths';
import { buildScanPrompt } from '../src/backend/prompt/scan-prompt';
import { isUnscanned, REVIEW_RETENTION_MS } from '../src/shared/domain';
import type { CommitPosition } from '../src/shared/source-discovery';

function log(msg: string) {
  process.stdout.write(`[scope] ${msg}\n`);
}

const SHAS = [
  'aaaaaaa1111111111111111111111111111aaaa1',
  'bbbbbbb2222222222222222222222222222bbbb2',
  'ccccccc3333333333333333333333333333cccc3',
];

/**
 * 假 gh:认 `pr view` / `pulls/N/commits` / `commits/<sha>`(diff 媒体类型)三条路径。
 * 写成 node 脚本而不是 shell —— 参数里带 `Accept: ...` 空格与冒号,shell 引用一错就变成静默走空分支。
 */
function fakeGh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'duetlens-spike-gh-'));
  const bin = path.join(dir, 'gh');
  const commits = SHAS.map((sha, i) => ({
    sha,
    commit: { message: `feat: step ${i + 1}\n\nbody`, committer: { date: '2026-09-01T00:00:00Z' }, author: { name: 'dev' } },
    author: { login: 'dev' },
    parents: [{}],
  }));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const joined = a.join(' ');
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({ title: 'streaming pipeline', number: 42, headRefOid: ${JSON.stringify(SHAS[2])}, url: 'https://github.com/acme/repo/pull/42' }));
  process.exit(0);
}
if (/pulls\\/42\\/commits/.test(joined)) {
  process.stdout.write(/page=1(&|$)/.test(joined) ? ${JSON.stringify(JSON.stringify(commits))} : '[]');
  process.exit(0);
}
if (/repos\\/[^ ]+\\/commits\\//.test(joined)) {
  const sha = joined.split('/commits/')[1].trim();
  process.stdout.write('diff --git a/src/' + sha.slice(0, 4) + '.ts b/src/' + sha.slice(0, 4) + '.ts\\n--- a/src/' + sha.slice(0, 4) + '.ts\\n+++ b/src/' + sha.slice(0, 4) + '.ts\\n@@ -1,1 +1,2 @@\\n line\\n+added\\n');
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'diff') {
  process.stdout.write('diff --git a/src/whole.ts b/src/whole.ts\\n--- a/src/whole.ts\\n+++ b/src/whole.ts\\n@@ -1,1 +1,2 @@\\n line\\n+whole pr\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unhandled ' + joined + '\\n');
process.exit(1);
`,
    'utf8',
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const manager = new ReviewManager(store);
  // 构造之后再设:applyToolPaths 会按 ui_settings 把覆盖清回默认
  setToolPath('gh', fakeGh());

  // ---- 1. 容器 + 子行的形状 ----
  const container = store.createReview({
    source: 'github-pr',
    sourceRef: 'acme/repo#42',
    title: '#42 · streaming pipeline',
    intensity: 'adversarial',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    currentRound: 0,
    status: 'reviewing',
  });
  assert.equal(container.currentRound, 0);
  assert.ok(isUnscanned(container), '容器建出来即未机审');
  assert.equal(container.parentReviewId, null);
  assert.equal(store.listRounds(container.id).length, 0, '容器不该有轮次');
  log('容器:current_round=0 / 无轮次 ok');

  const child = await manager.openScope(container.id, SHAS[1]);
  assert.equal(child.parentReviewId, container.id);
  assert.equal(child.headRef, SHAS[1]);
  assert.equal(child.baseRef, null, '钉住 commit 时不带 base');
  assert.equal(child.currentRound, 0, '切范围不起 agent');
  assert.ok(isUnscanned(child));
  assert.equal(store.listRounds(child.id).length, 0, '子行不该有轮次');
  // 会话是进程内的活物,没 launch 过就一个都不该有
  assert.equal(manager.getLiveCapacity().live, 0, '切范围不占会话位');
  assert.equal(child.intensity, 'adversarial', '审核配置继承容器');
  assert.equal(child.model, 'gpt-5.6-sol');
  assert.ok(store.getRawDiff(child.id)?.includes('bbbb'), '子行落了它自己那一个 commit 的 diff');
  // 现建的那条路要记 active_scope(进屏据此落位)
  assert.equal(store.getActiveScope(container.id), SHAS[1], '新建范围要记 active_scope');
  log('子行:parent/head/轮次 0/无会话/继承配置/diff 快照/active_scope ok');

  // 同一个 sha 再切回来是同一行,不重复建;命中缓存那条路同样要记
  store.setActiveScope(container.id, null);
  const again = await manager.openScope(container.id, SHAS[1]);
  assert.equal(again.id, child.id);
  assert.equal(store.listChildren(container.id).length, 1);
  assert.equal(store.getActiveScope(container.id), SHAS[1], '命中已有行也要记 active_scope');
  log('重复 openScope 命中已有行 + active_scope 落库 ok');

  // ---- 2. startScan 只对未机审的范围开放 ----
  //
  // 这里只验被拒那一支:放行的那支会真的拉起 codex 会话(那是 spike 不该做的事,也烧 token),
  // 它的落点由 launchRound 既有的 spike 覆盖。
  store.startRound(container.id, 1, {});
  assert.equal(store.getReview(container.id)!.currentRound, 1, 'startRound 把 0 推到 1');
  await assert.rejects(() => manager.startScan(container.id, {}), /已经机审过/);
  log('startScan 在非 0 轮被拒 + startRound 从 0 → 1 ok');

  // ---- 3. 子行的 touch 冒泡到父行 ----
  const before = store.getReview(container.id)!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const disc = store.addUserDiscussion(child.id, null);
  store.addMessage(disc.id, 'user', '这一段为什么要加锁?');
  const after = store.getReview(container.id)!.updatedAt;
  assert.ok(after > before, `子行被追问要把父行推上去(${before} → ${after})`);
  assert.ok(store.getReview(child.id)!.updatedAt >= after);
  log('子行 touch 冒泡父行 updated_at ok');

  // startRound 那条直接写 updated_at 的路径同样要冒泡
  const before2 = store.getReview(container.id)!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.startRound(child.id, 1, {});
  assert.ok(store.getReview(container.id)!.updatedAt > before2, 'startRound 也要冒泡');
  log('startRound 冒泡 ok');

  // ---- 4. listRecentReviews:只出顶层行,计数按父 + 子合计 ----
  const f = store.addFinding(child.id, {
    severity: 'high',
    title: '并发计数丢失',
    body: 'counter.set 不是原子操作',
    file: 'src/bbbb.ts',
    line: 2,
  });
  const recent = manager.listRecentReviews();
  assert.equal(recent.length, 1, '子行不单独出现在列表里');
  assert.equal(recent[0].id, container.id);
  assert.equal(recent[0].scopeCount, 1);
  // 容器一轮没跑、子范围在扫:行上必须能看出这条 PR 有东西在跑
  assert.equal(recent[0].scanningScopeCount, 0);
  store.setReviewStatus(child.id, 'scanning');
  assert.equal(manager.listRecentReviews()[0].scanningScopeCount, 1, '子范围在扫要算进 PR 这一行');
  store.setReviewStatus(child.id, 'reviewing');
  assert.equal(recent[0].findingCount, 1, '记在子行名下的 finding 要算进 PR 这一行');
  assert.equal(recent[0].discussionCount, 1);
  store.setSubmission(f.id, 'submitted', 'https://github.com/acme/repo/pull/42#discussion_r1', 1);
  assert.equal(manager.listRecentReviews()[0].submittedCount, 1);
  log('listRecentReviews:只出顶层 + 计数合计 ok');

  // 提交屏那句「其它范围还有 N 条待提交」
  const pending = store.addFinding(child.id, {
    severity: 'low',
    title: '命名',
    body: 'x',
    file: 'src/bbbb.ts',
    line: 1,
  });
  assert.equal(manager.scopePending(container.id), 1, '只数还可提交的那些');
  assert.equal(manager.scopePending(child.id), 0, '子行没有下级范围');
  store.setTriage(pending.id, 'dismiss', null);
  assert.equal(manager.scopePending(container.id), 0, '剔除掉的不算待提交');
  log('scopePending ok');

  // ---- 5. 保留清理只删顶层,子行随父级联 ----
  const cutoffDb = openDatabase(':memory:');
  const store2 = new ReviewStore(cutoffDb);
  const old = store2.createReview({ source: 'github-pr', sourceRef: 'acme/repo#7', currentRound: 0 });
  const oldChild = store2.createReview({
    source: 'github-pr',
    sourceRef: 'acme/repo#7',
    headRef: SHAS[0],
    parentReviewId: old.id,
    currentRound: 0,
  });
  const fresh = store2.createReview({ source: 'github-pr', sourceRef: 'acme/repo#8' });
  // 父行过期而子行「看着还新」:只有「只判顶层」才会把这一对一起清掉
  const expired = Date.now() - REVIEW_RETENTION_MS - 60_000;
  cutoffDb.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(expired, old.id);
  cutoffDb.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(Date.now(), oldChild.id);
  const removed = store2.pruneReviewsBefore(Date.now() - REVIEW_RETENTION_MS);
  assert.equal(removed, 1, '删掉的条数只数顶层行');
  assert.equal(store2.getReview(old.id), null);
  assert.equal(store2.getReview(oldChild.id), null, '子行随父级联删');
  assert.ok(store2.getReview(fresh.id), '没过期的不动');

  // 反过来:子行看着过期、父行还新,子行不能先消失
  const keeper = store2.createReview({ source: 'github-pr', sourceRef: 'acme/repo#9' });
  const staleChild = store2.createReview({
    source: 'github-pr',
    sourceRef: 'acme/repo#9',
    headRef: SHAS[0],
    parentReviewId: keeper.id,
    currentRound: 0,
  });
  cutoffDb.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(expired, staleChild.id);
  store2.pruneReviewsBefore(Date.now() - REVIEW_RETENTION_MS);
  assert.ok(store2.getReview(staleChild.id), '子行不先于它的 PR 过期');
  log('保留清理:只删顶层 + 级联 + 子行不先走 ok');

  // ---- 6. listScopes:提交列表 ⋈ 已建出的子行 ----
  const scopes = await manager.listScopes(container.id);
  assert.equal(scopes.commits.length, 3);
  assert.deepEqual(scopes.commits.map((c) => c.commit.oid), SHAS, '顺序保持旧→新');
  assert.equal(scopes.pr.reviewId, container.id);
  const hit = scopes.commits.find((c) => c.commit.oid === SHAS[1])!;
  assert.equal(hit.reviewId, child.id, '已建出的范围要挂上它的子行');
  assert.equal(hit.findingCount, 2);
  assert.equal(scopes.commits.find((c) => c.commit.oid === SHAS[0])!.reviewId, null, '没打开过的没有行');
  assert.equal(scopes.capped, false);
  log('listScopes:⋈ 子行 / 顺序 / 未建出的为 null ok');

  // 非 github-pr 与子行都不该有范围
  const local = store.createReview({ source: 'local-branch', sourceRef: 'feat/x' });
  await assert.rejects(() => manager.listScopes(local.id), /GitHub PR/);
  await assert.rejects(() => manager.listScopes(child.id), /已经是一个提交范围/);
  log('listScopes 的适用范围闸 ok');

  // ---- 6.5 并发 openScope 只建一条子行 ----
  //
  // 两次拉取都在头一次 getChildByHead 之后起飞(⌥↓ 连按、落位与点击撞上都是这个形状);
  // 落库前不再查一次的话,同一个 sha 会留下两条各持一份 diff 与 findings 的子行。
  const [raced1, raced2] = await Promise.all([
    manager.openScope(container.id, SHAS[2]),
    manager.openScope(container.id, SHAS[2]),
  ]);
  assert.equal(raced1.id, raced2.id, '并发切到同一个 sha 只该拿到同一条子行');
  assert.equal(
    store.listChildren(container.id).filter((c) => c.headRef === SHAS[2]).length,
    1,
    '同 sha 的子行不能建出两条',
  );
  log('并发 openScope 收敛到一条子行 ok');

  // ---- 6.6 删子行:容器停在它上面的那份记忆要一起清 ----
  //
  // 留着的话下次进屏按一个已不存在的范围落位,openScope 又照那个 sha 把它整条重新拉回来。
  assert.equal(store.getActiveScope(container.id), SHAS[2]);
  store.deleteReview(raced1.id);
  assert.equal(store.getActiveScope(container.id), null, '删掉的范围不能继续当 active_scope');
  // 停在别处时删一条无关的子行,那份记忆不该被顺手清掉
  store.setActiveScope(container.id, SHAS[1]);
  const unrelated = store.createReview({
    source: 'github-pr',
    sourceRef: 'acme/repo#42',
    headRef: SHAS[0],
    parentReviewId: container.id,
    currentRound: 0,
  });
  store.deleteReview(unrelated.id);
  assert.equal(store.getActiveScope(container.id), SHAS[1], '删别的范围不该动这份记忆');
  log('deleteReview(子行) 清 active_scope ok');

  // ---- 7. 首轮 prompt 的位置段 ----
  const position: CommitPosition = {
    sha: SHAS[1],
    headline: 'feat: step 2',
    index: 2,
    total: 3,
    capped: false,
    prevHeadline: 'feat: step 1',
    nextHeadline: 'feat: step 3',
  };
  const prompt = buildScanPrompt({ pr: null, position })!;
  assert.ok(prompt.includes('## 本次审核范围'), '要有位置段');
  assert.ok(prompt.includes('第 2/3 个提交'), '要说清第几个');
  assert.ok(prompt.includes(SHAS[1].slice(0, 7)), '要带短 sha');
  assert.ok(prompt.includes('feat: step 1') && prompt.includes('feat: step 3'), '前后提交的标题都要给');
  assert.ok(
    prompt.indexOf('## 本次审核范围') < prompt.indexOf('## 本轮任务'),
    '任务指令必须排在所有材料之后(隔离围栏的前提)',
  );
  // 整个 PR 不带这一段
  assert.ok(!(buildScanPrompt({ pr: null, note: 'x' }) ?? '').includes('## 本次审核范围'));
  // 列表被截断时说不出第几个,但仍要交代这是单个提交
  const cappedPrompt = buildScanPrompt({
    pr: null,
    position: { ...position, index: null, total: 250, capped: true, prevHeadline: null, nextHeadline: null },
  })!;
  assert.ok(cappedPrompt.includes('## 本次审核范围'));
  assert.ok(!cappedPrompt.includes('第 2/3'), '拿不到位置就别编一个');
  log('buildScanPrompt 位置段 ok');

  // ---- 8. GitHubPrSource.prepare 顺带给出的位置(不为一行标题再打一次 gh)----
  const source = (await import('../src/backend/source/github-pr-source')).GitHubPrSource;
  const src = new source({ source: 'github-pr', ref: 'acme/repo#42', repoPath: '', headRef: SHAS[0] });
  const prepared = await src.prepare();
  assert.equal(prepared.position?.index, 1);
  assert.equal(prepared.position?.total, 3);
  assert.equal(prepared.position?.prevHeadline, null, '第一个提交前面没有别的');
  assert.equal(prepared.position?.nextHeadline, 'feat: step 2');
  await src.dispose();
  log('prepare 回带 position ok');

  // ---- 9. 删 PR:子范围的会话也要拆 ----
  //
  // 库里的行随父级联删,但会话是进程内的活物,级联碰不到它。桩打在 teardown 下面那一层
  // (会话表)而不是重写 deleteReview:跑的仍是它自己那套「拆 → 删 → 再拆一次」。
  const disposed: string[] = [];
  const live = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of [container.id, child.id])
    live.set(id, { isBusy: () => false, dispose: async () => void disposed.push(id) });
  assert.equal(manager.getLiveCapacity().live, 2);
  await manager.deleteReview(container.id);
  assert.ok(
    disposed.includes(child.id),
    '子范围的会话要随 PR 一起拆掉(漏拆就是一个指着已删行的 codex 子进程 + MCP)',
  );
  assert.ok(disposed.includes(container.id), '容器自己的会话照拆');
  assert.equal(manager.getLiveCapacity().live, 0, '拆完一个不剩');
  assert.equal(store.getReview(child.id), null, '子行随父级联删');
  log('deleteReview:子范围的会话与行一起收掉 ok');

  log('────────────────────────');
  log('✅ PASS — 提交范围:容器/子行形状、按需机审、冒泡、保留、列表聚合、位置段、删除收会话全通过');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    process.stdout.write(`[scope] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  },
);
