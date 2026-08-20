/**
 * 默认基线的口径一致性(不走 codex/不烧 token):
 *   入口列分支时探测出的默认 base,必须与 `baseRef` 留空时 Source 自己算出来的那条**是同一条**。
 *
 * `base_ref` 留空表示「跟随该 source 的默认基线」,于是这条规则会被问到两次:入口一次(算 ahead、
 * 显示 ← base、算改动面),真正拉 diff 与每一轮复审再一次。两处各存一份候选表就会分家 ——
 * 差一档 `develop` 时,只有 develop 的仓库里入口显示「← develop · 1 commits ahead」,
 * 实际却因为一档都没命中而回落到根提交,把整段历史当成改动面。
 *
 * **必须用 develop-only 的仓库验**:main / master 在场时两份表恰好给出同一个答案,分歧藏得住。
 * 运行:npm run spike:base-ref
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/backend/source/exec';
import { diffStat, listLocalBranches } from '../src/backend/source/source-discovery';

const log = (m: string) => process.stdout.write(`[base-ref] ${m}\n`);

/** develop-only 的仓库:攒几条历史,回落到根提交时改动面会明显大一圈,断言才咬得住。 */
async function buildDevelopOnlyRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'duetlens-baseref-')));
  await run('git', ['-C', repo, 'init', '-q', '-b', 'develop']);
  await run('git', ['-C', repo, 'config', 'user.email', 'spike@duetlens.local']);
  await run('git', ['-C', repo, 'config', 'user.name', 'spike']);
  for (const n of ['1', '2', '3']) {
    await writeFile(path.join(repo, 'hist.txt'), `line ${n}\n`);
    await run('git', ['-C', repo, 'add', '-A']);
    await run('git', ['-C', repo, 'commit', '-q', '-m', `history ${n}`]);
  }
  await run('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x']);
  await writeFile(path.join(repo, 'feat.txt'), 'feature\n');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-q', '-m', 'feature']);
  return repo;
}

async function main() {
  const repo = await buildDevelopOnlyRepo();
  try {
    const list = await listLocalBranches(repo);
    assert.equal(list.detectedBase, 'develop', '入口应探测到 develop');
    // 用户选过别的 base 之后,detectedBase 不能跟着变 —— 否则他再选回真默认会被当成自定义值落库
    const withPick = await listLocalBranches(repo, 'feat/x');
    assert.equal(withPick.base, 'feat/x', '本次生效的 base 应是调用方给的那条');
    assert.equal(withPick.detectedBase, 'develop', '探测值与调用方给了什么无关');

    const asDefault = await diffStat({ source: 'local-branch', ref: 'feat/x', repoPath: repo });
    const asDevelop = await diffStat({
      source: 'local-branch',
      ref: 'feat/x',
      repoPath: repo,
      baseRef: 'develop',
    });
    assert.deepEqual(asDefault, asDevelop, 'base 留空算出的改动面应与入口探测到的 base 一致');
    assert.equal(asDefault.files, 1, 'develop-only 仓库里 feat/x 只改了一个文件(回落到根提交会是 2)');

    log('✅ 入口探测与 Source 留空同口径;detectedBase 不被调用方给的 base 顶替');
    log('✅ PASS — 默认基线口径一致');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  log(`❌ FAIL — ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
