import type { ReviewEvent } from '@shared/ipc';

/**
 * review 领域事件的**单订阅扇出**。每个 `useReviewStream` 各自 `onEvent` 一次的话,
 * 多 tab 会在同一条 IPC 频道上挂 N 个监听(EventEmitter 到 10 个就开始告警),
 * 而每个监听拿到的还是全量事件、各自再按 reviewId 过滤一遍。
 *
 * 这里只留一份底层订阅:首个订阅者装、最后一个走时卸,按 `e.reviewId` 只喂给认领它的那几个。
 */
type Handler = (e: ReviewEvent) => void;

const byReview = new Map<string, Set<Handler>>();
let detach: (() => void) | null = null;

function dispatch(e: ReviewEvent): void {
  const set = byReview.get(e.reviewId);
  if (!set) return;
  // 先快照:handler 里退订(如收到终态即卸载)会就地改这个集合
  for (const h of [...set]) h(e);
}

/**
 * 订阅一条 review 的事件;返回退订钩子。同一条 review 可有多个订阅者(同一 tab 内的
 * 不同视图、或将来的分屏),彼此不相干。
 */
export function subscribeReviewEvents(reviewId: string, handler: Handler): () => void {
  let set = byReview.get(reviewId);
  if (!set) {
    set = new Set();
    byReview.set(reviewId, set);
  }
  set.add(handler);
  detach ??= window.duetlens.review.onEvent(dispatch);

  return () => {
    const cur = byReview.get(reviewId);
    if (!cur) return;
    cur.delete(handler);
    if (cur.size === 0) byReview.delete(reviewId);
    if (byReview.size === 0) {
      detach?.();
      detach = null;
    }
  };
}
