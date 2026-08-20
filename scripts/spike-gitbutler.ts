/**
 * GitButler source 验证(不烧 token):
 *   (1) 确定性:合成 but 结构化 diff → toUnifiedDiff → 断言重建成标准 unified(改/增/删)。
 *   (2) 实仓 smoke:对本仓某虚拟分支跑 GitButlerSource.getDiff/getFile,断言 diff 标记与文件内容。
 *   (3) 取证口径:读被审分支的 commit 树(脏改动 / 跨 lane 都读不到),符号链接不跟随,越界被拒。
 *   (4) 入口模式探测:inspectRepo 对 workspace 仓 / 普通仓 / 非 git 目录的判定。
 *   (5) 叠加 base:缺省 / 下层分支 / workspace base 三档 diff 口径。
 *   (6) 快照与取证同树:分支在审核期间前进时,diff 与取证树要么一起停、要么一起走。
 *   (7) 同名 tag:短名消歧不得把 base / 取证钉到 tag 那棵树上。
 *   (3)(5)(6)(7) 共用一个自建 workspace,不依赖开发机此刻挂着哪些虚拟分支。
 * 运行:npm run spike:gitbutler [虚拟分支名，默认 feat/dev]
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/backend/source/exec';
import { detectGitButler, inspectRepo } from '../src/backend/source/source-discovery';
import { GitButlerSource, resolveCommit, toUnifiedDiff } from '../src/backend/source/gitbutler-source';

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
    // 「No ID found for entity」/「虚拟分支 … 不存在」= 这台机器此刻没有挂着这条虚拟分支,
    // 是环境不具备而非回归(前者来自 but,后者来自 prepare 里的 rev-parse)
    if (/not a GitButler|setup|no such|unknown|not found|No ID found|不存在/i.test(msg)) {
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
 * 自建 workspace 上的两组断言(不依赖开发机此刻挂着哪些虚拟分支):
 *   (3) **取证读的是被审分支那棵 commit 树,不是工作区**;
 *   (5) 叠加 base 的三档口径。
 *
 * (3) 是这个 source 最容易悄悄回退的一条:改回读工作区,在单 lane、无脏改动的机器上完全看不出
 * 差别,只有「另一条 lane 也 applied」或「有未提交改动」时才暴露 —— 而那正是 GitButler 的常态。
 *
 * **必须 teardown** —— `but setup` 会把这个临时仓库登记进全局项目表,不摘掉就在开发机上留一条
 * 指向已删目录的记录。
 */
