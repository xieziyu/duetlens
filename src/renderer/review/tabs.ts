/**
 * review tab 的状态机。**tab ≠ 会话**:tab 是视图的把手,codex 会话由后端按 reviewId 存活
 * (`ReviewManager.sessions`,只逐出空闲会话)。故关 tab 只摘视图,**不得**调 `review.release()` ——
 * 那条路(`disposeReview` → `teardown`)不看忙闲,会把正在跑的机审拆在半路。
 *
 * 纯函数,不碰 React:tab 的开合规则(同一条 review 只一枚、关掉活跃 tab 后落到谁、满了怎么办)
 * 是这次改动里最容易写歪的部分,单独放在这里才验得动。
 */

/** tab 内的视图。submit 是**某一条 review** 的子流程,不能与 tab 并列成全局屏 —— 并列的话,切 tab 时它属于谁没有答案。 */
export type TabView = 'review' | 'submit';

/** 一枚 tab。reviewId 即身份:再次打开同一条 review 是激活,不是新建第二枚。 */
export interface ReviewTab {
  reviewId: string;
  view: TabView;
}

export interface TabState {
  tabs: ReviewTab[];
  /** 当前 tab 的 reviewId;无 tab 时 null。 */
  activeId: string | null;
}

/**
 * 同时开着的 tab 上限。后台 tab 是**挂载但隐藏**的(切回来不丢在途回复残文 / 动作流 / 草稿 /
 * 滚动位置),每一枚都压着一整份 diff DOM,故要有上限 —— 拦的是内存,不是屏宽:
 * 一屏放不下由 tab 条自己横滚接住(见 ReviewTabs 的 useStripScroll)。
 * 与后端 `maxLiveSessions` 无关 —— 开 tab 只读库、不占会话位。
 */
export const MAX_TABS = 20;

export const EMPTY_TABS: TabState = { tabs: [], activeId: null };

export type OpenResult = { ok: true; state: TabState } | { ok: false; reason: 'at-limit' };

const indexOf = (state: TabState, reviewId: string): number =>
  state.tabs.findIndex((t) => t.reviewId === reviewId);

/** 已经开着吗?入口/历史/通知在决定「激活还是新建」之前问这一句。 */
export function hasTab(state: TabState, reviewId: string): boolean {
  return indexOf(state, reviewId) >= 0;
}

export function activeTab(state: TabState): ReviewTab | null {
  const i = state.activeId ? indexOf(state, state.activeId) : -1;
  return i < 0 ? null : state.tabs[i];
}

/**
 * 打开一条 review:已开就激活(顺序不动 —— tab 条会跳的话,用户下一次点击就点空了),
 * 没开则追加到末尾并激活。满载不静默丢弃,交给调用方给话说。
 */
export function openTab(state: TabState, reviewId: string): OpenResult {
  if (hasTab(state, reviewId)) return { ok: true, state: { ...state, activeId: reviewId } };
  if (state.tabs.length >= MAX_TABS) return { ok: false, reason: 'at-limit' };
  return { ok: true, state: { tabs: [...state.tabs, { reviewId, view: 'review' }], activeId: reviewId } };
}

/** 切到已开的某一枚;不在就原样返回(别凭一个过期 id 把当前 tab 清掉)。 */
export function activateTab(state: TabState, reviewId: string): TabState {
  return hasTab(state, reviewId) ? { ...state, activeId: reviewId } : state;
}

/**
 * 关掉一枚。关的是活跃 tab 时按「右邻优先、否则左邻」接位 —— 与浏览器一致,
 * 且比「回落到第一枚」更少让人失去位置感。关最后一枚即回到无 tab 态(rail 的「当前审核」随之不可达)。
 */
export function closeTab(state: TabState, reviewId: string): TabState {
  const i = indexOf(state, reviewId);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => t.reviewId !== reviewId);
  if (state.activeId !== reviewId) return { ...state, tabs };
  const next = tabs[i] ?? tabs[i - 1] ?? null;
  return { tabs, activeId: next?.reviewId ?? null };
}

/** 切某一枚 tab 的视图(进/出提交屏)。 */
export function setTabView(state: TabState, reviewId: string, view: TabView): TabState {
  const i = indexOf(state, reviewId);
  if (i < 0 || state.tabs[i].view === view) return state;
  const tabs = state.tabs.slice();
  tabs[i] = { ...tabs[i], view };
  return { ...state, tabs };
}

/** 相对当前 tab 前后切(⌘⇧[ / ⌘⇧] 与 ⌃⇥);首尾回环。 */
export function stepTab(state: TabState, delta: number): TabState {
  if (state.tabs.length === 0 || !state.activeId) return state;
  const i = indexOf(state, state.activeId);
  if (i < 0) return state;
  const n = state.tabs.length;
  return { ...state, activeId: state.tabs[(((i + delta) % n) + n) % n].reviewId };
}
