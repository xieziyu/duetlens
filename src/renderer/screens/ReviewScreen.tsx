import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Discussion, Finding, Message, Review, ReviewIntensity, Severity, Triage, UiSettings } from '@shared/domain';
import { DEFAULT_UI_SETTINGS } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { AddFindingInput, DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { useSettings } from '../settings/SettingsProvider';
import { useReviewStream } from '../review/useReviewStream';
import { useReviewUiState } from '../review/useReviewUiState';
import { FileTree } from './review/FileTree';
import { DiffPane, type DiffView } from './review/DiffPane';
import { DiscussionTab } from './review/DiscussionTab';
import { SummaryTab } from './review/SummaryTab';
import { ScanProgressBar } from './review/ScanProgressBar';
import { deriveScanSteps } from './review/scan-progress';
import { KbdHelp } from '../components/KbdHelp';
import { LensScanArt } from '../components/LensScanArt';
import { Resizer } from './review/Resizer';
import { ReviewStatusBar } from './review/StatusBar';
import { describeRoundError } from './review/round-error';
import { RerunPanel } from './review/RerunPanel';
import { LogoMark } from '../components/LogoMark';
import { Wordmark } from '../components/Wordmark';
import {
  currentResolution,
  isFixedThisRound,
  isNewThisRound,
  isSettledThisRound,
  isWontFixThisRound,
  roundSummary,
} from './review/rounds';
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

// 合并单顶栏 + 三栏(file tree | diff | right panel)。
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
    diffReady,
    status,
    rounds,
    tokenUsage,
    lastTool,
    retrying,
    ensureMessages,
    addPendingMessage,
    dropMessage,
  } = useReviewStream(reviewId);
  // 轮次要早于下面的重置 effect 可见(它按 currentRound 作废跨轮失效的本地态)
  const currentRound = review?.currentRound ?? 1;
  // 布局 / diff 视图 = 全局持久化偏好(后端 ui_settings);改动去抖写回。
  const { settings, update } = useSettings();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null);
  // 左栏文件检索:纯导航态不持久化;由屏持有才能在换 review 时清掉,并让 ⌘⇧F 把焦点甩进输入框
  const [fileQuery, setFileQuery] = useState('');
  const fileQueryRef = useRef<HTMLInputElement>(null);
  // discussion 协同态:活跃线程 / 正在等 agent 回复
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);
  const [awaitingReply, setAwaitingReply] = useState<string | null>(null);
  // Summary 关注主题 → 筛 Findings tab
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // 键盘快捷键帮助浮层
  const [helpOpen, setHelpOpen] = useState(false);
  // 重跑确认面板
  const [rerunOpen, setRerunOpen] = useState(false);
  // 状态栏「查看原因」→ 让进度条的失败卡展开并闪一下(递增即触发)
  const [revealFailure, setRevealFailure] = useState(0);
  // ⌘F diff 内检索:0 = 关;每按一次自增,DiffPane 据此把焦点抢回输入框并全选
  const [findNonce, setFindNonce] = useState(0);
  // 栏宽 + diff 视图:持久化偏好,拖拽 / 切换即写回(去抖)
  const leftW = settings.leftWidth;
  const rightW = settings.rightWidth;
  const diffView = settings.defaultDiffView;
  const setDiffView = (v: DiffView) => update({ defaultDiffView: v });
  // per-file 已看/折叠 + 最近 tab:per-review 持久化态(后端 review_ui_state),挂载拉取 + 去抖写回
  const { viewed, collapsed, activeTab, onToggleViewed, onToggleCollapsed, expandFile, setActiveTab } =
    useReviewUiState(reviewId, settings.collapseViewedFiles);
  // tab 优先用该 review 记住的;无记忆时回落到全局默认偏好。切 tab 只写 per-review。
  const tab: RightTab = isRightTab(activeTab) ? activeTab : settings.defaultTab;
  const setTab = (t: RightTab) => setActiveTab(t);

  // 折叠的文件整段内容都不在 DOM 里,内联卡自然也没有 —— 任何跳到代码的动作都得先把它放出来,
  // 否则滚动落空、中栏停在上一处。展开与两处状态更新同批提交,effect 跑时卡片已经在了。
  const revealFile = (path: string) => {
    setActivePath(path);
    expandFile(path);
  };

  const focusFinding = (f: Finding) => {
    revealFile(f.file);
    setFocusFindingId(f.id);
    // 点 finding 亦选中其讨论线程,切到 Discussion 栏即见对话(不强制换 tab)
    setActiveDiscussionId(f.discussionId);
  };

  // 内联卡「追问」:选中该 finding 的承载线程并切到 Discussion 栏,composer 即刻可用。
  // 与 focusFinding 的区别只在强制换 tab —— 后者是定位,这里是明确要开聊。
  const discussFinding = (f: Finding) => {
    expandFile(f.file);
    setFocusFindingId(f.id);
    setActiveDiscussionId(f.discussionId);
    setTab('discussion');
  };

  const focusDiscussion = (id: string) => {
    setActiveDiscussionId(id);
    setTab('discussion');
    // 选中不同 discussion 时同步把 diff 跳到其锚点代码(点 finding 卡走 focusFinding,此处覆盖列表选择)
    const d = discussions.find((x) => x.id === id);
    if (d?.file) revealFile(d.file);
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
      // diff 重拉未落定时中栏仍显示上一轮内容,此刻建锚会把旧行号记到已递增的新轮次上
      if (!reviewId || !diffReady) return;
      const d = await window.duetlens.review.addDiscussion(reviewId, anchor);
      setActiveDiscussionId(d.id);
      setTab('discussion');
      void runSend(d.id, text);
    },
    [reviewId, diffReady, runSend],
  );

  // 框选「记为 finding」:填写后新增一条 manual finding(落库回推),聚焦其内联卡。
  const onAddFinding = useCallback(
    async (anchor: DiscussionAnchor, draft: Omit<AddFindingInput, 'file' | 'line'>) => {
      if (!reviewId || !diffReady) return; // 同 onStartDiscussion:锚点必须落在当前轮的 diff 上
      const f = await window.duetlens.review.addFinding(reviewId, {
        file: anchor.file,
        line: anchor.line,
        ...draft,
      });
      setActivePath(f.file);
      expandFile(f.file);
      setFocusFindingId(f.id);
      setTab('findings');
    },
    [reviewId, diffReady, expandFile],
  );

  // Discussion 栏 composer 发送:只追问活跃线程;新讨论一律经中栏框选 / 行内 ＋ 就地发起。
  const onComposerSend = useCallback(
    (text: string) => {
      if (!activeDiscussionId) return;
      void runSend(activeDiscussionId, text);
    },
    [activeDiscussionId, runSend],
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
    if (d.file) revealFile(d.file);
    const f = findings.find((x) => x.discussionId === d.id);
    if (f) setFocusFindingId(f.id);
  };

  // 提升 user discussion 为 finding:落库后经事件回推(finding + discussion),再聚焦新 finding 就地编辑
  const onPromote = useCallback(
    async (discussionId: string) => {
      if (!reviewId) return;
      const f = await window.duetlens.review.promoteDiscussion(reviewId, discussionId);
      setActivePath(f.file);
      expandFile(f.file);
      setFocusFindingId(f.id);
    },
    [reviewId, expandFile],
  );

  // 写路径:落库后经 review:event 回推刷新(useReviewStream upsert),前端不本地臆造。
  const onTriage = useCallback(
    (finding: Finding, triage: Triage, reason?: string | null) => {
      if (!reviewId) return;
      void window.duetlens.review.setTriage(reviewId, finding.id, triage, reason);
    },
    [reviewId],
  );
  // 重跑:立刻返回新轮次记录,扫描后台跑;失败(如上一轮仍在扫描)由面板就地展示
  const onRerun = useCallback(
    async ({ note, intensity }: { note: string; intensity: ReviewIntensity }) => {
      if (!reviewId) return;
      await window.duetlens.review.rerun(reviewId, { note: note || undefined, intensity });
    },
    [reviewId],
  );
  // 重试失败的当前轮:沿用同一轮号,不新增轮次;失败原因由进度条就地展示
  const onRetryRound = useCallback(async () => {
    if (!reviewId) return;
    await window.duetlens.review.retryRound(reviewId);
  }, [reviewId]);
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

  // 切 review:reviewId 可在组件不卸载时变(点另一条 review 的完成通知 → App 只换 prop),
  // 屏内这些本地态全是锚在「上一条 review」上的,不清就会跨库写。
  // 放在 focusRequest effect 之前:通知带 discussionId 时由后者补回聚焦,不被这里清掉。
  useEffect(() => {
    setActiveDiscussionId(null);
    setFocusFindingId(null);
    setActivePath(null);
    setFileQuery('');
    setCategoryFilter(null);
    setAwaitingReply(null);
    setFindNonce(0);
  }, [reviewId]);

  // diff 到达后默认选中首个文件
  useEffect(() => {
    if (!activePath && diff.length > 0) setActivePath(diff[0].path);
  }, [diff, activePath]);

  // 通知点击带 discussionId 时定位到该线程(切 Discussion 栏);nonce 变化即重触发。
  useEffect(() => {
    if (focusRequest) focusDiscussion(focusRequest.id);
  }, [focusRequest]);

  // 有模态压在上面时,导航键一律挂起。判据必须是**所有**打开中的模态,不能只认帮助层:
  // 重跑面板同样是带 scrim 的 dialog,漏掉它时在说明输入框里按 ⌘F 会把焦点抢到对话框背后的
  // 检索条,⌘G 还会在背后换命中并滚动 diff。DiffPane 自带的 ⌘G 也吃这同一个判据。
  const modalOpen = helpOpen || rerunOpen;

  // 全局导航快捷键:? 帮助 / ⌘1-3 切 tab / ⌘U 切 diff / ⌘F 查 diff 内容 / ⌘⇧F 聚焦过滤框 / Esc 关闭。
  // 导航键一律带 ⌘,所以打字时也照常生效;只有裸键 ? 要给输入框让位。
  // 编辑/发送的 ⌘↵·Esc·↵ 由各 composer/编辑器自理。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === 'Escape') {
        if (helpOpen) setHelpOpen(false);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod && !e.altKey && e.key === '?' && !typing) {
        if (!helpOpen && modalOpen) return; // 已有别的模态在前,别再叠一层帮助
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (!mod || e.altKey || modalOpen) return; // 模态打开时不抢导航键
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === 'f') {
          e.preventDefault();
          fileQueryRef.current?.focus();
          fileQueryRef.current?.select();
        }
        return;
      }
      if (key === 'f') {
        e.preventDefault();
        setFindNonce((n) => n + 1);
      } else if (key === '1') {
        e.preventDefault();
        setActiveTab('discussion');
      } else if (key === '2') {
        e.preventDefault();
        setActiveTab('findings');
      } else if (key === '3') {
        e.preventDefault();
        setActiveTab('summary');
      } else if (key === 'u') {
        e.preventDefault();
        update({ defaultDiffView: diffView === 'unified' ? 'split' : 'unified' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen, modalOpen, diffView, update, setActiveTab]);

  const scanning = status === 'scanning' || !status;
  const currentRoundRec = useMemo(
    () => rounds.find((r) => r.round === currentRound) ?? null,
    [rounds, currentRound],
  );
  // 本轮失败的轮次记录 —— 进度条靠它显示断点与原因。只认当前轮:更早的失败轮已被后续轮次接手。
  const failedRound = currentRoundRec?.status === 'failed' ? currentRoundRec : null;
  // 失败后进度条**不卸载**:它是唯一能承载"断在哪、为什么断、怎么重试"的位置
  const showScanbar = scanning || failedRound !== null;
  // 进度信号必须按轮次隔离:findings 是整个 review 的累积集,拿全量当"本轮实时产出"会把
  // 上一轮的旧意见算进第 N 轮的计数里。本轮新报出的 = round === currentRound。
  const roundFindings = useMemo(
    () => findings.filter((f) => f.round === currentRound),
    [findings, currentRound],
  );
  // 同理 sessionReady 只看本轮信号(lastTool/tokenUsage 已在开轮时清空,见 useReviewStream)。
  // 落库的 codexThreadId 是这里唯一扛得住重入的信号:实时流信号随组件挂载清空,
  // 扫描中途退出再从历史进来,进度就会倒退回"建立会话"—— 后端那轮 turn 其实一直在跑。
  const sessionReady =
    lastTool != null ||
    tokenUsage != null ||
    roundFindings.length > 0 ||
    currentRoundRec?.codexThreadId != null;
  // 右栏扫描空态的镜片动画点亮几行 —— 与进度条同一份阶段派生,免得两处对"跑到哪一步"各说一套
  const scanLit = useMemo(
    () =>
      deriveScanSteps({
        findingCount: roundFindings.length,
        diffReady,
        sessionReady,
        failed: failedRound !== null,
      }).filter((s) => s.state === 'done').length,
    [roundFindings.length, diffReady, sessionReady, failedRound],
  );
  // 常驻 CTA:github-pr → 提交 review(徽标=待提交数);其余 → 导出 review(徽标=保留数)
  const isGithub = review?.source === 'github-pr';
  const ctaCount = isGithub
    ? findings.filter(isSubmittable).length
    : findings.filter((f) => f.triage !== 'dismiss').length;
  // 顶栏源标识:PR 拆成「#号 chip + 仓库 nwo 尾注」,分支 / vbranch 直接显示 ref
  const pr = isGithub ? parsePrRefLoose(review.sourceRef) : null;
  const sourceLabel = pr ? `#${pr.num}` : (review?.sourceRef ?? '…');

  // URL 解析与打开都在 main 侧(ref 可能只有 PR 号,需借 repoPath 推断仓库)
  const openInBrowser = useCallback(() => {
    if (!reviewId) return;
    void window.duetlens.review.openInBrowser(reviewId);
  }, [reviewId]);

  if (!reviewId) {
    return <div className="rev-empty">从入口开始一个审核。</div>;
  }

  return (
    <div
      className="rev-root"
      style={{ ['--left-w' as string]: `${leftW}px`, ['--right-w' as string]: `${rightW}px` }}
    >
      <header className="rev-topbar">
        {/* 这条栏替掉了外壳通用顶栏,品牌要补回来,否则 review 屏左上角与其余屏不一致 */}
        <span className="brand">
          <LogoMark size={20} />
          <Wordmark />
        </span>
        <span className="tb-sep" />
        <div className="source">
          {/* github 来源整枚 chip 即「去 PR」的入口;外链图标只作可点提示,不再是唯一热区 */}
          {isGithub ? (
            <button className="srcchip link" onClick={openInBrowser} title="在浏览器中打开 PR">
              <SourceIcon source={review?.source} />
              <span className="mono ref">{sourceLabel}</span>
              <span className="ext" aria-hidden>
                <ExternalIcon />
              </span>
            </button>
          ) : (
            <span className="srcchip">
              <SourceIcon source={review?.source} />
              <span className="mono ref">{sourceLabel}</span>
            </span>
          )}
          <span className="title">{review?.title ?? '加载中…'}</span>
          {pr?.nwo && <span className="mono nwo">{pr.nwo}</span>}
        </div>
        <span className="spacer" />
        <button
          className="rerun-cta"
          onClick={() => setRerunOpen(true)}
          disabled={scanning}
          title={scanning ? '本轮扫描进行中,结束后可重跑' : '带上本轮结论与你的处置,再跑一轮机审'}
        >
          ↻ 重跑
        </button>
        <button
          className="submit-cta"
          onClick={onOpenSubmit}
          title={isGithub ? '进入筛选并提交 review 到 GitHub' : '导出 review 为 Markdown'}
        >
          {isGithub ? '提交 review' : '↓ 导出 review'}
          {ctaCount > 0 && <span className="cta-badge">{ctaCount}</span>}
        </button>
      </header>
      {helpOpen && <KbdHelp onClose={() => setHelpOpen(false)} />}
      {rerunOpen && (
        <RerunPanel
          review={review}
          findings={findings}
          rounds={rounds}
          onClose={() => setRerunOpen(false)}
          onRun={onRerun}
        />
      )}

      <div className="rev-host">
        {showScanbar && (
          <ScanProgressBar
            findingCount={roundFindings.length}
            diffReady={diffReady}
            sessionReady={sessionReady}
            currentRound={currentRound}
            failedRound={failedRound}
            retrying={retrying}
            onRetry={onRetryRound}
            revealNonce={revealFailure}
          />
        )}
        <div className="rev-main">
          <FileTree
            files={diff}
            findings={findings}
            activePath={activePath}
            onSelect={setActivePath}
            viewed={viewed}
            onToggleViewed={onToggleViewed}
            query={fileQuery}
            onQueryChange={setFileQuery}
            inputRef={fileQueryRef}
          />
          <Resizer
            cssVar="--left-w"
            width={leftW}
            min={LEFT_MIN}
            max={LEFT_MAX}
            sign={1}
            defaultWidth={DEFAULT_UI_SETTINGS.leftWidth}
            onCommit={(w) => update({ leftWidth: w })}
          />
          <DiffPane
            files={diff}
            findings={findings}
            discussions={discussions}
            activePath={activePath}
            focusFindingId={focusFindingId}
            currentRound={currentRound}
            onTriage={onTriage}
            onUpdate={onUpdate}
            onStartDiscussion={onStartDiscussion}
            onAddFinding={onAddFinding}
            onDiscussFinding={discussFinding}
            onJumpFinding={focusFinding}
            onJumpDiscussion={focusDiscussion}
            fetchFileContent={fetchFileContent}
            view={diffView}
            onViewChange={setDiffView}
            viewed={viewed}
            collapsed={collapsed}
            onToggleViewed={onToggleViewed}
            onToggleCollapsed={onToggleCollapsed}
            collapseOnViewed={settings.collapseViewedFiles}
            onSelectFile={setActivePath}
            onExpandFile={expandFile}
            findNonce={findNonce}
            onFindClose={() => setFindNonce(0)}
            keysSuspended={modalOpen}
          />
          <Resizer
            cssVar="--right-w"
            width={rightW}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            sign={-1}
            defaultWidth={DEFAULT_UI_SETTINGS.rightWidth}
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
            scanning={scanning}
            scanLit={scanLit}
            currentRound={currentRound}
            onPickFinding={focusFinding}
            onTriage={onTriage}
            activeDiscussionId={activeDiscussionId}
            onSelectDiscussion={focusDiscussion}
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

      <ReviewStatusBar
        status={status}
        round={roundSummary(rounds, currentRound)}
        model={review?.model ?? null}
        effort={review?.reasoningEffort ?? null}
        tokenUsage={tokenUsage}
        lastTool={lastTool}
        failureHint={failedRound ? describeRoundError(failedRound.errorKind).title : null}
        onShowFailure={() => setRevealFailure((n) => n + 1)}
        onOpenHelp={() => setHelpOpen(true)}
      />
    </div>
  );
}

