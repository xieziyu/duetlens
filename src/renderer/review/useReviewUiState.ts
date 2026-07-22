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
export function useReviewUiState(reviewId: string | null): ReviewUiStateHandle {
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTabState] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 加载阶段的 set* 不应触发写回(否则刚拉到的值又被原样写回一遍)
  const hydrating = useRef(false);
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
    void window.duetlens.review.getUiState(reviewId).then((s) => {
      if (!alive) return;
      const files = new Set(s.viewedFiles);
      setViewed(files);
      setCollapsed(new Set(files));
      setActiveTabState(s.lastActiveTab);
      stateRef.current = { viewedFiles: [...files], lastActiveTab: s.lastActiveTab };
      hydrating.current = false;
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reviewId]);

  const onToggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => toggle(prev, path, !prev.has(path)));
  }, []);

  // 标记已看同时折叠;取消已看则展开
  const onToggleViewed = useCallback(
    (path: string) => {
      setViewed((prev) => {
        const nowViewed = !prev.has(path);
        setCollapsed((c) => toggle(c, path, nowViewed));
        const next = toggle(prev, path, nowViewed);
        stateRef.current = { ...stateRef.current, viewedFiles: [...next] };
        flush();
        return next;
      });
    },
    [flush],
  );

  const setActiveTab = useCallback(
    (tab: string) => {
      setActiveTabState(tab);
      stateRef.current = { ...stateRef.current, lastActiveTab: tab };
      flush();
    },
    [flush],
  );

  return { viewed, collapsed, activeTab, onToggleViewed, onToggleCollapsed, setActiveTab };
}
