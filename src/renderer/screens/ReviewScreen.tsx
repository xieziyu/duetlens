import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Finding, Severity, Triage } from '@shared/domain';
import type { FindingEditInput } from '@shared/ipc';
import { useReviewStream } from '../review/useReviewStream';
import { FileTree } from './review/FileTree';
import { DiffPane } from './review/DiffPane';
import { Resizer } from './review/Resizer';
import './ReviewScreen.css';
import './review/review-syntax.css';

const LEFT_MIN = 180;
const LEFT_MAX = 460;
const RIGHT_MIN = 300;
const RIGHT_MAX = 620;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  // 栏宽:本地拖拽态,持久化(后端 settings)后续接入
  const [leftW, setLeftW] = useState(236);
  const [rightW, setRightW] = useState(380);

  const focusFinding = (f: Finding) => {
    setActivePath(f.file);
    setFocusFindingId(f.id);
  };

  // 写路径:落库后经 review:event 回推刷新(useReviewStream upsert),前端不本地臆造。
  const onTriage = useCallback(
    (finding: Finding, triage: Triage) => {
      if (!reviewId) return;
      void window.duetlens.review.setTriage(reviewId, finding.id, triage);
    },
    [reviewId],
  );
  const onUpdate = useCallback(
    (input: FindingEditInput) => {
      if (!reviewId) return;
      void window.duetlens.review.updateFinding(reviewId, input);
    },
    [reviewId],
  );

  // diff 到达后默认选中首个文件
  useEffect(() => {
    if (!activePath && diff.length > 0) setActivePath(diff[0].path);
  }, [diff, activePath]);

  const pct = tokenUsage?.total ? Math.round((tokenUsage.used / tokenUsage.total) * 100) : null;

  if (!reviewId) {
    return <div className="rev-empty">从入口开始一个审核。</div>;
  }

  return (
    <div
      className="rev-root"
      style={{ ['--left-w' as string]: `${leftW}px`, ['--right-w' as string]: `${rightW}px` }}
    >
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
        <Resizer onDrag={(dx) => setLeftW((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))} />
        <DiffPane
          files={diff}
          findings={findings}
          activePath={activePath}
          focusFindingId={focusFindingId}
          onTriage={onTriage}
          onUpdate={onUpdate}
        />
        <Resizer onDrag={(dx) => setRightW((w) => clamp(w - dx, RIGHT_MIN, RIGHT_MAX))} />
        <RightPanel
          tab={tab}
          onTab={setTab}
          findings={findings}
          scanning={status === 'scanning' || !status}
          onPickFinding={focusFinding}
          onTriage={onTriage}
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
  onTriage,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  findings: Finding[];
  scanning: boolean;
  onPickFinding: (f: Finding) => void;
  onTriage: (finding: Finding, triage: Triage) => void;
}) {
  const grouped = useMemo(() => {
    const g: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
    for (const f of findings) g[f.severity].push(f);
    return g;
  }, [findings]);
  const kept = findings.filter((f) => f.triage === 'keep').length;
  const dropped = findings.filter((f) => f.triage === 'dismiss').length;

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
          {findings.length > 0 && (
            <div className="fp-toolbar">
              <span className="fp-tally">
                保留 <b>{kept}</b> · 剔除 {dropped}
              </span>
            </div>
          )}
          {SEV_ORDER.map((sev) =>
            grouped[sev].length === 0 ? null : (
              <div key={sev} className="fgroup">
                <div className="fg-head">
                  <span className={`sev sev-${sev}`}>{SEV_LABEL[sev]}</span>
                  <span className="fg-n">{grouped[sev].length}</span>
                  <span className="fg-line" />
                </div>
                {grouped[sev].map((f) => (
                  <FindingRow key={f.id} finding={f} onPick={onPickFinding} onTriage={onTriage} />
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

const ORIGIN_LABEL: Record<Finding['origin'], string> = {
  agent: 'codex',
  manual: '你',
  promoted: '你 · 提升',
};

/** 右栏 Findings tab 单行:锚点导航 + triage(保留/剔除/恢复)。 */
function FindingRow({
  finding: f,
  onPick,
  onTriage,
}: {
  finding: Finding;
  onPick: (f: Finding) => void;
  onTriage: (finding: Finding, triage: Triage) => void;
}) {
  const submitted = f.submission === 'submitted';
  const dismissed = f.triage === 'dismiss';
  const rowClass =
    'frow' +
    (submitted ? ' submitted' : f.triage === 'keep' ? ' kept' : '') +
    (dismissed ? ' dismissed' : '');
  const triage = (t: Triage) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onTriage(f, t);
  };

  return (
    <div className={rowClass} onClick={() => onPick(f)} title="跳到 diff / 打开 discussion">
      <div className="fr-top">
        <span className={`sev sev-${f.severity}`}>
          {SEV_LABEL[f.severity]}
          {f.category ? ` · ${f.category}` : ''}
        </span>
        <span className={`origin ${f.origin === 'agent' ? 'agent' : 'human'}`}>
          <span className="d" />
          {ORIGIN_LABEL[f.origin]}
        </span>
      </div>
      <div className="fr-title">{f.title}</div>
      <div className="fr-foot">
        <span className="mono anchor">
          {f.file}:{f.line}
        </span>
        {f.suggestion && <span className="sugg-tag">◇ suggestion</span>}
        {submitted ? (
          <span className="subm">✓ 已提交</span>
        ) : dismissed ? (
          <button className="fr-restore" onClick={triage('keep')}>
            ↩ 恢复
          </button>
        ) : (
          <span className="triage">
            <button className={`t-keep${f.triage === 'keep' ? ' on' : ''}`} onClick={triage('keep')}>
              保留
            </button>
            <button className="t-drop" onClick={triage('dismiss')}>
              剔除
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
