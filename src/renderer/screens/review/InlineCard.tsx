import type { Finding, Severity } from '@shared/domain';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };

export interface InlineCardProps {
  finding: Finding;
  /** 被右栏点选定位时短暂高亮 */
  focused?: boolean;
}

/**
 * 锚定在 diff 行处的内联 finding 卡(对齐 mockup .card / .c-view)。
 * 本切片只读 view 态;编辑/剔除/追问(edit/dismissed/submitted 态 + 写路径)归后续切片。
 */
export function InlineCard({ finding, focused }: InlineCardProps) {
  const isAgent = finding.origin === 'agent';
  const submitted = finding.submission === 'submitted';
  const dismissed = finding.triage === 'dismiss';

  return (
    <div className="inline" id={`finding-${finding.id}`}>
      <div
        className={
          `card ${isAgent ? 'agent' : 'human'} finding` +
          (focused ? ' focused' : '') +
          (submitted ? ' submitted' : '') +
          (dismissed ? ' dismissed' : '')
        }
      >
        <div className="c-view">
          <div className="c-head">
            <span className="who">
              <span className={`av ${isAgent ? 'agent' : 'human'}`}>{isAgent ? '◆' : '●'}</span>
              {isAgent ? 'codex' : finding.origin === 'promoted' ? '你 · 提升' : '你'}
            </span>
            <span className={`sev sev-${finding.severity}`}>
              {SEV_LABEL[finding.severity]}
              {finding.category ? ` · ${finding.category}` : ''}
            </span>
            {isAgent && (
              <span className="tool-tag">
                via <b>report_finding()</b>
              </span>
            )}
          </div>
          <div className="c-body">
            <strong>{finding.title}</strong>
            {finding.body && <p className="c-body-text">{finding.body}</p>}
          </div>
          {finding.suggestion && (
            <div className="card-meta">
              <span className="dia">◇</span> 附给 author 的 suggestion · 提交时渲染为 GitHub suggestion 块
            </div>
          )}
          <div className="card-foot">
            <span className="mono anchor-tag">
              {finding.file}:{finding.line}
            </span>
            {submitted && finding.submittedUrl && (
              <span className="sub-tag">✓ 已提交</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
