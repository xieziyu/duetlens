import { useEffect, useMemo, useRef, useState } from 'react';
import type { Review, ReviewStatus } from '@shared/domain';
import { subscribeReviewEvents } from './review-event-bus';

/** tab 条要显示的那一点点信息;正文数据仍归各 tab 自己的 `useReviewStream`。 */
export interface TabMeta {
  title: string;
  sourceRef: string;
  source: Review['source'];
  status: ReviewStatus | null;
  /** 这枚 tab 在后台期间新报出的 finding 数;激活即清零。 */
  unread: number;
}

type TabInfo = Omit<TabMeta, 'unread'>;

/**
 * 已开 tab 的标题、状态与未读数。**不能由 ReviewScreen 往上报** —— 未挂载的 tab(恢复后还没被
 * 激活过)屏上没有那个组件,而它照样要在 tab 条上有名字、有状态、有未读数。故这里自己拉一次 +
 * 跟着事件走。
 *
 * 未读数与标题分开存:标题要等异步首拉,而 finding 事件可能先到 —— 合在一张表里的话,
 * 首拉落地前到的那几条会因为「这个 id 还没有记录」被原样丢掉,那枚 tab 的角标永远少数。
 */
export function useTabMeta(
  reviewIds: readonly string[],
  activeId: string | null,
): Record<string, TabMeta> {
  const [info, setInfo] = useState<Record<string, TabInfo>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  // 依赖用拼串而非数组本身:数组每次渲染都是新引用,直接进依赖等于每帧重订阅
  const key = reviewIds.join(',');
  // 订阅不该因为换 tab 而重建(重建 = 每切一次都重拉一遍 review),故活跃者走 ref
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  /**
   * **每条 review** 开始被盯着的时刻。`finding` 事件是 upsert:讨论里的回写、自检轮的改判、
   * reviewer 的编辑都会让一条**早就存在**的 finding 再来一次。只数这条 tab 开起来之后才诞生的,
   * 才是「新报出」。
   *
   * 起点必须按 id 记、且在它加入订阅那一刻定:记成全局一个的话,app 起来之后才打开(或关掉再
   * 打开)的那条 review,它在开 tab 之前就已产生的 finding 一旦被 upsert,又会被算成新增。
   * 反过来,已在订阅里的 id 不能因为别处开合 tab 而被重置 —— 那会把真正的新增漏掉。
   *
   * 拿时间戳当判据而不是先把已有 id 拉一份回来:那要为每枚 tab 多做一次整份 findings 的 IPC,
   * 而这里只是要在 tab 上点个数。
   */
  const watchingSince = useRef(new Map<string, number>());
  /** 已数过的 finding id:同一条新 finding 在后续更新里还会再来,不能数第二次。 */
  const counted = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    let alive = true;

    const put = (id: string, r: Review | null) => {
      if (!alive || !r) return;
      setInfo((prev) => ({
        ...prev,
        [id]: { title: r.title ?? r.sourceRef, sourceRef: r.sourceRef, source: r.source, status: r.status },
      }));
    };

    // 先定起点再订阅:已在表里的保持原值,新加入的从此刻起算
    const now = Date.now();
    for (const id of ids) if (!watchingSince.current.has(id)) watchingSince.current.set(id, now);

    // 读失败不额外补救:tab 条退回 '…',这枚 tab 后续任何 review / status 事件都会把它补上,
    // 真按不亮时进屏后由 ReviewScreen 自己那套报错接手 —— 别在这儿架一套重试
    for (const id of ids)
      void window.duetlens.review
        .get(id)
        .then((r) => put(id, r))
        .catch(() => {});

    const offs = ids.map((id) =>
      subscribeReviewEvents(id, (e) => {
        // review / status 两支都要认:重跑把状态拉回 scanning 走的是 status,标题与轮次变化走 review
        if (e.type === 'review') put(id, e.payload);
        else if (e.type === 'status')
          setInfo((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], status: e.payload } } : prev));
        else if (e.type === 'finding') {
          if (e.payload.createdAt < (watchingSince.current.get(id) ?? now)) return;
          let seen = counted.current.get(id);
          if (!seen) counted.current.set(id, (seen = new Set()));
          if (seen.has(e.payload.id)) return;
          seen.add(e.payload.id);
          // 正看着的那枚不记未读:它已经在屏上了
          if (activeRef.current === id) return;
          setUnread((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
        }
      }),
    );

    // 关掉的 tab 不留账:重新打开时该是干净的一枚,而不是接着上次的数
    const live = new Set(ids);
    for (const id of counted.current.keys()) if (!live.has(id)) counted.current.delete(id);
    for (const id of watchingSince.current.keys()) if (!live.has(id)) watchingSince.current.delete(id);
    setUnread((prev) => {
      const stale = Object.keys(prev).filter((id) => !live.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });

    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, [key]);

  // 激活即清零。放 effect 而不是在事件里判:未读是"没看过"的意思,看没看以最终停在哪枚为准。
  useEffect(() => {
    if (!activeId) return;
    setUnread((prev) => (prev[activeId] ? { ...prev, [activeId]: 0 } : prev));
  }, [activeId]);

  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(info).map(([id, v]) => [id, { ...v, unread: unread[id] ?? 0 }]),
      ),
    [info, unread],
  );
}
