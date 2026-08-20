/**
 * GitButler source 验证(不烧 token):
 *   (1) 确定性:合成 but 结构化 diff → toUnifiedDiff → 断言重建成标准 unified(改/增/删)。
 *   (2) 实仓 smoke:对本仓某虚拟分支跑 GitButlerSource.getDiff/getFile,断言 diff 标记与文件内容。
 *   (3) 路径穿越:越界读盘被拒,仓内符号链接可读、指向仓外的被拒。
 *   (4) 入口模式探测:inspectRepo 对 workspace 仓 / 普通仓 / 非 git 目录的判定。
 *   (5) 叠加 base:自建两层 stack,验缺省 / 下层分支 / workspace base 三档 diff 口径。
 * 运行:npm run spike:gitbutler [虚拟分支名，默认 feat/dev]
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/backend/source/exec';
import { detectGitButler, inspectRepo } from '../src/backend/source/source-discovery';
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
    // 「No ID found for entity」= 这台机器此刻没有挂着这条虚拟分支,是环境不具备而非回归
    if (/not a GitButler|setup|no such|unknown|not found|No ID found/i.test(msg)) {
      log(`⚠ (2) 跳过:${msg.split('\n')[0]}`);
      return;
    }
    throw e;
  } finally {
    await source.dispose();
  }
}

/** 读不到必须**抛**(见 Source.getFile 契约):回占位文本的话,取证闸会把一次失败的读当成已取证。 */
async function rejects(fn: () => Promise<unknown>, why: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`应当被拒却读成功了: ${why}`);
}

async function testTraversal() {
  const source = new GitButlerSource({
    source: 'gitbutler-vbranch',
    ref: 'x',
    repoPath: process.cwd(),
  });
  // POSIX 下真实穿越向量:相对 ../ 与绝对路径(反斜杠是合法文件名,不算分隔符)
  for (const p of ['../../../../etc/passwd', '/etc/passwd', 'src/../../../etc/hosts']) {
    const msg = await rejects(() => source.getFile(p), p);
    assert.ok(msg.includes('拒绝越界读取'), `应拒绝越界路径: ${p}(实际: ${msg})`);
  }
  // 正常仓内路径不被误伤
  const ok = await source.getFile('package.json');
  assert.ok(ok.includes('duetlens'), '仓内路径应正常读取');
  log('✅ (3) 路径穿越:越界 ../、绝对路径被拒,仓内路径放行');
}

/**
 * 符号链接:词法检查看到的是 `<root>/leak`,而 readFile 跟到了仓库外。
 * 被审仓库是**不可信输入** —— 一条指向 ~/.ssh/id_rsa 的链接就能把私钥送进模型上下文。
 */
