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
  /** 乐观插入一条本地 user 消息(立即上屏),权威 message 事件到达时按文本去重替换;返回临时 id。 */
  addPendingMessage: (discussionId: string, text: string) => string;
  /** 移除一条消息(发送失败时清理乐观占位)。 */
  dropMessage: (discussionId: string, id: string) => void;
}

/**
 * 穷尽性哨兵:ReviewEvent 的分支被全部消费时,参数才是 never —— 新增一支而漏处理即编译失败。
 * 运行时只告警不抛:main 比 renderer 新时(热更/回滚)收到未知事件应静默跳过,而非崩掉整条事件流。
 */
function assertExhaustive(e: never): void {
  console.warn('[review-stream] 未处理的 review 事件', e);
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

  const pendingSeq = useRef(0);
  const addPendingMessage = useCallback((discussionId: string, text: string): string => {
    const id = `pending-${pendingSeq.current++}`;
    const msg: Message = { id, discussionId, role: 'user', text, createdAt: Date.now() };
    setMessages((prev) => ({ ...prev, [discussionId]: [...(prev[discussionId] ?? []), msg] }));
    return id;
  }, []);

  const dropMessage = useCallback((discussionId: string, id: string) => {
    setMessages((prev) => {
      const bucket = prev[discussionId];
      if (!bucket) return prev;
      return { ...prev, [discussionId]: bucket.filter((m) => m.id !== id) };
    });
  }, []);

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

    // switch + 兜底哨兵:ReviewEvent 新增一支而这里漏处理,编译期即报错(见 assertExhaustive)
    const off = window.duetlens.review.onEvent((e) => {
      if (e.reviewId !== reviewId) return;
      switch (e.type) {
        case 'finding': {
          // upsert:新 finding 追加,已存在的(update_finding 回写)就地替换
          const f = e.payload;
          setFindings((prev) => {
            const i = prev.findIndex((x) => x.id === f.id);
            if (i < 0) return [...prev, f];
            const next = prev.slice();
            next[i] = f;
            return next;
          });
          return;
        }
        case 'discussion': {
          // upsert:新 discussion 追加,已存在的(如 promote 后 kind 变更)就地替换
          const d = e.payload;
          setDiscussions((prev) => {
            const i = prev.findIndex((x) => x.id === d.id);
            if (i < 0) return [...prev, d];
            const next = prev.slice();
            next[i] = d;
            return next;
          });
          return;
        }
        case 'message': {
          const m = e.payload;
          setMessages((prev) => {
            const bucket = prev[m.discussionId] ?? [];
            if (bucket.some((x) => x.id === m.id)) return prev;
            // 权威 user 消息到达:替换掉同文本的乐观占位(pending-*),避免重复
            const cleaned =
              m.role === 'user'
                ? bucket.filter((x) => !(x.id.startsWith('pending-') && x.text === m.text))
                : bucket;
            return { ...prev, [m.discussionId]: [...cleaned, m] };
          });
          return;
        }
        case 'messages-cleared': {
          const { discussionId } = e;
          setMessages((prev) => (prev[discussionId] ? { ...prev, [discussionId]: [] } : prev));
          return;
        }
        case 'review':
          setReview(e.payload);
          setStatus(e.payload.status);
          return;
        case 'status':
          setStatus(e.payload);
          return;
        case 'agent':
          // agent 流是 firehose,只挑要上屏的两支;其余 kind 有意不处理
          applyAgentEvent(e.payload);
          return;
        default:
          assertExhaustive(e);
      }
    });

    function applyAgentEvent(ev: AgentEvent): void {
      if (ev.kind === 'token-usage') setTokenUsage({ used: ev.used, total: ev.total });
      if (ev.kind === 'tool-call') setLastTool(`${ev.server}/${ev.tool} · ${ev.status}`);
    }

    return () => {
      alive = false;
      off();
    };
  }, [reviewId]);

  return {
    review,
    findings,
    discussions,
    diff,
    messages,
    status,
    tokenUsage,
    lastTool,
    ensureMessages,
    addPendingMessage,
    dropMessage,
  };
}
