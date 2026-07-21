import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Discussion, Finding, Message, Severity, Triage } from '@shared/domain';
import type { DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { useReviewStream } from '../review/useReviewStream';
import { FileTree } from './review/FileTree';
import { DiffPane, type DiffView } from './review/DiffPane';
import { DiscussionTab } from './review/DiscussionTab';
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

// → mockup/diff-review.html:三栏(file tree | diff | right panel)。
export function ReviewScreen({ reviewId }: { reviewId: string | null }) {
  const { review, findings, discussions, messages, diff, status, tokenUsage, lastTool, ensureMessages } =
    useReviewStream(reviewId);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null);
  const [tab, setTab] = useState<RightTab>('findings');
  // discussion 协同态:活跃线程 / 待发引用(框选追问带入)/ 正在等 agent 回复
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<{ anchor: DiscussionAnchor; label: string } | null>(null);
  const [awaitingReply, setAwaitingReply] = useState<string | null>(null);
  // 栏宽:本地拖拽态,持久化(后端 settings)后续接入
  const [leftW, setLeftW] = useState(236);
  const [rightW, setRightW] = useState(380);
  // diff 视图 + per-file 已看/折叠:本地态,持久化统一留后续切片
  const [diffView, setDiffView] = useState<DiffView>('unified');
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (s: Set<string>, path: string, on: boolean): Set<string> => {
    const next = new Set(s);
    if (on) next.add(path);
    else next.delete(path);
    return next;
  };
  const onToggleCollapsed = (path: string) =>
    setCollapsed((prev) => toggle(prev, path, !prev.has(path)));
  // 标记已看同时折叠;取消已看则展开
  const onToggleViewed = (path: string) =>
    setViewed((prev) => {
      const nowViewed = !prev.has(path);
      setCollapsed((c) => toggle(c, path, nowViewed));
      return toggle(prev, path, nowViewed);
    });

  const focusFinding = (f: Finding) => {
    setActivePath(f.file);
    setFocusFindingId(f.id);
    // 点 finding 亦选中其讨论线程,切到 Discussion 栏即见对话(不强制换 tab)
    setActiveDiscussionId(f.discussionId);
  };

  const focusDiscussion = (id: string) => {
    setActiveDiscussionId(id);
    setTab('discussion');
  };

  // 向某条 discussion 追问:落库经事件回推消息,期间显示 agent 打字指示。
  const runSend = useCallback(
    async (discussionId: string, text: string) => {
      if (!reviewId) return;
      setAwaitingReply(discussionId);
      try {
        await window.duetlens.review.sendMessage(reviewId, discussionId, text);
      } finally {
        setAwaitingReply((cur) => (cur === discussionId ? null : cur));
      }
    },
    [reviewId],
  );

  // 框选 / 行内 ＋ 发起 discussion:先建 user discussion(事件回推),再发出首问。
  const onStartDiscussion = useCallback(
    async (anchor: DiscussionAnchor, text: string) => {
      if (!reviewId) return;
      const d = await window.duetlens.review.addDiscussion(reviewId, anchor);
      setActiveDiscussionId(d.id);
      setTab('discussion');
      void runSend(d.id, text);
    },
    [reviewId, runSend],
  );

  // 框选「追问 codex」:把选区作为待发引用带进 Discussion 栏 composer(发送时再建 discussion)。
  const onAskCodex = useCallback((anchor: DiscussionAnchor, label: string) => {
    setPendingRef({ anchor, label });
    setActiveDiscussionId(null);
    setTab('discussion');
  }, []);

  // Discussion 栏 composer 发送:有活跃线程则追问,否则从待发引用新建。
  const onComposerSend = useCallback(
    async (text: string) => {
      if (!reviewId) return;
      if (activeDiscussionId) {
        void runSend(activeDiscussionId, text);
        return;
      }
      if (pendingRef) {
        const d = await window.duetlens.review.addDiscussion(reviewId, pendingRef.anchor);
        setActiveDiscussionId(d.id);
        setPendingRef(null);
        void runSend(d.id, text);
      }
    },
    [reviewId, activeDiscussionId, pendingRef, runSend],
  );

  const jumpToCode = (d: Discussion) => {
    if (d.file) setActivePath(d.file);
    const f = findings.find((x) => x.discussionId === d.id);
    if (f) setFocusFindingId(f.id);
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
          viewed={viewed}
          onToggleViewed={onToggleViewed}
        />
        <Resizer onDrag={(dx) => setLeftW((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))} />
        <DiffPane
          files={diff}
          findings={findings}
          activePath={activePath}
          focusFindingId={focusFindingId}
          onTriage={onTriage}
          onUpdate={onUpdate}
          onStartDiscussion={onStartDiscussion}
          onAskCodex={onAskCodex}
          view={diffView}
          onViewChange={setDiffView}
          viewed={viewed}
          collapsed={collapsed}
          onToggleViewed={onToggleViewed}
          onToggleCollapsed={onToggleCollapsed}
        />
        <Resizer onDrag={(dx) => setRightW((w) => clamp(w - dx, RIGHT_MIN, RIGHT_MAX))} />
        <RightPanel
          tab={tab}
          onTab={setTab}
          findings={findings}
          discussions={discussions}
          messages={messages}
          scanning={status === 'scanning' || !status}
          onPickFinding={focusFinding}
          onTriage={onTriage}
          activeDiscussionId={activeDiscussionId}
          onSelectDiscussion={focusDiscussion}
          pendingRef={pendingRef}
          onClearRef={() => setPendingRef(null)}
          awaitingReply={awaitingReply}
          onComposerSend={onComposerSend}
          onJumpToCode={jumpToCode}
          ensureMessages={ensureMessages}
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
  discussions,
  messages,
  scanning,
  onPickFinding,
  onTriage,
  activeDiscussionId,
  onSelectDiscussion,
  pendingRef,
  onClearRef,
  awaitingReply,
  onComposerSend,
  onJumpToCode,
  ensureMessages,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  findings: Finding[];
  discussions: Discussion[];
  messages: Record<string, Message[]>;
  scanning: boolean;
  onPickFinding: (f: Finding) => void;
  onTriage: (finding: Finding, triage: Triage) => void;
  activeDiscussionId: string | null;
  onSelectDiscussion: (id: string) => void;
  pendingRef: { anchor: DiscussionAnchor; label: string } | null;
  onClearRef: () => void;
  awaitingReply: string | null;
  onComposerSend: (text: string) => void;
  onJumpToCode: (d: Discussion) => void;
  ensureMessages: (id: string) => void;
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
            {t === 'discussion' ? 'Discussion' : t === 'findings' ? 'Findings' : 'Summary'}
            {t === 'discussion' && discussions.length > 0 && (
              <span className="tab-count">{discussions.length}</span>
            )}
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
        <DiscussionTab
          discussions={discussions}
          findings={findings}
          messages={messages}
          activeId={activeDiscussionId}
          onSelect={onSelectDiscussion}
          pendingRef={pendingRef ? { label: pendingRef.label } : null}
          onClearRef={onClearRef}
          awaitingReply={awaitingReply}
          scanning={scanning}
          onSend={onComposerSend}
          onJumpToCode={onJumpToCode}
          ensureMessages={ensureMessages}
        />
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
