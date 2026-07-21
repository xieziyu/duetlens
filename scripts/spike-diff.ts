/**
 * 确定性验证 diff 解析与暴露(不走 codex/不烧 token):
 *   1. parseUnifiedDiff 对 add/del/modify/rename/binary/多 hunk 的结构与行号正确;
 *   2. ReviewStore.setDiff/getRawDiff + ReviewManager.getDiff 的落库→解析回环。
 *   运行:npm run spike:diff
 */
import { strict as assert } from 'node:assert';
import { parseUnifiedDiff } from '../src/shared/diff';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';

const log = (m: string) => process.stdout.write(`[diff] ${m}\n`);

const ADD = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const a = 1;
+
+export const b = 2;
`;

const DEL = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index e69de29..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = true;
-export default gone;
`;

const MODIFY = `diff --git a/src/mod.ts b/src/mod.ts
index 111..222 100644
--- a/src/mod.ts
+++ b/src/mod.ts
@@ -1,4 +1,4 @@ function foo() {
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
 return keep;
@@ -10,2 +10,3 @@ function bar() {
 const x = 1;
+const y = 2;
 return x;
`;

const RENAME = `diff --git a/src/from.ts b/src/to.ts
similarity index 100%
rename from src/from.ts
rename to src/to.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;

function main(): void {
  // ---- added ----
  const [added] = parseUnifiedDiff(ADD);
  assert.equal(added.path, 'src/new.ts');
  assert.equal(added.status, 'added');
  assert.equal(added.additions, 3);
  assert.equal(added.deletions, 0);
  assert.equal(added.hunks[0].lines.length, 3);
  assert.deepEqual(
    added.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['add', null, 1],
      ['add', null, 2],
      ['add', null, 3],
    ],
  );
  log('added ✓');

  // ---- deleted ----
  const [deleted] = parseUnifiedDiff(DEL);
  assert.equal(deleted.path, 'src/old.ts');
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deletions, 2);
  assert.deepEqual(
    deleted.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['del', 1, null],
      ['del', 2, null],
    ],
  );
  log('deleted ✓');

  // ---- modified:多 hunk + 行号累进 + section ----
  const [mod] = parseUnifiedDiff(MODIFY);
  assert.equal(mod.status, 'modified');
  assert.equal(mod.hunks.length, 2);
  assert.equal(mod.additions, 2);
  assert.equal(mod.deletions, 1);
  assert.equal(mod.hunks[0].section, 'function foo() {');
  // hunk1:context(1/1) del(2/-) add(-/2) context(3/3) context(4/4)
  assert.deepEqual(
    mod.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text]),
    [
      ['context', 1, 1, 'const keep = 1;'],
      ['del', 2, null, 'const before = 2;'],
      ['add', null, 2, 'const after = 2;'],
      ['context', 3, 3, 'const tail = 3;'],
      ['context', 4, 4, 'return keep;'],
    ],
  );
  // hunk2:从新 start=10 起算
  assert.deepEqual(
    mod.hunks[1].lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 10, 10],
      ['add', null, 11],
      ['context', 11, 12],
    ],
  );
  log('modified 多 hunk + 行号 ✓');

  // ---- renamed ----
  const [renamed] = parseUnifiedDiff(RENAME);
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'src/from.ts');
  assert.equal(renamed.path, 'src/to.ts');
  assert.equal(renamed.hunks.length, 0);
  log('renamed ✓');

  // ---- binary ----
  const [bin] = parseUnifiedDiff(BINARY);
  assert.equal(bin.binary, true);
  assert.equal(bin.hunks.length, 0);
  log('binary ✓');

  // ---- 多文件一次解析 ----
  const multi = parseUnifiedDiff(ADD + DEL + MODIFY);
  assert.equal(multi.length, 3);
  assert.deepEqual(multi.map((f) => f.status), ['added', 'deleted', 'modified']);
  log('多文件 ✓');

  // ---- 落库回环:setDiff → getRawDiff → getDiff 解析 ----
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' });
  assert.equal(store.getRawDiff(review.id), null);
  store.setDiff(review.id, ADD + MODIFY);
  const raw = store.getRawDiff(review.id);
  assert.ok(raw && raw.includes('src/new.ts'));
  const files = parseUnifiedDiff(raw!);
  assert.equal(files.length, 2);
  // upsert 覆盖
  store.setDiff(review.id, ADD);
  assert.equal(parseUnifiedDiff(store.getRawDiff(review.id)!).length, 1);
  db.close();
  log('store 回环 ✓');

  log('PASS');
}

main();
