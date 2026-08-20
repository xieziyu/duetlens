import { run } from './exec';

/**
 * 默认基线的探测口径 —— **入口与 Source 必须共用这一份**。
 *
 * review 的 `base_ref` 留空表示「跟随该 source 的默认基线」,于是这条规则会被问到两次:
 * 入口列分支时问一次(算 ahead、显示 ← base),真正拉 diff 与每一轮复审时再问一次。
 * 两处各存一份候选表的话,只有 `develop` 而没有 main/master 的仓库会一边显示「← develop ·
 * 1 commits ahead」、一边把整段历史当成改动面拉进来(少一档就回落到根提交),而界面上
 * 没有任何地方看得出这个分歧。
 */
export const BASE_ORDER = ['origin/main', 'origin/master', 'main', 'master', 'develop'];

/** 按 {@link BASE_ORDER} 取第一条存在的 ref;都不存在则回落到根提交(全量审)。 */
export async function detectBaseRef(repo: string): Promise<string> {
  for (const b of BASE_ORDER) {
    if (await refExists(repo, b)) return b;
  }
  const root = (await run('git', ['-C', repo, 'rev-list', '--max-parents=0', 'HEAD'])).trim();
  return root.split('\n')[0];
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}
