import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecentReview } from '@shared/ipc';
import type { ReviewStatus, SourceKind } from '@shared/domain';
import { GhIcon, GitButlerIcon, LocalBranchIcon } from './entry/icons';
import './HistoryScreen.css';

// 全部审核历史屏。数据来自 review:list-recent;
// 搜索 / 来源 & 状态筛选 / 时间分组均在前端做;删除软删 + 撤销,真实删库延迟到宽限期后提交。

type SourceFilter = 'all' | 'github-pr' | 'local-branch' | 'gitbutler-vbranch';
type StatusFilter = 'all' | 'reviewing' | 'submitted' | 'done';
type Bucket = 'today' | 'week' | 'older';

const DELETE_GRACE_MS = 5000;
const DAY_MS = 86_400_000;

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: '全部来源' },
  { id: 'github-pr', label: 'GitHub' },
  { id: 'local-branch', label: '本地' },
  { id: 'gitbutler-vbranch', label: 'GitButler' },
];

const STATUS_TABS: { id: StatusFilter; label: string; dot?: string }[] = [
  { id: 'all', label: '全部状态' },
  { id: 'reviewing', label: '审核中', dot: 'review' },
  { id: 'submitted', label: '已提交', dot: 'submitted' },
  { id: 'done', label: '已完成', dot: 'done' },
];

const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'older', label: '更早' },
];