async function testSymlinkEscape() {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'duetlens-sym-')));
  try {
    const repo = path.join(outer, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(outer, 'secret.txt'), 'PRIVATE KEY\n');
    await writeFile(path.join(repo, 'a.txt'), 'in-repo\n');
    await symlink('../secret.txt', path.join(repo, 'leak'));
    // 仓内指向仓内的链接是合法的,不能一刀切禁掉 symlink
    await symlink('a.txt', path.join(repo, 'alias'));

    const source = new GitButlerSource({ source: 'gitbutler-vbranch', ref: 'x', repoPath: repo });
    const msg = await rejects(() => source.getFile('leak'), 'leak -> ../secret.txt');
    assert.ok(msg.includes('拒绝越界读取'), `符号链接越界应被拒(实际: ${msg})`);
    assert.ok(!msg.includes('PRIVATE'), '拒绝信息里也不能带出目标内容');

    assert.equal(await source.getFile('alias'), 'in-repo\n', '仓内符号链接应照常可读');
    assert.equal(await source.getFile('a.txt'), 'in-repo\n', '普通文件不受影响');
    log('✅ (3b) 符号链接:指向仓外被拒,仓内链接与普通文件放行');
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
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

/**
 * 叠加分支的可选 base(自建 workspace,不依赖开发机此刻挂着哪些虚拟分支)。
 *
 * 要证的是三件事:缺省仍等于 `but diff <branch>`(只有本层)、指定下层分支得到同一份、
 * 指定 workspace base 得到整条 stack 的累积。**必须 teardown** —— `but setup` 会把这个
 * 临时仓库登记进全局项目表,不摘掉就在开发机上留一条指向已删目录的记录。
 */
async function testStackedBase() {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'duetlens-stack-')));
  let setup = false;
  try {
    await run('git', ['-C', tmp, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', tmp, 'config', 'user.email', 'spike@duetlens.local']);
    await run('git', ['-C', tmp, 'config', 'user.name', 'spike']);
    await writeFile(path.join(tmp, 'seed.txt'), 'seed\n');
    await run('git', ['-C', tmp, 'add', '-A']);
    await run('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
    try {
      await run('but', ['setup'], tmp);
      setup = true;
    } catch (e) {
      log(`⚠ (5) 跳过:but setup 失败(${(e as Error).message.split('\n')[0]})`);
      return;
    }

    // 两层 stack:lower 在下,upper 叠在其上,各改一个文件
    await writeFile(path.join(tmp, 'lower.txt'), 'lower\n');
    await run('but', ['commit', '-b', 'spike/lower', '-m', 'lower'], tmp);
    await writeFile(path.join(tmp, 'upper.txt'), 'upper\n');
    await run('but', ['commit', '-b', 'spike/upper', '-m', 'upper'], tmp);
    await run('but', ['move', 'spike/upper', '--above', 'spike/lower'], tmp);

    const status = await detectGitButler(tmp);
    const upper = status.branches.find((b) => b.name === 'spike/upper');
    const lower = status.branches.find((b) => b.name === 'spike/lower');
    assert.ok(upper && lower, '两条分支都应被列出');
    assert.equal(upper!.stackId, lower!.stackId, '同一条 stack 的分支应共享 stackId');
    assert.ok(upper!.stackOrder < lower!.stackOrder, '栈顶位次应小于下层');
    assert.ok(status.targetRef, 'workspace 应给出目标分支名');

    const diffOf = async (baseRef?: string) => {
      const source = new GitButlerSource({
        source: 'gitbutler-vbranch',
        ref: 'spike/upper',
        repoPath: tmp,
        baseRef,
      });
      try {
        return await source.getDiff();
      } finally {
        await source.dispose();
      }
    };

    const dflt = await diffOf();
    assert.ok(dflt.includes('upper.txt'), '缺省应含本层改动');
    assert.ok(!dflt.includes('lower.txt'), '缺省(= but diff)不该含下层改动');

    const viaLower = await diffOf('spike/lower');
    assert.ok(viaLower.includes('upper.txt') && !viaLower.includes('lower.txt'),
      '指定紧邻下层分支应与缺省同口径');

    const viaTarget = await diffOf(status.targetRef!);
    assert.ok(viaTarget.includes('upper.txt') && viaTarget.includes('lower.txt'),
      '指定 workspace base 应累积整条 stack');

    log('✅ (5) 叠加 base:缺省=本层,下层分支同口径,workspace base 累积整条 stack');
  } finally {
    if (setup) {
      // 摘不掉也不能让整条 spike 挂掉,但要说出来 —— 全局项目表里会留一条脏记录
      await run('but', ['teardown'], tmp).catch((e: Error) =>
        log(`⚠ (5) but teardown 失败,请手工清理 ${tmp}:${e.message.split('\n')[0]}`),
      );
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  testReconstruction();
  await testTraversal();
  await testSymlinkEscape();
  await testInspect();
  await testStackedBase();
  await testLive(process.argv[2] ?? 'feat/dev');
  log('✅ PASS — GitButler source 就位');
}

main().catch((e) => {
  process.stdout.write(`[gitbutler] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
