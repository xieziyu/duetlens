import { useReviewStream } from '../review/useReviewStream';
import './ReviewScreen.css';

// → mockup/diff-review.html:三栏 + 内联 discussion。骨架期先接后端事件流,展示 findings 实时流入。
export function ReviewScreen({ reviewId }: { reviewId: string | null }) {
  const { review, findings, status, tokenUsage, lastTool } = useReviewStream(reviewId);

  if (!reviewId) {
    return <div className="rev-empty">从入口开始一个审核。</div>;
  }

  const pct = tokenUsage?.total ? Math.round((tokenUsage.used / tokenUsage.total) * 100) : null;

  return (
    <section className="rev">
      <header className="rev-bar">
        <span className="rev-title">{review?.title ?? '加载中…'}</span>
        <span className={`badge s-${status ?? 'scanning'}`}>{status ?? '…'}</span>
        <span className="rev-spacer" />
        {lastTool && <span className="mono rev-tool">{lastTool}</span>}
        {tokenUsage && (
          <span className="mono rev-tok">
            {tokenUsage.used.toLocaleString()}
            {pct !== null ? ` · ${pct}%` : ''} tok
          </span>
        )}
      </header>

      <div className="rev-body">
        <div className="rev-findings-head">
          Findings <span className="count">{findings.length}</span>
          {status === 'scanning' && <span className="scanning-dot">扫描中…</span>}
        </div>

        {findings.length === 0 ? (
          <p className="rev-empty-list">
            {status === 'scanning' ? 'codex 正在通读改动,findings 会实时出现…' : '暂无 findings。'}
          </p>
        ) : (
          <ul className="finding-list">
            {findings.map((f) => (
              <li key={f.id} className={`finding sev-${f.severity}`}>
                <div className="finding-top">
                  <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                  {f.category && <span className="mono cat">{f.category}</span>}
                  <span className="mono anchor">
                    {f.file}:{f.line}
                  </span>
                </div>
                <div className="finding-title">{f.title}</div>
                {f.body && <div className="finding-body">{f.body}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