async function testStackedBase() {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'duetlens-stack-')));
  const repo = path.join(outer, 'repo');
  let setup = false;
  try {
    await mkdir(repo, { recursive: true });
    // 被审仓库是**不可信输入**:提交一条指向仓库外的链接,验树读不会把目标内容带出来
    await writeFile(path.join(outer, 'secret.txt'), 'PRIVATE KEY\n');
    await run('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', repo, 'config', 'user.email', 'spike@duetlens.local']);
    await run('git', ['-C', repo, 'config', 'user.name', 'spike']);
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n');
    await symlink('../secret.txt', path.join(repo, 'leak'));
    await symlink('seed.txt', path.join(repo, 'alias'));
    await run('git', ['-C', repo, 'add', '-A']);
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    const init = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim();
    try {
      await run('but', ['setup'], repo);
      setup = true;
    } catch (e) {
      log(`⚠ (3)(5) 跳过:but setup 失败(${(e as Error).message.split('\n')[0]})`);
      return;
    }

    // 两层 stack:lower 在下,upper 叠在其上,各改一个文件
    await writeFile(path.join(repo, 'lower.txt'), 'lower\n');
    await run('but', ['commit', '-b', 'spike/lower', '-m', 'lower'], repo);
    await writeFile(path.join(repo, 'upper.txt'), 'upper\n');
    await run('but', ['commit', '-b', 'spike/upper', '-m', 'upper'], repo);
    await run('but', ['move', 'spike/upper', '--above', 'spike/lower'], repo);
    // 另一条独立 lane:它的改动同样摊在工作区里,却不属于被审分支
    await writeFile(path.join(repo, 'other.txt'), 'OTHER-LANE\n');
    await run('but', ['commit', '-b', 'spike/other', '-m', 'other'], repo);

    const status = await detectGitButler(repo);
    const upper = status.branches.find((b) => b.name === 'spike/upper');
    const lower = status.branches.find((b) => b.name === 'spike/lower');
    const other = status.branches.find((b) => b.name === 'spike/other');
    assert.ok(upper && lower && other, '三条分支都应被列出');
    assert.equal(upper!.stackId, lower!.stackId, '同一条 stack 的分支应共享 stackId');
    assert.ok(upper!.stackOrder < lower!.stackOrder, '栈顶位次应小于下层');
    assert.notEqual(other!.stackId, upper!.stackId, '独立 lane 不应与 stack 共享 stackId');
    assert.ok(status.targetRef, 'workspace 应给出目标分支名');

    const sourceFor = async (baseRef?: string) => {
      const source = new GitButlerSource({
        source: 'gitbutler-vbranch',
        ref: 'spike/upper',
        repoPath: repo,
        baseRef,
      });
      await source.prepare();
      return source;
    };
    const diffOf = async (baseRef?: string) => {
      const source = await sourceFor(baseRef);
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

    // ---- (3) 取证口径 ----
    const src = await sourceFor();
    try {
      // 工作区改脏:树读必须视而不见,否则读回的内容比被审的 diff 新、行号还可能错位
      await writeFile(path.join(repo, 'upper.txt'), 'upper\nDIRTY-WORKTREE\n');
      const read = await src.getFile('upper.txt');
      assert.ok(read.includes('upper'), '被审分支已提交的内容应读得到');
      assert.ok(!read.includes('DIRTY-WORKTREE'), '取证读的必须是分支树,不是工作区');

      // 跨 lane 隔离:另一条 lane 的文件就摊在工作区里,但它不属于这次审核
      const crossLane = await rejects(() => src.getFile('other.txt'), 'other.txt 属于另一条 lane');
      assert.ok(crossLane.includes('无法读取'), `跨 lane 文件应读不到(实际: ${crossLane})`);
      assert.ok(!crossLane.includes('OTHER-LANE'), '报错里不能带出另一条 lane 的内容');

      // 符号链接按 blob 读回链接目标本身,不跟随 —— 越界外泄面因此在结构上消失
      const link = await src.getFile('leak');
      assert.equal(link.trim(), '../secret.txt', '越界符号链接应读回链接目标字符串');
      assert.ok(!link.includes('PRIVATE'), '符号链接不得把仓库外的内容带进上下文');
      assert.equal((await src.getFile('alias')).trim(), 'seed.txt', '仓内符号链接同样按 blob 读');

      // POSIX 下真实穿越向量:相对 ../ 与绝对路径(反斜杠是合法文件名,不算分隔符)
      for (const p of ['../../../../etc/passwd', '/etc/passwd', 'src/../../../etc/hosts']) {
        const msg = await rejects(() => src.getFile(p), p);
        assert.ok(msg.includes('拒绝越界读取'), `应拒绝越界路径: ${p}(实际: ${msg})`);
      }

      // searchCode 必须与 getFile 同树:否则搜到的行号拿去读,读回的是另一份内容
      const inTree = await src.searchCode!({ query: 'upper' });
      assert.ok(inTree.total > 0, '树里有的内容应搜得到');
      const dirtyOnly = await src.searchCode!({ query: 'DIRTY-WORKTREE' });
      assert.equal(dirtyOnly.total, 0, '只存在于工作区的内容不该被搜到');

      // 未 prepare 就取证会落成 `git show :path`(读索引)—— 那是第三份内容,必须明确拦住
      const unprepared = new GitButlerSource({
        source: 'gitbutler-vbranch',
        ref: 'spike/upper',
        repoPath: repo,
      });
      const noPrep = await rejects(() => unprepared.getFile('seed.txt'), '未 prepare');
      assert.ok(noPrep.includes('尚未 prepare'), `未 prepare 应被拦(实际: ${noPrep})`);

      log('✅ (3) 取证口径:读分支树而非工作区(脏改动/跨 lane 都读不到),符号链接不跟随,越界被拒');
    } finally {
      await src.dispose();
    }

    // ---- (6) 快照与取证同树 ----
    // amend / absorb / 追加提交是 GitButler 的日常,而一次审核活得比它们久(MCP 的 get_diff 与
    // get_file 会在会话中途各问各的)。缺省档的 diff 只有 `but diff <branch>` 给得出、而它认名字,
    // 于是三种时序都得有确定说法,不能让 diff 与取证悄悄落到两棵树上。
    const advance = async (file: string) => {
      await writeFile(path.join(repo, file), `${file}\n`);
      await run('but', ['commit', '-b', 'spike/upper', '-m', file], repo);
    };

    // (6a) 快照已取:之后分支怎么走都与本次审核无关
    const pinned = await sourceFor();
    try {
      const before = await pinned.getDiff();
      assert.ok(!before.includes('bump.txt'), 'bump.txt 此刻还不存在');
      await advance('bump.txt');
      assert.equal(await pinned.getDiff(), before, '取过快照之后,本次审核的 diff 不该跟着分支走');
      const late = await rejects(() => pinned.getFile('bump.txt'), 'bump.txt 是取快照之后才有的');
      assert.ok(late.includes('无法读取'), `取证树同样不该跟着前进(实际: ${late})`);
      assert.ok((await diffOf()).includes('bump.txt'), '新建的 source 才该看到前进后的改动');
    } finally {
      await pinned.dispose();
    }

    // (6b) 取证在前、快照在后:此时重钉会让已经发出去的行号失真,只能明确报错
    const readFirst = await sourceFor();
    try {
      assert.ok((await readFirst.getFile('upper.txt')).length > 0, '先读一次树(之后就不许重钉了)');
      await advance('bump2.txt');
      const msg = await rejects(() => readFirst.getDiff(), '取证之后分支才前进');
      assert.ok(msg.includes('变动过'), `应报取不回同一棵树,而不是给另一棵树的 diff(实际: ${msg})`);
    } finally {
      await readFirst.dispose();
    }

    // (6c) 两件事都还没发生:重钉即可,等价于晚一点 prepare
    const notYet = await sourceFor();
    try {
      await advance('bump3.txt');
      const d = await notYet.getDiff();
      assert.ok(d.includes('bump3.txt'), '还没取证过,快照重钉到当前树即可');
      assert.ok((await notYet.getFile('bump3.txt')).includes('bump3'), '重钉之后取证与 diff 仍同一棵树');
    } finally {
      await notYet.dispose();
    }
    log('✅ (6) 快照与取证同树:取过就不动 / 取证在前则报错 / 都没发生则重钉');

    // ---- (7) 同名 tag ----
    // git 的短名消歧把 refs/tags 排在 refs/heads 之前,只给一句 ambiguous 警告。放在最后做:
    // 它会把这个仓库变成「所有短名都有歧义」的状态,前面几组断言得在干净仓库上跑。
    for (const name of ['spike/upper', 'spike/lower']) {
      await run('git', ['-C', repo, 'tag', name, init]);
    }
    assert.equal((await run('git', ['-C', repo, 'rev-parse', 'spike/upper'])).trim(), init,
      '前提:短名此刻确实被消歧成 tag(否则这组断言什么都没验)');

    // prepare **只钉树、不拉 diff**:无会话时展开 DiffPane 是一个文件建一次 source,那条路从不
    // getDiff。缺省档此刻正好取不到 diff(同名 tag),于是能证明 prepare 没顺手把它拉过。
    const readOnly = new GitButlerSource({ source: 'gitbutler-vbranch', ref: 'spike/upper', repoPath: repo });
    try {
      await readOnly.prepare();
      assert.ok((await readOnly.getFile('upper.txt')).length > 0, '只读单文件的 source 不该被 diff 拖住');
    } finally {
      await readOnly.dispose();
    }

    const shadowed = await sourceFor('spike/lower');
    try {
      const d = await shadowed.getDiff();
      assert.ok(d.includes('upper.txt'), '指定 base 时两端都该按 refs/heads 解析');
      assert.ok(!d.includes('lower.txt'), 'base 被消歧成 tag 的话 range 会从 init 起算');
      assert.ok((await shadowed.getFile('upper.txt')).includes('upper'), '取证树不该钉到 tag 上');
    } finally {
      await shadowed.dispose();
    }
    // workspace target 落库与显示的是剥掉前缀的短名(`origin/main`),真身在 refs/remotes 下,
    // 所以 heads 之外还得试 remotes —— 否则同名 tag 照样抢得走。
    await run('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', init]);
    await advance('remote-probe.txt');
    const upperHead = (await run('git', ['-C', repo, 'rev-parse', 'refs/heads/spike/upper'])).trim();
    await run('git', ['-C', repo, 'tag', 'origin/main', upperHead]);
    assert.equal(await resolveCommit(repo, 'origin/main'), init,
      'workspace target 的短名应解析到 refs/remotes,而不是同名 tag');

    // 缺省档没法换成 sha —— `but diff` 只接受分支名,而它在同名 tag 下静默回空 changes(实测)。
    // 那样整轮审核会在「零改动」上跑完,所以宁可挡住。
    const conflict = await rejects(() => diffOf(), 'spike/upper 有同名 tag');
    assert.ok(conflict.includes('同名 tag'), `缺省档应挡住而不是回空 diff(实际: ${conflict})`);

    log('✅ (7) 同名 tag:指定 base 仍按 refs/heads 解析,缺省档挡住而不是静默回空 diff');
  } finally {
    if (setup) {
      // 摘不掉也不能让整条 spike 挂掉,但要说出来 —— 全局项目表里会留一条脏记录
      await run('but', ['teardown'], repo).catch((e: Error) =>
        log(`⚠ but teardown 失败,请手工清理 ${repo}:${e.message.split('\n')[0]}`),
      );
    }
    await rm(outer, { recursive: true, force: true });
  }
}

async function main() {
  testReconstruction();
  await testInspect();
  await testStackedBase();
  await testLive(process.argv[2] ?? 'feat/dev');
  log('✅ PASS — GitButler source 就位');
}

main().catch((e) => {
  process.stdout.write(`[gitbutler] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
