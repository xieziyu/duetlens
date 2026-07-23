/**
 * 轮次相关的展示派生(纯函数,给 review 屏各处共用)。
 *
 * 关键约定:finding 上的 resolution 只在「表态轮次 === 当前轮次」时代表**本轮**结论 ——
 * 第 2 轮判定 fixed 的条目,到第 3 轮若 agent 没再表态,就该回到"未表态",而不是一直挂着旧结论。
 */
import type { Finding, FindingResolution, ReviewRound } from '@shared/domain';

/** 本轮对该 finding 的判定;未在本轮表态返回 null。 */
export function currentResolution(f: Finding, currentRound: number): FindingResolution | null {
  return f.lastSeenRound === currentRound ? f.resolution : null;
}

/** 本轮判定已修复(会被收进折叠区,不占正常列表位置)。 */
export function isFixedThisRound(f: Finding, currentRound: number): boolean {
  return currentResolution(f, currentRound) === 'fixed';
}

/** 本轮判定「作者已回应、不打算改」。 */
export function isWontFixThisRound(f: Finding, currentRound: number): boolean {
  return currentResolution(f, currentRound) === 'wont_fix';
}

/**
 * 本轮已有结论、不需要 reviewer 再逐条过一遍的条目(已修复 / 作者已回应)。
 * 它们移出主列表收进折叠区 —— 留在原位只会淹没真正待处理的意见。
 */
export function isSettledThisRound(f: Finding, currentRound: number): boolean {
  const r = currentResolution(f, currentRound);
  return r === 'fixed' || r === 'wont_fix';
}

/** 本轮才出现的新条目。 */
export function isNewThisRound(f: Finding, currentRound: number): boolean {
  return currentRound > 1 && f.round === currentRound;
}

/** 状态栏/面板用的轮次摘要文案;首轮返回 null(单轮时不必强调"第 1 轮")。 */
export function roundSummary(rounds: readonly ReviewRound[], currentRound: number): string | null {
  if (currentRound <= 1) return null;
  const r = rounds.find((x) => x.round === currentRound);
  if (!r || r.status === 'scanning') return `第 ${currentRound} 轮`;
  const parts = [`第 ${currentRound} 轮`];
  if (r.fixedCount) parts.push(`修复 ${r.fixedCount}`);
  if (r.newFindings) parts.push(`新增 ${r.newFindings}`);
  if (r.suppressedCount) parts.push(`过滤 ${r.suppressedCount}`);
  return parts.join(' · ');
}
