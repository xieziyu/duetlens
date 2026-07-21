import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Discussion, Finding, Message, Review, Severity, Triage } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { AddFindingInput, DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { useSettings } from '../settings/SettingsProvider';
import { useReviewStream } from '../review/useReviewStream';
import { useReviewUiState } from '../review/useReviewUiState';
import { FileTree } from './review/FileTree';
import { DiffPane, type DiffView } from './review/DiffPane';
import { DiscussionTab } from './review/DiscussionTab';
import { SummaryTab } from './review/SummaryTab';
import { KbdHelp } from './review/KbdHelp';
import { Resizer } from './review/Resizer';
import { Wordmark } from '../components/Wordmark';
import { ThemeControls } from '../components/ThemeControls';
import { isSubmittable } from '@shared/github-review';
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

// → mockup/diff-review.html:合并单顶栏 + 三栏(file tree | diff | right panel)。
export function ReviewScreen({
  reviewId,
  onOpenSubmit,
}: {
  reviewId: string | null;
  onOpenSubmit?: () => void;
}) {
  const { review, findings, discussions, messages, diff, status, tokenUsage, lastTool, ensureMessages } =
    useReviewStream(reviewId);
  // 布局 / tab / diff 视图 = 全局持久化偏好(后端 ui_settings);改动去抖写回。
  const { settings, update } = useSettings();
  const tab = settings.defaultTab;
  const setTab = (t: RightTab) => update({ defaultTab: t });
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null);
  // discussion 协同态:活跃线程 / 待发引用(框选追问带入)/ 正在等 agent 回复
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<{ anchor: DiscussionAnchor; label: string } | null>(null);
  const [awaitingReply, setAwaitingReply] = useState<string | null>(null);
  // Summary 关注主题 → 筛 Findings tab
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // 键盘快捷键帮助浮层
  const [helpOpen, setHelpOpen] = useState(false);
  // 栏宽 + diff 视图:持久化偏好,拖拽 / 切换即写回(去抖)
  const leftW = settings.leftWidth;
  const rightW = settings.rightWidth;
  const diffView = settings.defaultDiffView;
  const setDiffView = (v: DiffView) => update({ defaultDiffView: v });
  // per-file 已看/折叠:per-review 持久化态(后端 review_ui_state),挂载拉取 + 去抖写回
  const { viewed, collapsed, onToggleViewed, onToggleCollapsed } = useReviewUiState(reviewId);

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

  // 框选「记为 finding」:填写后新增一条 manual finding(落库回推),聚焦其内联卡。
  const onAddFinding = useCallback(
    async (anchor: DiscussionAnchor, draft: Omit<AddFindingInput, 'file' | 'line'>) => {
      if (!reviewId) return;
      const f = await window.duetlens.review.addFinding(reviewId, {
        file: anchor.file,
        line: anchor.line,
        ...draft,
      });
      setActivePath(f.file);
      setFocusFindingId(f.id);
      setTab('findings');
    },
    [reviewId],
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

  const onEditSummary = useCallback(
    (body: string) => {
      if (!reviewId) return;
      void window.duetlens.review.updateSummary(reviewId, body);
    },
    [reviewId],
  );

  const onPickCategory = (cat: string) => {
    setCategoryFilter(cat);
    setTab('findings');
  };

  const jumpToCode = (d: Discussion) => {
    if (d.file) setActivePath(d.file);
    const f = findings.find((x) => x.discussionId === d.id);
    if (f) setFocusFindingId(f.id);
  };

  // 提升 user discussion 为 finding:落库后经事件回推(finding + discussion),再聚焦新 finding 就地编辑
  const onPromote = useCallback(
    async (discussionId: string) => {
      if (!reviewId) return;
      const f = await window.duetlens.review.promoteDiscussion(reviewId, discussionId);
      setActivePath(f.file);
      setFocusFindingId(f.id);
    },
    [reviewId],
  );

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

  // 全局导航快捷键(→ mockup #kbdHelp):? 帮助 / 1-3 切 tab / u 切 diff / Esc 关闭。
  // 焦点在输入框或按住修饰键时让位;编辑/发送的 ⌘↵·Esc·↵ 由各 composer/编辑器自理。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === 'Escape') {
        if (helpOpen) setHelpOpen(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (helpOpen) return; // 帮助打开时不抢导航键
      if (e.key === '1') {
        e.preventDefault();
        update({ defaultTab: 'discussion' });
      } else if (e.key === '2') {
        e.preventDefault();
        update({ defaultTab: 'findings' });
      } else if (e.key === '3') {
        e.preventDefault();
        update({ defaultTab: 'summary' });
      } else if (e.key === 'u') {
        e.preventDefault();
        update({ defaultDiffView: diffView === 'unified' ? 'split' : 'unified' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen, diffView, update]);

  const pct = tokenUsage?.total ? Math.round((tokenUsage.used / tokenUsage.total) * 100) : null;
  // 常驻 CTA:github-pr → 提交 review(徽标=待提交数);其余 → 导出 review(徽标=保留数)
  const isGithub = review?.source === 'github-pr';
  const ctaCount = isGithub
    ? findings.filter(isSubmittable).length
    : findings.filter((f) => f.triage !== 'dismiss').length;

  if (!reviewId) {
    return <div className="rev-empty">从入口开始一个审核。</div>;
  }

  return (
    <div
      className="rev-root"
      style={{ ['--left-w' as string]: `${leftW}px`, ['--right-w' as string]: `${rightW}px` }}
    >
      <div className="rev-topbar">
        <Wordmark />
        <div className="source">
          <span className="mono ref">{review?.sourceRef ?? '…'}</span>
          <span className="title">{review?.title ?? '加载中…'}</span>
        </div>
        <span className="spacer" />
        <div className="meta">
          <span className="model" title="审阅 agent">
            <span className="glyph" /> codex
          </span>
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
          <button
            className="submit-cta"
            onClick={onOpenSubmit}
            title={isGithub ? '进入筛选并提交 review 到 GitHub' : '导出 review 为 Markdown'}
          >
            {isGithub ? '提交 review' : '↓ 导出 review'}
            {ctaCount > 0 && <span className="cta-badge">{ctaCount}</span>}
          </button>
          <div className="switches">
            <ThemeControls />
            <button className="kbd-btn" onClick={() => setHelpOpen(true)} title="键盘快捷键 (?)">
              ⌘
            </button>
          </div>
        </div>
      </div>
      {helpOpen && <KbdHelp onClose={() => setHelpOpen(false)} />}

      <div className="rev-main">
        <FileTree
          files={diff}
          findings={findings}
          activePath={activePath}
          onSelect={setActivePath}
          viewed={viewed}
          onToggleViewed={onToggleViewed}
        />
        <Resizer onDrag={(dx) => update({ leftWidth: clamp(leftW + dx, LEFT_MIN, LEFT_MAX) })} />
        <DiffPane
          files={diff}
          findings={findings}
          activePath={activePath}
          focusFindingId={focusFindingId}
          onTriage={onTriage}
          onUpdate={onUpdate}
          onStartDiscussion={onStartDiscussion}
          onAskCodex={onAskCodex}
          onAddFinding={onAddFinding}
          view={diffView}
          onViewChange={setDiffView}
          viewed={viewed}
          collapsed={collapsed}
          onToggleViewed={onToggleViewed}
          onToggleCollapsed={onToggleCollapsed}
        />
        <Resizer onDrag={(dx) => update({ rightWidth: clamp(rightW - dx, RIGHT_MIN, RIGHT_MAX) })} />
        <RightPanel
          tab={tab}
          onTab={setTab}
          findings={findings}
          discussions={discussions}
          messages={messages}
          review={review}
          diff={diff}
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
          onPromote={onPromote}
          categoryFilter={categoryFilter}
          onClearCategory={() => setCategoryFilter(null)}
          onEditSummary={onEditSummary}
          onPickCategory={onPickCategory}
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
  review,
  diff,
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
  onPromote,
  categoryFilter,
  onClearCategory,
  onEditSummary,
  onPickCategory,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  findings: Finding[];
  discussions: Discussion[];
  messages: Record<string, Message[]>;
  review: Review | null;
  diff: DiffFile[];
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
  onPromote: (discussionId: string) => void;
  categoryFilter: string | null;
  onClearCategory: () => void;
  onEditSummary: (body: string) => void;
  onPickCategory: (cat: string) => void;
}) {
  const shown = useMemo(
    () => (categoryFilter ? findings.filter((f) => (f.category ?? '未分类') === categoryFilter) : findings),
    [findings, categoryFilter],
  );
  const grouped = useMemo(() => {
    const g: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
    for (const f of shown) g[f.severity].push(f);
    return g;
  }, [shown]);
  const kept = shown.filter((f) => f.triage === 'keep').length;
  const dropped = shown.filter((f) => f.triage === 'dismiss').length;

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
          {categoryFilter && (
            <div className="cat-filter">
              筛选 · <b>{categoryFilter}</b>
              <button className="cf-x" onClick={onClearCategory} title="清除筛选">
                ✕
              </button>
            </div>
          )}
          {shown.length === 0 && !scanning && (
            <p className="empty-note">{categoryFilter ? `无 ${categoryFilter} 分类的 findings。` : '暂无 findings。'}</p>
          )}
          {shown.length > 0 && (
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
          onPromote={onPromote}
        />
      )}
      {tab === 'summary' &&
        (scanning ? (
          <div className="tab-body">
            <div className="scan-note">
              <span className="pulse" /> 扫描完成后生成审核总结…
            </div>
          </div>
        ) : (
          <SummaryTab
            review={review}
            findings={findings}
            discussionCount={discussions.length}
            diff={diff}
            onEditSummary={onEditSummary}
            onPickCategory={onPickCategory}
          />
        ))}
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
