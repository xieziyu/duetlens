import { useMemo } from 'react';
import type { DiffFile } from '@shared/diff';
import {
  isLegacySummary,
  isSummaryStale,
  type Finding,
  type Review,
  type Severity,
} from '@shared/domain';
import { renderMarkdown } from './markdown';

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** codex 建议的 review event(仅建议,最终提交时确认):按未剔除 findings 的最高严重度推导。 */
function deriveVerdict(active: Finding[]): { kind: 'rc' | 'comment' | 'approve'; label: string; ic: string } {
  if (active.some((f) => f.severity === 'high')) return { kind: 'rc', label: 'Request changes', ic: '✕' };
  if (active.length > 0) return { kind: 'comment', label: 'Comment', ic: '◇' };
  return { kind: 'approve', label: 'Approve', ic: '✓' };
}

export interface SummaryTabProps {
  review: Review | null;
  findings: Finding[];
  discussionCount: number;
  diff: DiffFile[];
  onPickCategory: (category: string) => void;
  onOpenFile: (path: string) => void;
}

export function SummaryTab({
  review,
  findings,
  discussionCount,
  diff,
  onPickCategory,
  onOpenFile,
}: SummaryTabProps) {
  const active = useMemo(() => findings.filter((f) => f.triage !== 'dismiss'), [findings]);
  const verdict = deriveVerdict(active);

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0, kept: 0, submitted: 0 };
    for (const f of findings) {
      c[f.severity]++;
      if (f.triage !== 'dismiss') c.kept++;
      if (f.submission === 'submitted') c.submitted++;
    }
    return c;
  }, [findings]);

  // 按 category 聚合(未剔除),每组取最高严重度作圆点、条数作角标
  const topics = useMemo(() => {
    const m = new Map<string, { cat: string; sev: Severity; note: string; n: number }>();
    for (const f of active) {
      const cat = f.category ?? '未分类';
      const cur = m.get(cat);
      if (!cur) m.set(cat, { cat, sev: f.severity, note: f.title, n: 1 });
      else {
        cur.n++;
        if (SEV_RANK[f.severity] > SEV_RANK[cur.sev]) {
          cur.sev = f.severity;
          cur.note = f.title;
        }
      }
    }
    return [...m.values()].sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
  }, [active]);

  // 正文与重点文件只可能被 write_summary 同时写入,故共用一个轮次判定
  const stale = review ? isSummaryStale(review) : false;
  // 旧版本人工写的正文:不能挂在 agent 名下(重点文件那栏不受影响 —— 只有 agent 写过)
  const legacy = review ? isLegacySummary(review) : false;

  // 重点文件可以锚在 diff 之外(协议允许 off-diff 隐患),那类跳不过去,标出来而不是给一个空点击
  const focusFiles = useMemo(() => {
    const inDiff = new Set(diff.map((f) => f.path));
    return (review?.summaryFiles ?? []).map((f) => ({ ...f, inDiff: inDiff.has(f.path) }));
  }, [review?.summaryFiles, diff]);

  const additions = diff.reduce((s, f) => s + f.additions, 0);
  const deletions = diff.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="summary-panel">
      <div className="sum-scroll">
        <div className={`sum-verdict ${verdict.kind}`}>
          <div className="sv-head">
            <span className="sv-ic">{verdict.ic}</span> agent 建议 <b>{verdict.label}</b>
          </div>
          <div className="sv-meta">◇ 仅建议 · 最终 event 在提交时确认</div>
        </div>

        <div className="sum-stats">
          <Stat n={counts.high} label="high" color="var(--sev-high)" />
          <Stat n={counts.medium} label="med" color="var(--sev-med)" />
          <Stat n={counts.low} label="low" color="var(--sev-low)" />
          <div className="st-div" />
          <Stat n={counts.kept} label="保留" />
          <Stat n={counts.submitted} label="已提交" />
          <Stat n={discussionCount} label="讨论" />
        </div>

        <SummaryBody body={review?.summaryBody ?? null} stale={stale} legacy={legacy} />

        {focusFiles.length > 0 && (
          <div className="sum-block">
            <div className="sb-head">
              重点关注文件{' '}
              <span className={`sb-by${stale ? ' stale' : ''}`}>
                {stale ? `第 ${review?.summaryRound} 轮挑出 · 可能已修复` : 'agent 挑出 · 需人工复核'}
              </span>
            </div>
            {focusFiles.map((f) => (
              <button
                key={f.path}
                className="focus-file"
                disabled={!f.inDiff}
                title={f.inDiff ? '跳到 diff 对应文件' : '不在本次 diff 内,无法跳转'}
                onClick={() => onOpenFile(f.path)}
              >
                <span className="ff-path">{f.path}</span>
                <span className="ff-note">{f.note}</span>
              </button>
            ))}
          </div>
        )}

        {topics.length > 0 && (
          <div className="sum-block">
            <div className="sb-head">
              关注主题 <span className="sb-by">点击筛选 findings</span>
            </div>
            {topics.map((t) => (
              <button key={t.cat} className="theme" onClick={() => onPickCategory(t.cat)}>
                <span className={`th-dot ${t.sev === 'medium' ? 'med' : t.sev}`} />
                <span className="th-cat">{t.cat}</span>
                <span className="th-note">{t.note}</span>
                <span className="th-n">{t.n}</span>
              </button>
            ))}
          </div>
        )}

        <div className="sum-cov">
          覆盖 {diff.length} 文件 · +{additions} −{deletions} · read-only sandbox
        </div>
      </div>

      <div className="sum-foot">
        <button className="sum-submit" disabled title="提交屏为后续切片">
          提交 review · 保留 {counts.kept} 条 <span className="arr">→</span>
        </button>
      </div>
    </div>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <div className="st">
      <span className="st-n" style={color ? { color } : undefined}>
        {n}
      </span>
      <span className="st-l">{label}</span>
    </div>
  );
}

/** 总结正文:agent 产出,只读呈现(不进提交与导出,故没有人工编辑入口)。 */
function SummaryBody({
  body,
  stale,
  legacy,
}: {
  body: string | null;
  stale: boolean;
  legacy: boolean;
}) {
  return (
    <div className="sum-block">
      <div className="sb-head">
        总结
        <span className={`sb-by${stale || legacy ? ' stale' : ''}`}>
          {!legacy && <span className="gl" />}
          {!body
            ? '尚未生成'
            : legacy
              ? '旧版本里你自己写的 · 下次机审会覆盖'
              : stale
                ? '上一轮的总结 · 本轮未重写'
                : 'agent 生成'}
        </span>
      </div>
      {body ? (
        <div className="sb-prose">{renderMarkdown(body)}</div>
      ) : (
        <div className="sb-prose empty">本轮机审还没有写总结。</div>
      )}
    </div>
  );
}
