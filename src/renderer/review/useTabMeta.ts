import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Review, ReviewStatus } from '@shared/domain';
import { subscribeReviewEvents } from './review-event-bus';

/** tab 条要显示的那一点点信息;正文数据仍归各 tab 自己的 `useReviewStream`。 */
export interface TabMeta {
  title: string;
  sourceRef: string;
  source: Review['source'];
  /** 悬浮卡要的项目名从它来(见 repoName);github 源可以没有 */
  repoPath: string | null;
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

  /**
   * 已订阅的 review → 退订钩子 + 这一轮订阅的序号。**开关一枚 tab 只动这张表里的一项**:整表重建的话,
   * 每次开合都要把所有已开 review 重订阅并重拉一遍(上限二十枚就是二十次 IPC),而且重订阅之间那道缝里
   * 到达的事件谁都收不到。
   *
   * 序号是**关掉再重开同一条**时的身份:光看 id 在不在表里,上一轮的在途请求会被当成这一轮的
   * (「重新打开」就是一颗按钮,这个来回很短),旧快照落地时把重开后已经更新过的标题 / 状态盖回去。
   */
  const subs = useRef(new Map<string, { off: () => void; gen: number }>());
  const nextGen = useRef(0);

  const put = useCallback((id: string, r: Review | null) => {
    if (!r) return;
    setInfo((prev) => ({
      ...prev,
      [id]: {
        title: r.title ?? r.sourceRef,
        sourceRef: r.sourceRef,
        source: r.source,
        repoPath: r.repoPath,
        status: r.status,
      },
    }));
  }, []);

  /**
   * 拉一条 review 的 tab 元信息;失败退避重试两次。**必须自己重试** —— 未激活的 tab 屏上没有
   * ReviewScreen,而 `status` 事件只能给已有记录改状态、补不出标题,拉不到就一直停在 '…'。
   * (旧写法每次开合都重拉全表,顺带把失败的也重试了;改成增量订阅后这条补救没了。)
   */
  const load = useCallback(
    (id: string, gen: number) => {
      // 认序号而不只认 id:关掉再重开会让同一个 id 重新出现在表里
      const mine = (): boolean => subs.current.get(id)?.gen === gen;
      let left = 2;
      const attempt = (): void => {
        // 每次触发都问一遍,而不是只在排期时问:退避那几百毫秒里 tab 完全可能已经被关掉
        if (!mine()) return;
        void window.duetlens.review
          .get(id)
          // 查到不存在(null)不重试:那是 App 的恢复那条路负责剔除的事
          .then((r) => {
            if (mine()) put(id, r);
          })
          .catch(() => {
            // 读失败多半是 IPC 抖一下 / 库被锁住;退光了就认了 —— tab 条停在 '…',
            // 真按不亮时进屏后由 ReviewScreen 自己那套报错接手
            if (left-- > 0) window.setTimeout(attempt, 600);
          });
      };
      attempt();
    },
    [put],
  );

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const live = new Set(ids);

    // 新加入的才建:先定起点再订阅,已在表里的保持原值
    const now = Date.now();
    for (const id of ids) {
      if (subs.current.has(id)) continue;
      if (!watchingSince.current.has(id)) watchingSince.current.set(id, now);
      const gen = ++nextGen.current;
      subs.current.set(id, {
        gen,
        off: subscribeReviewEvents(id, (e) => {
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
      });
      load(id, gen);
    }

    // 关掉的 tab 不留账:重新打开时该是干净的一枚,而不是接着上次的数
    for (const [id, sub] of subs.current) {
      if (live.has(id)) continue;
      sub.off();
      subs.current.delete(id);
      counted.current.delete(id);
      watchingSince.current.delete(id);
    }
    setUnread((prev) => {
      const stale = Object.keys(prev).filter((id) => !live.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [key, load]);

  /**
   * 整表退订只发生在卸载。**必须是单独一条 effect** —— 挂到上面那条(跟着 key 走)的 cleanup 上,
   * 就又变回每次开合全退全订了。
   */
  useEffect(
    () => () => {
      for (const sub of subs.current.values()) sub.off();
      subs.current.clear();
    },
    [],
  );

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
