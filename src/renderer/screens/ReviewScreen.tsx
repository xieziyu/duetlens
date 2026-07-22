import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Discussion, Finding, Message, Review, Severity, Triage, UiSettings } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { AddFindingInput, DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { useSettings } from '../settings/SettingsProvider';
import { useReviewStream } from '../review/useReviewStream';
import { useReviewUiState } from '../review/useReviewUiState';
import { FileTree } from './review/FileTree';
import { DiffPane, type DiffView } from './review/DiffPane';
import { DiscussionTab } from './review/DiscussionTab';
import { SummaryTab } from './review/SummaryTab';
import { ScanTimeline } from './review/ScanTimeline';
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

type RightTab = 'discussion' | 'findings' | 'summary';

const RIGHT_TABS: RightTab[] = ['discussion', 'findings', 'summary'];
const isRightTab = (t: string | null): t is RightTab => t !== null && RIGHT_TABS.includes(t as RightTab);

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
  focusRequest,
}: {
  reviewId: string | null;
  onOpenSubmit?: () => void;
  /** 外部(通知点击)请求定位到某条 discussion;nonce 保证同一线程可重触发 */
  focusRequest?: { id: string; nonce: number } | null;
}) {
  const {
    review,
    findings,
    discussions,
    messages,
    diff,
    status,
    tokenUsage,
    lastTool,
    ensureMessages,
    addPendingMessage,
    dropMessage,
  } = useReviewStream(reviewId);
  // 布局 / diff 视图 = 全局持久化偏好(后端 ui_settings);改动去抖写回。
  const { settings, update } = useSettings();
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
  // per-file 已看/折叠 + 最近 tab:per-review 持久化态(后端 review_ui_state),挂载拉取 + 去抖写回
  const { viewed, collapsed, activeTab, onToggleViewed, onToggleCollapsed, setActiveTab } =
    useReviewUiState(reviewId, settings.collapseViewedFiles);
  // tab 优先用该 review 记住的;无记忆时回落到全局默认偏好。切 tab 只写 per-review。
  const tab: RightTab = isRightTab(activeTab) ? activeTab : settings.defaultTab;
  const setTab = (t: RightTab) => setActiveTab(t);

  const focusFinding = (f: Finding) => {
    setActivePath(f.file);
    setFocusFindingId(f.id);
    // 点 finding 亦选中其讨论线程,切到 Discussion 栏即见对话(不强制换 tab)
    setActiveDiscussionId(f.discussionId);
  };

  const focusDiscussion = (id: string) => {
    setActiveDiscussionId(id);
    setTab('discussion');
    // 选中不同 discussion 时同步把 diff 跳到其锚点代码(点 finding 卡走 focusFinding,此处覆盖列表选择)
    const d = discussions.find((x) => x.id === id);
    if (d?.file) setActivePath(d.file);
    const f = findings.find((x) => x.discussionId === id);
    if (f) setFocusFindingId(f.id);
  };

  // 向某条 discussion 追问:先乐观上屏 user 气泡再显打字指示(否则 IPC/续接延迟会让「回复中」抢先出现),
  // 落库后权威 message 事件替换乐观占位;发送失败则清理占位。
  const runSend = useCallback(
    async (discussionId: string, text: string) => {
      if (!reviewId) return;
      const pendingId = addPendingMessage(discussionId, text);
      setAwaitingReply(discussionId);
      try {
        await window.duetlens.review.sendMessage(reviewId, discussionId, text);
      } catch {
        dropMessage(discussionId, pendingId);
      } finally {
        setAwaitingReply((cur) => (cur === discussionId ? null : cur));
      }
    },
    [reviewId, addPendingMessage, dropMessage],
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

  // 清空某条 discussion 的往来消息(finding 卡保留),重开讨论;落库后经事件流回推清空。
  const onClearMessages = useCallback(
    (discussionId: string) => {
      if (!reviewId) return;
      void window.duetlens.review.clearDiscussion(reviewId, discussionId);
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
  // DiffPane 展开 diff 外上下文时按需拉取文件新侧全文(读不到返回 null)
  const fetchFileContent = useCallback(
    (path: string) => {
      if (!reviewId) return Promise.resolve(null);
      return window.duetlens.review.fileContent(reviewId, path);
    },
    [reviewId],
  );

  // diff 到达后默认选中首个文件
  useEffect(() => {
    if (!activePath && diff.length > 0) setActivePath(diff[0].path);
  }, [diff, activePath]);

  // 通知点击带 discussionId 时定位到该线程(切 Discussion 栏);nonce 变化即重触发。
  useEffect(() => {
    if (focusRequest) focusDiscussion(focusRequest.id);
  }, [focusRequest]);

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
        setActiveTab('discussion');
      } else if (e.key === '2') {
        e.preventDefault();
        setActiveTab('findings');
      } else if (e.key === '3') {
        e.preventDefault();
        setActiveTab('summary');
      } else if (e.key === 'u') {
        e.preventDefault();
        update({ defaultDiffView: diffView === 'unified' ? 'split' : 'unified' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen, diffView, update, setActiveTab]);

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
            <span className="glyph" /> codex{review?.model ? ` · ${review.model}` : ''}
          </span>
          {review?.reasoningEffort && (
            <span className="mono effort" title="reasoning effort">{review.reasoningEffort}</span>
          )}
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
        <Resizer
          cssVar="--left-w"
          width={leftW}
          min={LEFT_MIN}
          max={LEFT_MAX}
          sign={1}
          onCommit={(w) => update({ leftWidth: w })}
        />
        <DiffPane
          files={diff}
          findings={findings}
          discussions={discussions}
          activePath={activePath}
          focusFindingId={focusFindingId}
          onTriage={onTriage}
          onUpdate={onUpdate}
          onStartDiscussion={onStartDiscussion}
          onAskCodex={onAskCodex}
          onAddFinding={onAddFinding}
          onJumpFinding={focusFinding}
          onJumpDiscussion={focusDiscussion}
          fetchFileContent={fetchFileContent}
          view={diffView}
          onViewChange={setDiffView}
          viewed={viewed}
          collapsed={collapsed}
          onToggleViewed={onToggleViewed}
          onToggleCollapsed={onToggleCollapsed}
        />
        <Resizer
          cssVar="--right-w"
          width={rightW}
          min={RIGHT_MIN}
          max={RIGHT_MAX}
          sign={-1}
          onCommit={(w) => update({ rightWidth: w })}
        />
        <RightPanel
          tab={tab}
          onTab={setTab}
          grouping={settings.findingsGrouping}
          findings={findings}
          discussions={discussions}
          messages={messages}
          review={review}
          diff={diff}
          scanning={status === 'scanning' || !status}
          lastTool={lastTool}
          tokenUsage={tokenUsage}
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
          onClearMessages={onClearMessages}
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
  grouping,
  findings,
  discussions,
  messages,
  review,
  diff,
  scanning,
  lastTool,
  tokenUsage,
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
  onClearMessages,
  categoryFilter,
  onClearCategory,
  onEditSummary,
  onPickCategory,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  grouping: UiSettings['findingsGrouping'];
  findings: Finding[];
  discussions: Discussion[];
  messages: Record<string, Message[]>;
  review: Review | null;
  diff: DiffFile[];
  scanning: boolean;
  lastTool: string | null;
  tokenUsage: { used: number; total?: number } | null;
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
  onClearMessages: (discussionId: string) => void;
  categoryFilter: string | null;
  onClearCategory: () => void;
  onEditSummary: (body: string) => void;
  onPickCategory: (cat: string) => void;
}) {
  const shown = useMemo(
    () => (categoryFilter ? findings.filter((f) => (f.category ?? '未分类') === categoryFilter) : findings),
    [findings, categoryFilter],
  );
  // findings 分组:按严重度(high▸low)或按文件;渲染统一走 groups 列表。
  const groups = useMemo(() => {
    if (grouping === 'file') {
      const byFile = new Map<string, Finding[]>();
      for (const f of shown) {
        const arr = byFile.get(f.file);
        if (arr) arr.push(f);
        else byFile.set(f.file, [f]);
      }
      return [...byFile.entries()].map(([file, fs]) => ({
        key: file,
        header: <span className="fg-file mono">{file}</span>,
        findings: fs,
      }));
    }
    const bySev: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
    for (const f of shown) bySev[f.severity].push(f);
    return SEV_ORDER.filter((sev) => bySev[sev].length > 0).map((sev) => ({
      key: sev,
      header: <span className={`sev sev-${sev}`}>{SEV_LABEL[sev]}</span>,
      findings: bySev[sev],
    }));
  }, [shown, grouping]);
  const kept = shown.filter((f) => f.triage !== 'dismiss').length;
  const dropped = shown.filter((f) => f.triage === 'dismiss').length;
  const coverage = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const f of diff) {
      a += f.additions;
      d += f.deletions;
    }
    return { files: diff.length, additions: a, deletions: d };
  }, [diff]);

  return (
    <div className="right pane">
      <div className="tabs">
        {RIGHT_TABS.map((t) => (
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
          {scanning ? (
            <ScanTimeline
              findings={findings}
              diffReady={diff.length > 0}
              sessionReady={lastTool != null || tokenUsage != null || findings.length > 0}
              onPickFinding={onPickFinding}
            />
          ) : (
            <>
              {categoryFilter && (
                <div className="cat-filter">
                  筛选 · <b>{categoryFilter}</b>
                  <button className="cf-x" onClick={onClearCategory} title="清除筛选">
                    ✕
                  </button>
                </div>
              )}
              {shown.length === 0 &&
                (categoryFilter ? (
                  <p className="empty-note">无 {categoryFilter} 分类的 findings。</p>
                ) : (
                  // 扫描已结束且零 finding = 干净通过:给正向结论 + 覆盖度 + 手动新增引导
                  <div className="findings-clean">
                    <span className="fc-badge">✓</span>
                    <div className="fc-title">未发现需要修复的问题</div>
                    <div className="fc-sub">agent 已通读本次改动,没有报告 finding。</div>
                    {coverage.files > 0 && (
                      <div className="fc-cover">
                        已覆盖 {coverage.files} 文件 · +{coverage.additions} −{coverage.deletions} · read-only sandbox
                      </div>
                    )}
                    <div className="fc-hint">
                      仍可框选左侧代码「＋ 记为 finding」手动新增,或在 Discussion 追问 agent。
                    </div>
                  </div>
                ))}
              {shown.length > 0 && (
                <div className="fp-toolbar">
                  <span className="fp-tally">
                    保留 <b>{kept}</b> · 剔除 {dropped}
                  </span>
                </div>
              )}
              {groups.map((g) => (
                <div key={g.key} className="fgroup">
                  <div className="fg-head">
                    {g.header}
                    <span className="fg-n">{g.findings.length}</span>
                    <span className="fg-line" />
                  </div>
                  {g.findings.map((f) => (
                    <FindingRow key={f.id} finding={f} onPick={onPickFinding} onTriage={onTriage} />
                  ))}
                </div>
              ))}
            </>
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
          onClearMessages={onClearMessages}
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
  agent: 'agent',
  manual: '你',
  promoted: '你 · 提升',
};

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 右栏 Findings tab 单行:锚点导航 + triage(剔除/恢复)。 */
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
  const rowClass = 'frow' + (submitted ? ' submitted' : dismissed ? ' dismissed' : ' kept');
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
        <span className="mono anchor" title={`${f.file}:${f.line}`}>
          {basename(f.file)}:{f.line}
        </span>
        {f.suggestion && <span className="sugg-tag">◇ suggestion</span>}
        <div className="fr-actions">
          {submitted ? (
            <span className="subm">✓ 已提交</span>
          ) : dismissed ? (
            <button className="fr-restore" onClick={triage('open')}>
              ↩ 恢复
            </button>
          ) : (
            <span className="triage">
              <button className="t-drop" onClick={triage('dismiss')}>
                剔除
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
