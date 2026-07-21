import { useEffect, useMemo, useState } from 'react';
import type { Finding, Severity } from '@shared/domain';
import { useReviewStream } from '../review/useReviewStream';
import { FileTree } from './review/FileTree';
import { DiffPane } from './review/DiffPane';
import './ReviewScreen.css';

type RightTab = 'discussion' | 'findings' | 'summary';

const STATUS_LABEL: Record<string, string> = {
  scanning: '扫描中',
  reviewing: '审核中',
  submitted: '已提交',
  exported: '已导出',
  failed: '失败',
};

// → mockup/diff-review.html:三栏(file tree | diff | right panel)。本切片为只读 diff + findings 右栏。
export function ReviewScreen({ reviewId }: { reviewId: string | null }) {
  const { review, findings, diff, status, tokenUsage, lastTool } = useReviewStream(reviewId);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null);
  const [tab, setTab] = useState<RightTab>('findings');

  const focusFinding = (f: Finding) => {
    setActivePath(f.file);
    setFocusFindingId(f.id);
  };

  // diff 到达后默认选中首个文件
  useEffect(() => {
    if (!activePath && diff.length > 0) setActivePath(diff[0].path);
  }, [diff, activePath]);

  const pct = tokenUsage?.total ? Math.round((tokenUsage.used / tokenUsage.total) * 100) : null;

  if (!reviewId) {
    return <div className="rev-empty">从入口开始一个审核。</div>;
  }

  return (
    <div className="rev-root">
      <div className="rev-topbar">
        <div className="source">
          <span className="mono ref">{review?.sourceRef ?? '…'}</span>
          <span className="title">{review?.title ?? '加载中…'}</span>
        </div>
        <span className="spacer" />
        <div className="meta">
          {lastTool && <span className="mono tool" title="最近工具调用">{lastTool}</span>}
          {tokenUsage && (
            <span className="tokens">
              {pct !== null && (
                <svg className="ring" viewBox="0 0 18 18" style={{ ['--ctx' as string]: (pct / 100).toString() }}>
                  <circle className="bg" cx="9" cy="9" r="7" />
                  <circle className="fg" cx="9" cy="9" r="7" />
                </svg>
              )}
              {tokenUsage.used.toLocaleString()} tok
            </span>
          )}
          <span className={`status s-${status ?? 'scanning'}`}>
            {(status === 'scanning' || !status) && <span className="pulse" />}
            {STATUS_LABEL[status ?? 'scanning'] ?? status}
          </span>
        </div>
      </div>

      <div className="rev-main">
        <FileTree
          files={diff}
          findings={findings}
          activePath={activePath}
          onSelect={setActivePath}
        />
        <DiffPane
          files={diff}
          findings={findings}
          activePath={activePath}
          focusFindingId={focusFindingId}
        />
        <RightPanel
          tab={tab}
          onTab={setTab}
          findings={findings}
          scanning={status === 'scanning' || !status}
          onPickFinding={focusFinding}
        />
      </div>
    </div>
  );
}

const SEV_ORDER: Severity[] = ['high', 'medium', 'low'];
const SEV_LABEL: Record<Severity, string> = { high: 'High', medium: 'Med', low: 'Low' };

function RightPanel({
  tab,
  onTab,
  findings,
  scanning,
  onPickFinding,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  findings: Finding[];
  scanning: boolean;
  onPickFinding: (f: Finding) => void;
}) {
  const grouped = useMemo(() => {
    const g: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
    for (const f of findings) g[f.severity].push(f);
    return g;
  }, [findings]);

  return (
    <div className="right pane">
      <div className="tabs">
        {(['discussion', 'findings', 'summary'] as RightTab[]).map((t) => (
          <button key={t} className={`tab${t === tab ? ' on' : ''}`} onClick={() => onTab(t)}>
            {t === 'discussion' ? '讨论' : t === 'findings' ? 'Findings' : 'Summary'}
            {t === 'findings' && findings.length > 0 && <span className="tab-count">{findings.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'findings' && (
        <div className="tab-body">
          {scanning && (
            <div className="scan-note">
              <span className="pulse" /> codex 正在通读改动,findings 会实时出现…
            </div>
          )}
          {findings.length === 0 && !scanning && <p className="empty-note">暂无 findings。</p>}
          {SEV_ORDER.map((sev) =>
            grouped[sev].length === 0 ? null : (
              <div key={sev} className="frow-group">
                <div className={`frow-head sev-${sev}`}>
                  {SEV_LABEL[sev]} <span className="n">{grouped[sev].length}</span>
                </div>
                {grouped[sev].map((f) => (
                  <button key={f.id} className="frow" onClick={() => onPickFinding(f)}>
                    <span className={`sev sev-${f.severity}`}>{SEV_LABEL[f.severity]}</span>
                    <span className="frow-main">
                      <span className="frow-title">{f.title}</span>
                      <span className="mono frow-anchor">
                        {f.category ? `${f.category} · ` : ''}
                        {f.file}:{f.line}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      )}

      {tab === 'discussion' && (
        <div className="tab-body">
          <p className="empty-note">讨论线程即将接入(后续切片)。</p>
        </div>
      )}
      {tab === 'summary' && (
        <div className="tab-body">
          <p className="empty-note">审核总结即将接入(后续切片)。</p>
        </div>
      )}
    </div>
  );
}
