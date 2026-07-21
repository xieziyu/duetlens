import { useCallback, useEffect, useRef, useState } from 'react';
import type { Discussion, Finding, Message, Review } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { AgentEvent } from '@shared/agent-events';

export interface ReviewStreamState {
  review: Review | null;
  findings: Finding[];
  discussions: Discussion[];
  /** 结构化 diff;首帧拉取,scan 期已落库故立即可得 */
  diff: DiffFile[];
  /** 按 discussionId 聚合的消息(user/agent),随 message 事件增量追加 */
  messages: Record<string, Message[]>;
  status: Review['status'] | null;
  tokenUsage: { used: number; total?: number } | null;
  lastTool: string | null;
  /** 懒加载一条 discussion 的历史消息(续接的旧 review);实时消息仍走事件流。 */
  ensureMessages: (discussionId: string) => void;
}

/**
 * 订阅一次 review 的 server-state:先拉初值,再随 IPC review:event 增量更新。
 * 前端不臆造权威数据,只反映后端推来的领域事件(见 frontend-components.md 状态分层)。
 */
export function useReviewStream(reviewId: string | null): ReviewStreamState {
  const [review, setReview] = useState<Review | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [diff, setDiff] = useState<DiffFile[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [status, setStatus] = useState<Review['status'] | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; total?: number } | null>(null);
  const [lastTool, setLastTool] = useState<string | null>(null);
  // 已发起过历史拉取的 discussionId,避免重复 fetch(实时消息由事件流补充)
  const fetched = useRef<Set<string>>(new Set());

  const ensureMessages = useCallback(
    (discussionId: string) => {
      if (!reviewId || fetched.current.has(discussionId)) return;
      fetched.current.add(discussionId);
      void window.duetlens.review.messages(discussionId).then((list) => {
        if (list.length === 0) return;
        setMessages((prev) => {
          const bucket = prev[discussionId] ?? [];
          const seen = new Set(bucket.map((m) => m.id));
          const merged = [...bucket, ...list.filter((m) => !seen.has(m.id))];
          merged.sort((a, b) => a.createdAt - b.createdAt);
          return { ...prev, [discussionId]: merged };
        });
      });
    },
    [reviewId],
  );

  useEffect(() => {
    if (!reviewId) return;
    let alive = true;
    setMessages({});
    setDiff([]);
    fetched.current = new Set();

    void window.duetlens.review.get(reviewId).then((r) => {
      if (alive) {
        setReview(r);
        setStatus(r?.status ?? null);
      }
    });
    void window.duetlens.review.findings(reviewId).then((f) => alive && setFindings(f));
    void window.duetlens.review.discussions(reviewId).then((d) => alive && setDiscussions(d));
    void window.duetlens.review.diff(reviewId).then((d) => alive && setDiff(d));

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
      } else if (e.type === 'discussion') {
        setDiscussions((prev) =>
          prev.some((d) => d.id === e.payload.id) ? prev : [...prev, e.payload],
        );
      } else if (e.type === 'message') {
        const m = e.payload;
        setMessages((prev) => {
          const bucket = prev[m.discussionId] ?? [];
          if (bucket.some((x) => x.id === m.id)) return prev;
          return { ...prev, [m.discussionId]: [...bucket, m] };
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

  return { review, findings, discussions, diff, messages, status, tokenUsage, lastTool, ensureMessages };
}
