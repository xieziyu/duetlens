/**
 * GitButler source 验证(不烧 token):
 *   (1) 确定性:合成 but 结构化 diff → toUnifiedDiff → 断言重建成标准 unified(改/增/删)。
 *   (2) 实仓 smoke:对本仓某虚拟分支跑 GitButlerSource.getDiff/getFile,断言 diff 标记与文件内容。
 *   (3) 路径穿越:越界读盘被拒。
 *   (4) 入口模式探测:inspectRepo 对 workspace 仓 / 普通仓 / 非 git 目录的判定。
 * 运行:npm run spike:gitbutler [虚拟分支名，默认 feat/dev]
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/backend/source/exec';
import { inspectRepo } from '../src/backend/source/source-discovery';
import { GitButlerSource, toUnifiedDiff } from '../src/backend/source/gitbutler-source';

const log = (m: string) => process.stdout.write(`[gitbutler] ${m}\n`);

function testReconstruction() {
  const synthetic = {
    changes: [
      {
        path: 'src/mod.ts',
        status: 'modified',
        diff: { type: 'patch', hunks: [{ diff: '@@ -1,2 +1,2 @@\n-old\n+new\n line\n' }] },
      },
      {
        path: 'src/new.ts',
        status: 'added',
        diff: { type: 'patch', hunks: [{ diff: '@@ -0,0 +1,1 @@\n+created\n' }] },
      },
      {
        path: 'src/gone.ts',
        status: 'deleted',
        diff: { type: 'patch', hunks: [{ diff: '@@ -1,1 +0,0 @@\n-removed\n' }] },
      },
      { path: 'bin/blob', status: 'modified', diff: { type: 'binary' } },
    ],
  };
  const out = toUnifiedDiff(synthetic as never);

  assert.ok(out.includes('diff --git a/src/mod.ts b/src/mod.ts'), '改:diff --git 头');
  assert.ok(out.includes('--- a/src/mod.ts\n+++ b/src/mod.ts'), '改:---/+++');
  assert.ok(out.includes('--- /dev/null\n+++ b/src/new.ts'), '增:--- /dev/null');
  assert.ok(out.includes('--- a/src/gone.ts\n+++ /dev/null'), '删:+++ /dev/null');
  assert.ok(out.includes('@@ -0,0 +1,1 @@'), '保留 hunk 头');
  assert.ok(!out.includes('bin/blob'), '二进制(无 patch)跳过');
  log('✅ (1) 确定性重建:改/增/删 unified 头正确,二进制跳过');
}

async function testLive(branch: string) {
  const source = new GitButlerSource({
    source: 'gitbutler-vbranch',
    ref: branch,
    repoPath: process.cwd(),
  });
  try {
    const prepared = await source.prepare();
    const diff = await source.getDiff();
    if (!diff.trim()) {
      log(`⚠ (2) 跳过:分支 ${branch} 无 diff(空工作分支?)`);
      return;
    }
    assert.ok(diff.includes('diff --git '), 'diff 含 diff --git 头');
    assert.ok(/^@@ .* @@/m.test(diff), 'diff 含 hunk 头');
    assert.ok(/^--- /m.test(diff) && /^\+\+\+ /m.test(diff), 'diff 含 ---/+++');

    // 取 diff 里第一个被改文件读其新侧内容
    const firstPath = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (firstPath) {
      const content = await source.getFile(firstPath);
      assert.ok(content.length > 0 && !content.startsWith('// 无法读取'), `可读文件 ${firstPath}`);
      log(`(2) 读到 ${firstPath}(${content.length} 字节)`);
    }
    log(`✅ (2) 实仓 smoke:${prepared.title} → 合法 unified diff`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not a GitButler|setup|no such|unknown|not found/i.test(msg)) {
      log(`⚠ (2) 跳过:${msg.split('\n')[0]}`);
      return;
    }
    throw e;
  } finally {
    await source.dispose();
  }
}

async function testTraversal() {
  const source = new GitButlerSource({
    source: 'gitbutler-vbranch',
    ref: 'x',
    repoPath: process.cwd(),
  });
  // POSIX 下真实穿越向量:相对 ../ 与绝对路径(反斜杠是合法文件名,不算分隔符)
  for (const p of ['../../../../etc/passwd', '/etc/passwd', 'src/../../../etc/hosts']) {
    const out = await source.getFile(p);
    assert.ok(out.startsWith('// 拒绝越界读取'), `应拒绝越界路径: ${p}`);
  }
  // 正常仓内路径不被误伤
  const ok = await source.getFile('package.json');
  assert.ok(ok.includes('duetlens'), '仓内路径应正常读取');
  log('✅ (3) 路径穿越:越界 ../、绝对路径被拒,仓内路径放行');
}

/** 入口模式探测:本仓(workspace 分支)按虚拟分支审,临时普通仓与非 git 目录都落到 local。 */
async function testInspect() {
  const here = await inspectRepo(process.cwd());
  assert.ok(here.isGit, '本仓应识别为 git 仓库');
  if (here.head === 'gitbutler/workspace' && !here.degraded) {
    assert.equal(here.mode, 'gitbutler', 'workspace 分支应判为虚拟分支模式');
    assert.ok(here.gitbutler?.isWorkspace, 'gitbutler 模式应带回 workspace 状态');
  } else {
    log(`⚠ (4) 本仓不在 workspace 分支(HEAD=${here.head ?? 'detached'}),跳过 gitbutler 模式断言`);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), 'duetlens-inspect-'));
  try {
    // 子目录传入也要归一到 git 顶层(realpath 抹平 macOS 的 /var → /private/var)
    const plain = await realpath(tmp);
    await run('git', ['-C', plain, 'init', '-q']);
    await run('git', ['-C', plain, 'commit', '-q', '--allow-empty', '-m', 'init']);
    await mkdir(path.join(plain, 'sub'), { recursive: true });
    const fromSub = await inspectRepo(path.join(plain, 'sub'));
    assert.equal(fromSub.mode, 'local', '普通 git 仓库应判为普通分支模式');
    assert.equal(fromSub.repoPath, plain, '子目录应归一到 git 顶层');
    assert.equal(fromSub.gitbutler, null, 'local 模式不带 vbranch 列表');

    const nonGit = await inspectRepo(tmpdir());
    assert.equal(nonGit.isGit && nonGit.mode !== 'local', false, '非 git 目录不应判为可审');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  log('✅ (4) 模式探测:workspace → vbranch,普通仓/子目录 → local(路径归一),非 git 目录不误判');
}

async function main() {
  testReconstruction();
  await testTraversal();
  await testInspect();
  await testLive(process.argv[2] ?? 'feat/dev');
  log('✅ PASS — GitButler source 就位');
}

main().catch((e) => {
  process.stdout.write(`[gitbutler] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