/**
 * 顶栏展示用的 PR 引用拆解(URL / owner/repo#123 / 纯号);解析不出就退回原样显示,
 * 不与 main 侧 parsePrRef 共用 —— 那条路径要抛错并回退推断仓库,展示态不需要。
 */
function parsePrRefLoose(ref: string): { nwo: string; num: string } | null {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { nwo: url[1], num: url[2] };
  const short = ref.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/);
  if (short) return { nwo: short[1], num: short[2] };
  const numOnly = ref.match(/^#?(\d+)$/);
  return numOnly ? { nwo: '', num: numOnly[1] } : null;
}

/** 顶栏源标识图标:三来源各一枚,与入口页 srcbadge 同一视觉词汇。 */
function SourceIcon({ source }: { source?: Review['source'] }) {
  if (source === 'github-pr') {
    return (
      <svg className="si" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.89.87 2.35.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  return (
    <svg className="si" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="12" r="2.5" />
      <path d="M6.5 8v8M9 5.5h4a2.5 2.5 0 0 1 2.5 2.5v1.5" />
    </svg>
  );
}

const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5 11 13" />
    <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
  </svg>
);

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
  scanLit,
  currentRound,
  onPickFinding,
  onTriage,
  activeDiscussionId,
  onSelectDiscussion,
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
  /** 扫描空态动画点亮的行数 = 已完成的阶段数 */
  scanLit: number;
  currentRound: number;
  onPickFinding: (f: Finding) => void;
  onTriage: (finding: Finding, triage: Triage, reason?: string | null) => void;
  activeDiscussionId: string | null;
  onSelectDiscussion: (id: string) => void;
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
  const filtered = useMemo(
    () => (categoryFilter ? findings.filter((f) => (f.category ?? '未分类') === categoryFilter) : findings),
    [findings, categoryFilter],
  );
  // 本轮已有结论的条目移出主列表 —— 它们不再是待处理的意见,留在原位只会淹没真正要看的东西。
  // 「已修复」与「作者已回应」分开两组:后者还需 reviewer 决定接不接受作者的说法。
  const fixed = useMemo(
    () => filtered.filter((f) => isFixedThisRound(f, currentRound)),
    [filtered, currentRound],
  );
  const wontFix = useMemo(
    () => filtered.filter((f) => isWontFixThisRound(f, currentRound)),
    [filtered, currentRound],
  );
  const shown = useMemo(
    () => filtered.filter((f) => !isSettledThisRound(f, currentRound)),
    [filtered, currentRound],
  );
  // findings 分组:按严重度(high▸low)或按文件;渲染统一走 groups 列表。
  // 文件不在本次 diff 内的 finding 在中栏统一堆在底部 off-diff 区,列表里也抽成末尾专组,
  // 免得点着点着 diff 在改动处与底部之间来回弹。
  const groups = useMemo(() => {
    const diffPaths = new Set(diff.map((f) => f.path));
    const inDiff = shown.filter((f) => diffPaths.has(f.file));
    const absent = shown.filter((f) => !diffPaths.has(f.file));
    let main: { key: string; header: ReactNode; findings: Finding[] }[];
    if (grouping === 'file') {
      const byFile = new Map<string, Finding[]>();
      for (const f of inDiff) {
        const arr = byFile.get(f.file);
        if (arr) arr.push(f);
        else byFile.set(f.file, [f]);
      }
      main = [...byFile.entries()].map(([file, fs]) => ({
        key: file,
        header: <span className="fg-file mono">{file}</span>,
        findings: fs,
      }));
    } else {
      const bySev: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
      for (const f of inDiff) bySev[f.severity].push(f);
      main = SEV_ORDER.filter((sev) => bySev[sev].length > 0).map((sev) => ({
        key: sev,
        header: <span className={`sev sev-${sev}`}>{SEV_LABEL[sev]}</span>,
        findings: bySev[sev],
      }));
    }
    if (absent.length > 0) {
      main.push({
        key: '__absent__',
        header: <span className="fg-absent">◇ 文件不在改动内</span>,
        findings: absent,
      });
    }
    return main;
  }, [shown, grouping, diff]);
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
            {t === 'findings' && scanning && <span className="tab-spin" aria-hidden />}
          </button>
        ))}
      </div>

      {tab === 'findings' && (
        <div className="tab-body">
          {categoryFilter && (
            <div className="cat-filter">
              筛选 · <b>{categoryFilter}</b>
              <button className="cf-x" onClick={onClearCategory} title="清除筛选">
                ✕
              </button>
            </div>
          )}
          {shown.length === 0 && fixed.length === 0 && wontFix.length === 0 &&
            (categoryFilter ? (
              <p className="empty-note">无 {categoryFilter} 分类的 findings。</p>
            ) : scanning ? (
              // 扫描期零 finding 只是「还没报出来」,不能给干净通过的结论。这一屏空着最久,
              // 用启动浮层同一套镜片扫描画面把「还在读」画出来,而不是一行容易被当成结论的短提示。
              <div className="fscan">
                <LensScanArt className="fscan-art" lit={scanLit} />
                <div className="fscan-title">agent 通读改动中</div>
                <p className="fscan-sub">
                  发现即刻出现在此。不必等它跑完 —— 左侧 diff 全程可读,框选代码就能直接提问。
                </p>
              </div>
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
                  仍可框选左侧代码发起 discussion,或「＋ 记为 finding」手动新增。
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
                <FindingRow
                  key={f.id}
                  finding={f}
                  currentRound={currentRound}
                  onPick={onPickFinding}
                  onTriage={onTriage}
                />
              ))}
            </div>
          ))}
          <FoldedGroup label="✓ 本轮判定已修复" tone="fixed" findings={fixed}>
            {(f) => (
              <FindingRow
                key={f.id}
                finding={f}
                currentRound={currentRound}
                onPick={onPickFinding}
                onTriage={onTriage}
              />
            )}
          </FoldedGroup>
          {/* 作者已回应的默认展开:这组还等着 reviewer 决定接不接受作者的说法 */}
          <FoldedGroup label="◇ 作者已回应,未改动" tone="wontfix" findings={wontFix} defaultOpen>
            {(f) => (
              <FindingRow
                key={f.id}
                finding={f}
                currentRound={currentRound}
                onPick={onPickFinding}
                onTriage={onTriage}
              />
            )}
          </FoldedGroup>
        </div>
      )}

      {tab === 'discussion' && (
        <DiscussionTab
          discussions={discussions}
          findings={findings}
          messages={messages}
          activeId={activeDiscussionId}
          onSelect={onSelectDiscussion}
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

/** 本轮已有结论的一组 finding:折叠起来不占主列表,标题上带条数。空组不渲染。 */
function FoldedGroup({
  label,
  tone,
  findings,
  defaultOpen = false,
  children,
}: {
  label: string;
  tone: 'fixed' | 'wontfix';
  findings: Finding[];
  defaultOpen?: boolean;
  children: (f: Finding) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (findings.length === 0) return null;
  return (
    <div className={`fgroup folded-group ${tone}`}>
      <button className="fg-head fg-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="fg-caret">{open ? '▾' : '▸'}</span>
        <span className={`fg-folded ${tone}`}>{label}</span>
        <span className="fg-n">{findings.length}</span>
        <span className="fg-line" />
      </button>
      {open && findings.map(children)}
    </div>
  );
}

const ORIGIN_LABEL: Record<Finding['origin'], string> = {
  agent: 'agent',
  manual: '你',
  promoted: '你 · 提升',
};

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 右栏 Findings tab 单行:锚点导航 + triage(剔除/恢复)+ 复审轮次标记。 */
function FindingRow({
  finding: f,
  currentRound,
  onPick,
  onTriage,
}: {
  finding: Finding;
  currentRound: number;
  onPick: (f: Finding) => void;
  onTriage: (finding: Finding, triage: Triage, reason?: string | null) => void;
}) {
  const submitted = f.submission === 'submitted';
  const dismissed = f.triage === 'dismiss';
  const resolution = currentResolution(f, currentRound);
  const isNew = isNewThisRound(f, currentRound);
  const rowClass =
    'frow' +
    (submitted ? ' submitted' : dismissed ? ' dismissed' : ' kept') +
    (resolution === 'fixed' ? ' resolved' : '');
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
        {isNew && <span className="round-tag new">本轮新增</span>}
        {resolution === 'fixed' && (
          <span className="round-tag fixed">✓ 已修复{dismissed ? ' · 自动剔除' : ''}</span>
        )}
        {resolution === 'still_present' && <span className="round-tag still">仍存在</span>}
        {resolution === 'wont_fix' && <span className="round-tag wontfix">◇ 作者已回应</span>}
        <span className={`origin ${f.origin === 'agent' ? 'agent' : 'human'}`}>
          <span className="d" />
          {ORIGIN_LABEL[f.origin]}
        </span>
      </div>
      <div className="fr-title">{f.title}</div>
      {f.resolutionNote && resolution && (
        <div className={`fr-note res${resolution === 'wont_fix' ? ' wontfix' : ''}`}>
          <span className="frn-lbl">{resolution === 'wont_fix' ? '作者' : '复核'}</span>
          {f.resolutionNote}
        </div>
      )}
      {/* 本轮的「✓ 已修复 · 自动剔除」标签已经说明了为何剔除,不必再拿理由行重复一遍 */}
      {dismissed && f.dismissReason && resolution !== 'fixed' && (
        <div className="fr-note reason">理由:{f.dismissReason}</div>
      )}
      <div className="fr-foot">
        <span className="mono anchor" title={`${f.file}:${f.line}`}>
          {basename(f.file)}:{f.line}
        </span>
        {f.suggestion && <span className="sugg-tag">◇ suggestion</span>}
        <div className="fr-actions">
          {dismissed ? (
            <button className="fr-restore" onClick={triage('open')}>
              ↩ 恢复
            </button>
          ) : (
            <span className="triage">
              {/* 已提交的 finding 内容锁定,但「作者已回应」仍需一个出口:剔除并留下作者的说法 */}
              {resolution === 'wont_fix' && (
                <button
                  className="t-accept"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTriage(f, 'dismiss', f.resolutionNote ?? null);
                  }}
                  title="剔除此条,并把作者的说明记为剔除理由"
                >
                  ✓ 采纳
                </button>
              )}
              {submitted ? (
                <span className="subm">✓ 已提交</span>
              ) : (
                <button className="t-drop" onClick={triage('dismiss')}>
                  剔除
                </button>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