export function HistoryScreen({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [reviews, setReviews] = useState<RecentReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [srcFilter, setSrcFilter] = useState<SourceFilter>('all');
  const [statFilter, setStatFilter] = useState<StatusFilter>('all');
  /** 软删除中的 id → 宽限期定时器;撤销即清除,超时即真正删库。 */
  const [pending, setPending] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let alive = true;
    void window.duetlens.review.listRecent().then((r) => {
      if (alive) {
        setReviews(r);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // 卸载时把仍在宽限期内的删除立即落库(用户已离开、未撤销),避免丢删。
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const [id, t] of map) {
        clearTimeout(t);
        void window.duetlens.review.delete(id);
      }
      map.clear();
    };
  }, []);

  const softDelete = useCallback((id: string) => {
    setPending((prev) => new Set(prev).add(id));
    const t = setTimeout(() => {
      timers.current.delete(id);
      void window.duetlens.review.delete(id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, DELETE_GRACE_MS);
    timers.current.set(id, t);
  }, []);

  const undoDelete = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (r: RecentReview): boolean => {
      if (srcFilter !== 'all' && r.source !== srcFilter) return false;
      if (statFilter !== 'all' && statusGroup(r.status) !== statFilter) return false;
      if (q) {
        const hay = `${r.title ?? ''} ${repoLabel(r)} ${r.sourceRef}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [srcFilter, statFilter, q],
  );

  const grouped = useMemo(() => {
    const now = Date.now();
    const out: Record<Bucket, RecentReview[]> = { today: [], week: [], older: [] };
    for (const r of reviews) {
      if (!matches(r)) continue;
      out[bucketOf(r.updatedAt, now)].push(r);
    }
    return out;
  }, [reviews, matches]);

  const liveCount = reviews.length - pending.size;
  const shown = grouped.today.length + grouped.week.length + grouped.older.length;

  return (
    <div className="hist">
      <div className="hist-wrap">
        <div className="hist-head">
          <h1>全部审核</h1>
          <span className="n mono">共 {liveCount} 次</span>
        </div>

        <div className="hist-toolbar">
          <div className="hist-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 仓库 / 分支 / PR 号…"
              spellCheck={false}
            />
          </div>
          <div className="hist-filter">
            {SOURCE_TABS.map((t) => (
              <button
                key={t.id}
                className={t.id === srcFilter ? 'on' : ''}
                onClick={() => setSrcFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="hist-filter">
            {STATUS_TABS.map((t) => (
              <button
                key={t.id}
                className={t.id === statFilter ? 'on' : ''}
                onClick={() => setStatFilter(t.id)}
              >
                {t.dot && <span className={`sd ${t.dot}`} />}
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {loaded && shown === 0 ? (
          <div className="hist-empty">
            <div className="ic">◍</div>
            <div>{reviews.length === 0 ? '还没有审核记录' : '没有匹配的审核'}</div>
            <div className="sub">
              {reviews.length === 0
                ? '回到入口发起你的第一次审核,完成后会留在这里。'
                : '换个关键词,或清除来源 / 状态筛选。'}
            </div>
          </div>
        ) : (
          BUCKETS.map(({ id, label }) => {
            const rows = grouped[id];
            if (rows.length === 0) return null;
            return (
              <div className="hist-group" key={id}>
                <div className="gh mono">
                  {label} · {rows.length}
                </div>
                <div className="hist-list">
                  {rows.map((r) =>
                    pending.has(r.id) ? (
                      <div className="hist-rev gone" key={r.id}>
                        <div className="undo">
                          已删除 <b>{r.title ?? r.sourceRef}</b>
                          <button onClick={() => undoDelete(r.id)}>撤销</button>
                        </div>
                      </div>
                    ) : (
                      <div className="hist-rev" key={r.id} onClick={() => onOpen(r.id)}>
                        <SourceBadge source={r.source} sourceRef={r.sourceRef} />
                        <div className="m">
                          <div className="t">{r.title ?? r.sourceRef}</div>
                          <div className="meta mono">{metaParts(r)}</div>
                        </div>
                        <StatusChip status={r.status} />
                        <button
                          className="del"
                          title="删除这条历史"
                          onClick={(e) => {
                            e.stopPropagation();
                            softDelete(r.id);
                          }}
                        >
                          🗑
                        </button>
                        <span className="arrow">→</span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function metaParts(r: RecentReview): React.JSX.Element {
  return (
    <>
      <span>{repoLabel(r)}</span>
      <span className="dot" />
      <span className={r.findingCount === 0 ? 'find zero' : 'find'}>{r.findingCount} findings</span>
      <span className="dot" />
      {r.submittedCount > 0 ? (
        <span className="sub">{r.submittedCount} 已提交</span>
      ) : r.discussionCount > 0 ? (
        <span>{r.discussionCount} discussions</span>
      ) : (
        <span>—</span>
      )}
      <span className="dot" />
      <span>{formatWhen(r.updatedAt)}</span>
    </>
  );
}

function SourceBadge({ source, sourceRef }: { source: SourceKind; sourceRef: string }): React.JSX.Element {
  if (source === 'github-pr') {
    const num = sourceRef.match(/#?(\d+)/)?.[1];
    return (
      <span className="srcbadge gh">
        <GhIcon />
        <b>{num ? `#${num}` : 'PR'}</b>
      </span>
    );
  }
  if (source === 'gitbutler-vbranch') {
    return (
      <span className="srcbadge gb">
        <GitButlerIcon />
        vbranch
      </span>
    );
  }
  return (
    <span className="srcbadge local">
      <LocalBranchIcon />
      本地
    </span>
  );
}

const STATUS_META: Record<ReviewStatus, { cls: string; label: string; pulse?: boolean }> = {
  scanning: { cls: 'review', label: '扫描中', pulse: true },
  reviewing: { cls: 'review', label: '审核中', pulse: true },
  submitted: { cls: 'submitted', label: '✓ 已提交' },
  exported: { cls: 'done', label: '已完成' },
  failed: { cls: 'done', label: '失败' },
};

function StatusChip({ status }: { status: ReviewStatus }): React.JSX.Element {
  const m = STATUS_META[status];
  return (
    <span className={`stat ${m.cls}`}>
      {m.pulse && <span className="pulse" />}
      {m.label}
    </span>
  );
}

/** 状态筛选归组:扫描中/审核中 → reviewing;已提交 → submitted;导出/失败 → done。 */
function statusGroup(status: ReviewStatus): StatusFilter {
  if (status === 'scanning' || status === 'reviewing') return 'reviewing';
  if (status === 'submitted') return 'submitted';
  return 'done';
}

function bucketOf(ts: number, now: number): Bucket {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'today';
  if (ts >= now - 7 * DAY_MS) return 'week';
  return 'older';
}

/** 展示用仓库名:本地路径 basename 优先,其次从 github sourceRef 取 repo 段。 */
function repoLabel(r: RecentReview): string {
  if (r.repoPath) {
    const base = r.repoPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (base) return base;
  }
  if (r.source === 'github-pr') {
    const m = r.sourceRef.match(/([^/]+)\/([^/#]+)/);
    if (m) return m[2];
  }
  return r.source;
}

function formatWhen(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (ts >= startOfToday - DAY_MS) return '昨天';
  if (ts >= now - 7 * DAY_MS) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ts).getDay()];
  }
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
