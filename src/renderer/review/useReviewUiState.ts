import { useCallback, useEffect, useRef, useState } from 'react';

export interface ReviewUiStateHandle {
  /** 已标记「已看」的文件路径(持久化)。 */
  viewed: Set<string>;
  /** 折叠的文件路径(派生的临时态,不持久化)。 */
  collapsed: Set<string>;
  onToggleViewed: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
}

const SAVE_DEBOUNCE_MS = 400;

const toggle = (s: Set<string>, path: string, on: boolean): Set<string> => {
  const next = new Set(s);
  if (on) next.add(path);
  else next.delete(path);
  return next;
};

/**
 * per-review 的「已看/折叠」态:挂载时按 reviewId 从后端 `review_ui_state` 拉取,
 * viewed 改动去抖写回;collapsed 是「标记已看即折叠」派生出的临时折叠态,不持久化,
 * 但恢复时把已看文件默认折叠,与运行时行为一致。
 */
export function useReviewUiState(reviewId: string | null): ReviewUiStateHandle {
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 加载阶段的 setViewed 不应触发写回(否则刚拉到的值又被原样写回一遍)
  const hydrating = useRef(false);

  useEffect(() => {
    if (!reviewId) {
      setViewed(new Set());
      setCollapsed(new Set());
      return;
    }
    let alive = true;
    hydrating.current = true;
    void window.duetlens.review.getUiState(reviewId).then((s) => {
      if (!alive) return;
      const files = new Set(s.viewedFiles);
      setViewed(files);
      setCollapsed(new Set(files));
      hydrating.current = false;
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reviewId]);

  const persist = useCallback(
    (files: Set<string>) => {
      if (!reviewId || hydrating.current) return;
      if (timer.current) clearTimeout(timer.current);
      const snapshot = [...files];
      timer.current = setTimeout(() => {
        void window.duetlens.review.saveUiState(reviewId, {
          viewedFiles: snapshot,
          lastActiveTab: null,
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [reviewId],
  );

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
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return { viewed, collapsed, onToggleViewed, onToggleCollapsed };
}
