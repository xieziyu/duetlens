import type { Review } from '@shared/domain';

/**
 * 展示用的 PR 引用拆解(URL / owner/repo#123 / 纯号);解析不出就退回原样显示,
 * 不与 main 侧 parsePrRef 共用 —— 那条路径要抛错并回退推断仓库,展示态不需要。
 */
export function parsePrRefLoose(ref: string): { nwo: string; num: string } | null {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { nwo: url[1], num: url[2] };
  const short = ref.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/);
  if (short) return { nwo: short[1], num: short[2] };
  const numOnly = ref.match(/^#?(\d+)$/);
  return numOnly ? { nwo: '', num: numOnly[1] } : null;
}

/** 顶栏与 tab 共用的短来源标识:PR 取 `#123`,其余给 ref 原文。 */
export function shortSourceLabel(source: Review['source'] | undefined, ref: string): string {
  const pr = source === 'github-pr' ? parsePrRefLoose(ref) : null;
  return pr ? `#${pr.num}` : ref;
}
