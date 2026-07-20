import { useEffect, useState } from 'react';
import type { Finding, Review } from '@shared/domain';
import type { AgentEvent } from '@shared/agent-events';

export interface ReviewStreamState {
  review: Review | null;
  findings: Finding[];
  status: Review['status'] | null;
  tokenUsage: { used: number; total?: number } | null;
  lastTool: string | null;
}

/**
 * 订阅一次 review 的 server-state:先拉初值,再随 IPC review:event 增量更新。
 * 前端不臆造权威数据,只反映后端推来的领域事件(见 frontend-components.md 状态分层)。
 */
export function useReviewStream(reviewId: string | null): ReviewStreamState {
  const [review, setReview] = useState<Review | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [status, setStatus] = useState<Review['status'] | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; total?: number } | null>(null);
  const [lastTool, setLastTool] = useState<string | null>(null);

  useEffect(() => {
    if (!reviewId) return;
    let alive = true;

    void window.duetlens.review.get(reviewId).then((r) => {
      if (alive) {
        setReview(r);
        setStatus(r?.status ?? null);
      }
    });
    void window.duetlens.review.findings(reviewId).then((f) => alive && setFindings(f));

    const off = window.duetlens.review.onEvent((e) => {
      if (e.reviewId !== reviewId) return;
      if (e.type === 'finding') {
        // upsert:新 finding 追加,已存在的(update_finding 回写)就地替换
        setFindings((prev) => {
          const i = prev.findIndex((x) => x.id === e.payload.id);
          if (i < 0) return [...prev, e.payload];
          const next = prev.slice();
          next[i] = e.payload;
          return next;
        });
      } else if (e.type === 'status') {
        setStatus(e.payload);
      } else if (e.type === 'agent') {
        const ev = e.payload as AgentEvent;
        if (ev.kind === 'token-usage') setTokenUsage({ used: ev.used, total: ev.total });
        if (ev.kind === 'tool-call') setLastTool(`${ev.server}/${ev.tool} · ${ev.status}`);
      }
    });

    return () => {
      alive = false;
      off();
    };
  }, [reviewId]);

  return { review, findings, status, tokenUsage, lastTool };
}
