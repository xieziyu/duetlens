import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile } from '@shared/diff';
import type { Finding, Review, Severity } from '@shared/domain';
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
  onEditSummary: (body: string) => void;
  onPickCategory: (category: string) => void;
}

export function SummaryTab({ review, findings, discussionCount, diff, onEditSummary, onPickCategory }: SummaryTabProps) {
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

        <SummaryBody body={review?.summaryBody ?? null} onEdit={onEditSummary} />

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

/** 总结正文:轻量 markdown 视图 ↔ textarea 编辑(⌘↵ 保存 / Esc 取消)。 */
function SummaryBody({ body, onEdit }: { body: string | null; onEdit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(body ?? '');
  }, [body, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const save = () => {
    onEdit(draft.trim());
    setEditing(false);
  };

  return (
    <div className={`sum-block${editing ? ' editing' : ''}`}>
      <div className="sb-head">
        总结{' '}
        <span className="sb-edit" onClick={() => setEditing((v) => !v)}>
          {editing ? '收起' : '✎ 编辑'}
        </span>
        <span className="sb-by">
          <span className="gl" />
          {body ? 'agent 生成 · 你可编辑' : '尚未生成'}
        </span>
      </div>
      {editing ? (
        <div className="sb-editor">
          <textarea
            ref={ref}
            className="fe-textarea sb-ta"
            spellCheck={false}
            placeholder="用 Markdown 写审核总结,提交时作为 review body…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
          <div className="fe-foot">
            <button className="save" onClick={save}>
              保存 <span className="kbd">⌘↵</span>
            </button>
            <button className="cancel" onClick={() => setEditing(false)}>
              取消 <span className="kbd">Esc</span>
            </button>
            <span className="fe-note">Markdown · 提交屏 review body 来源</span>
          </div>
        </div>
      ) : body ? (
        <div className="sb-prose">{renderMarkdown(body)}</div>
      ) : (
        <div className="sb-prose empty" onClick={() => setEditing(true)}>
          还没有总结。点此撰写,或让 agent 在对话中生成后回填。
        </div>
      )}
    </div>
  );
}
