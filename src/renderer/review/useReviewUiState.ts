import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewUiState } from '@shared/domain';

export interface ReviewUiStateHandle {
  /** 已标记「已看」的文件路径(持久化)。 */
  viewed: Set<string>;
  /** 折叠的文件路径(派生的临时态,不持久化)。 */
  collapsed: Set<string>;
  /** 该 review 最近停留的右栏 tab(持久化);无记忆时为 null,由调用方回落到全局默认。 */
  activeTab: string | null;
  onToggleViewed: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
  /** 只展开、不折叠:跳转前用来保证目标文件的内容确实在 DOM 里。 */
  expandFile: (path: string) => void;
  setActiveTab: (tab: string) => void;
}

const SAVE_DEBOUNCE_MS = 400;

const toggle = (s: Set<string>, path: string, on: boolean): Set<string> => {
  const next = new Set(s);
  if (on) next.add(path);
  else next.delete(path);
  return next;
};

/**
 * per-review 的 UI 进度态:挂载时按 reviewId 从后端 `review_ui_state` 拉取,改动去抖写回。
 * - viewed = 已看文件(持久化);collapsed 是「标记已看即折叠」派生的临时态,不持久化,
 *   但恢复时把已看文件默认折叠,与运行时行为一致。
 * - activeTab = 该 review 最近停留的右栏 tab(持久化),回来时定位到上次所在 tab。
 * viewed 与 activeTab 同占 review_ui_state 一行,故写回始终以镜像快照整体 upsert。
 */
export function useReviewUiState(
  reviewId: string | null,
  collapseOnViewed = true,
): ReviewUiStateHandle {
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTabState] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 加载阶段的 set* 不应触发写回(否则刚拉到的值又被原样写回一遍)
  const hydrating = useRef(false);
  // 本次加载期间已被显式改过的字段:回填不得盖掉它们。通知点开某条讨论会在 getUiState
  // 回来之前就把 tab 切好,拿库里的旧值盖回去等于把刚做的定位吞掉,而且那次改动
  // 还因为 hydrating 压着写回而彻底消失。
  const touched = useRef({ viewed: false, tab: false });
  // 最新持久化字段镜像:去抖 flush 从此整体快照,避免改一字段抹掉另一字段
  const stateRef = useRef<ReviewUiState>({ viewedFiles: [], lastActiveTab: null });

  const flush = useCallback(() => {
    if (!reviewId || hydrating.current) return;
    if (timer.current) clearTimeout(timer.current);
    const snapshot: ReviewUiState = { ...stateRef.current };
    timer.current = setTimeout(() => {
      void window.duetlens.review.saveUiState(reviewId, snapshot);
    }, SAVE_DEBOUNCE_MS);
  }, [reviewId]);

  useEffect(() => {
    if (!reviewId) {
      setViewed(new Set());
      setCollapsed(new Set());
      setActiveTabState(null);
      stateRef.current = { viewedFiles: [], lastActiveTab: null };
      return;
    }
    let alive = true;
    hydrating.current = true;
    touched.current = { viewed: false, tab: false };
    void window.duetlens.review.getUiState(reviewId).then((s) => {
      if (!alive) return;
      const stored = new Set(s.viewedFiles);
      // 加载期间动过的字段以本地为准。viewed 取并集:那时列表还是空的,当时的勾选
      // 只可能是新增,拿本地覆盖会把库里已看过的文件抹掉。
      const files = touched.current.viewed ? new Set([...stored, ...stateRef.current.viewedFiles]) : stored;
      const tab = touched.current.tab ? stateRef.current.lastActiveTab : s.lastActiveTab;
      setViewed(files);
      setCollapsed(collapseOnViewed ? new Set(files) : new Set());
      setActiveTabState(tab);
      stateRef.current = { viewedFiles: [...files], lastActiveTab: tab };
      hydrating.current = false;
      // 加载期间被压住的那次写回补上,否则这次改动只活在内存里
      if (touched.current.viewed || touched.current.tab) flush();
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reviewId, collapseOnViewed, flush]);

  const onToggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => toggle(prev, path, !prev.has(path)));
  }, []);

  const expandFile = useCallback((path: string) => {
    setCollapsed((prev) => (prev.has(path) ? toggle(prev, path, false) : prev));
  }, []);

  // 标记已看同时折叠;取消已看则展开
  const onToggleViewed = useCallback(
    (path: string) => {
      touched.current.viewed = true;
      setViewed((prev) => {
        const nowViewed = !prev.has(path);
        if (collapseOnViewed) setCollapsed((c) => toggle(c, path, nowViewed));
        const next = toggle(prev, path, nowViewed);
        stateRef.current = { ...stateRef.current, viewedFiles: [...next] };
        flush();
        return next;
      });
    },
    [flush, collapseOnViewed],
  );

  const setActiveTab = useCallback(
    (tab: string) => {
      touched.current.tab = true;
      setActiveTabState(tab);
      stateRef.current = { ...stateRef.current, lastActiveTab: tab };
      flush();
    },
    [flush],
  );

  return { viewed, collapsed, activeTab, onToggleViewed, onToggleCollapsed, expandFile, setActiveTab };
}
