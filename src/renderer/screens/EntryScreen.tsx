import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INTENSITY_HINTS,
  INTENSITY_LABELS,
  REASONING_EFFORTS,
  REVIEW_INTENSITIES,
  type CodexModelInfo,
  type ReasoningEffort,
  type ReviewIntensity,
  type SourceKind,
} from '@shared/domain';
import type { LiveCapacity, RecentReview, ReviewStartInput, ReviewStartStage } from '@shared/ipc';
import type {
  LocalBranchList,
  PrAncestor,
  PrPreview,
  PrSummary,
  RepoInspection,
  RepoMode,
  VbranchSummary,
} from '@shared/source-discovery';
import { useSettings } from '../settings/SettingsProvider';
import {
  BaseProbeRow,
  BaseRow,
  BaseSection,
  StackLadder,
  useDiffStat,
  type BaseOption,
} from './entry/BasePicker';
import { BranchPicker, BranchSummary, type BranchOption } from './entry/BranchPicker';
import { Busy } from './entry/Busy';
import { GhIcon, LocalBranchIcon } from './entry/icons';
import { baseName, parentDir } from './entry/paths';
import { RepoSwitch } from './entry/RepoSwitch';
import { RecentReviews } from './entry/RecentReviews';
import { StartOverlay } from './entry/StartOverlay';
import { LogoMark } from '../components/LogoMark';
import {
  CAPACITY_POLL_MS,
  CapacityNotice,
  isAtCapacity,
  isLiveSessionLimit,
  stripLimitCode,
} from '../components/CapacityNotice';
import { newStartId } from '../components/StartProgress';
import './EntryScreen.css';

/**
 * 入口只分两档:本地仓库这一档下按普通 git 分支还是 GitButler 虚拟分支审,
 * 由选定仓库后的探测结果(见 inspectRepo)决定,不再让用户先记住仓库此刻的状态。
 */
type EntryTab = 'github-pr' | 'repo';

const SOURCE_TABS: { value: EntryTab; label: string; icon: () => JSX.Element }[] = [
  { value: 'github-pr', label: 'GitHub PR', icon: GhIcon },
  { value: 'repo', label: '本地仓库', icon: LocalBranchIcon },
];

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'minimal · 最快',
  low: 'low',
  medium: 'medium · 默认',
  high: 'high',
  xhigh: 'xhigh · 最深',
};


// 三来源分段选择器 + 各 panel + 附加上下文 + 最近的审核
export function EntryScreen({ onOpenReview }: { onOpenReview: (id: string) => void }) {
  const { settings, update, loaded } = useSettings();
  const [reviews, setReviews] = useState<RecentReview[]>([]);
  const [tab, setTab] = useState<EntryTab>('github-pr');

  // 两档共享:选定的 ref(PR 引用 / 分支名 / vbranch 名)与仓库路径
  const [ref, setRef] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseRef, setBaseRef] = useState('');

  // 本地仓库档:探测结果定模式;forceLocal 是 workspace 仓库上「改按普通 git 分支审核」的手动覆盖
  const [inspection, setInspection] = useState<RepoInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [forceLocal, setForceLocal] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);

  // 审核配置
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('medium');
  const [intensity, setIntensity] = useState<ReviewIntensity>('standard');
  const [context, setContext] = useState('');
  const [ctxOpen, setCtxOpen] = useState(false);
  const [models, setModels] = useState<CodexModelInfo[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 启动等待浮层:阶段由后端事件推进,失败时原地转错误态(不回落到卡片内的行内报错)
  const [overlay, setOverlay] = useState(false);
  const [startStage, setStartStage] = useState<ReviewStartStage | null>(null);
  const [startFailed, setStartFailed] = useState<string | null>(null);
  const startIdRef = useRef<string | null>(null);
  const shownAt = useRef(0);
  // github 面板上报的「PR 已成功解析且 gh 已登录」;作为该来源可发起的门控
  // GitHubPanel 解析出的**完整** PR 引用(owner/repo#n);空串 = 还不能发起。
  // 存引用而不是一个 bool:发起时必须用它,不能用输入框里的原文 —— 见 startRef。
  const [ghResolvedRef, setGhResolvedRef] = useState('');
  // 活跃会话并发容量:满载(全在跑)时不让发起,并列出在跑的那几条
  const [capacity, setCapacity] = useState<LiveCapacity | null>(null);

  const refreshRecent = () => window.duetlens.review.listRecent().then(setReviews);
  // 回传拿到的快照(拉不到给 null):满载拦截要凭它决定是交给面板还是退回报错,不能只更新 state
  const refreshCapacity = useCallback(
    (): Promise<LiveCapacity | null> =>
      window.duetlens.review
        .capacity()
        .then((c) => {
          setCapacity(c);
          return c;
        })
        .catch(() => null),
    [],
  );
  useEffect(() => {
    void refreshRecent();
    void refreshCapacity();
    window.duetlens.agent.listModels().then(setModels).catch(() => setModels([]));
    window.duetlens.source.listRepoPaths().then(setRecentRepos).catch(() => setRecentRepos([]));
  }, [refreshCapacity]);

  // 会话跑完不会有事件通知入口(那是 review 屏的事),故停留期间自己轮询一次容量。
  useEffect(() => {
    const t = window.setInterval(() => void refreshCapacity(), CAPACITY_POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshCapacity]);

  // 阶段推进只认当前这次发起的 startId,重试后旧的一路事件不会再往浮层里灌
  useEffect(
    () =>
      window.duetlens.review.onStartProgress((p) => {
        if (p.startId === startIdRef.current) setStartStage(p.stage);
      }),
    [],
  );

  // settings 落地后预填默认来源/仓库/模型/effort 一次(不覆盖用户随后编辑)
  const prefilled = useRef(false);
  useEffect(() => {
    if (loaded && !prefilled.current) {
      prefilled.current = true;
      const repoTab = settings.defaultSource !== 'github-pr';
      setTab(repoTab ? 'repo' : 'github-pr');
      if (repoTab) setRepoPath(settings.lastRepoPath);
      setModel(settings.defaultModel);
      setEffort(settings.defaultEffort);
      setIntensity(settings.defaultIntensity);
    }
  }, [loaded, settings.defaultSource, settings.lastRepoPath, settings.defaultModel, settings.defaultEffort, settings.defaultIntensity]);

  // 切来源时重置该来源无关的选择(仓库路径可跨来源沿用,便于两档指同一仓库)
  const onSwitchTab = (next: EntryTab) => {
    if (next === tab) return;
    setTab(next);
    setRef('');
    // base 是「相对哪条 ref 审」,换来源后原来那条多半在新来源里根本不存在;
    // 不清的话它会一路带到发起,把一个 PR 拿去和上一个仓库的分支比。
    setBaseRef('');
    setError(null);
    if (next === 'repo' && !repoPath.trim()) setRepoPath(settings.lastRepoPath);
  };

  // 换仓库即换审核对象:已选分支、base、模式覆盖都不该跟着走
  const pickRepo = (dir: string) => {
    if (dir === repoPath) return;
    setRepoPath(dir);
    setRef('');
    setBaseRef('');
    setForceLocal(false);
  };

  const pickDir = async () => {
    const dir = await window.duetlens.dialog.pickDirectory();
    if (dir) pickRepo(dir);
  };

  // 选定仓库后一次探测定模式;失败按普通 git 分支兜底
  useEffect(() => {
    const p = repoPath.trim();
    if (tab !== 'repo' || !p) {
      setInspection(null);
      return;
    }
    let alive = true;
    setInspecting(true);
    window.duetlens.source
      .inspectRepo(p)
      .then((r) => {
        if (!alive) return;
        setInspection(r);
        // 选到子目录时归一到 git 顶层(本 effect 会以顶层路径再跑一次,结果相同)
        if (r.repoPath !== p) pickRepo(r.repoPath);
      })
      .catch(() => alive && setInspection(null))
      .finally(() => alive && setInspecting(false));
    return () => {
      alive = false;
    };
  }, [tab, repoPath]);

  const repoMode: RepoMode = forceLocal ? 'local' : inspection?.mode ?? 'local';
  const source: SourceKind =
    tab === 'github-pr' ? 'github-pr' : repoMode === 'gitbutler' ? 'gitbutler-vbranch' : 'local-branch';

  // **发起用已解析出的引用,不用输入框原文**。原文允许只写 `#123`,后端会拿 repoPath 再推一次
  // owner/repo —— 于是「屏上显示 A#123、审的却是 B#123」只需要中途换一次本地路径就能发生
  // (换路径不改查询串,旧 preview 不作废,发起门槛也一直开着)。
  // 身份在解析那一刻就钉死,展示与提交同源,这条缝就不存在了。
  const startRef = tab === 'github-pr' ? ghResolvedRef : ref.trim();
  const target = useTargetLabel(source, startRef);
  const atCapacity = isAtCapacity(capacity);
  const canStart =
    !busy && !atCapacity && !!startRef && (tab === 'github-pr' || !!repoPath.trim());

  const start = async () => {
    const startId = newStartId();
    startIdRef.current = startId;
    setBusy(true);
    setError(null);
    setStartFailed(null);
    setStartStage('resolve');
    const trimmedModel = model.trim();
    const input: ReviewStartInput = {
      source,
      ref: startRef,
      repoPath: repoPath.trim() || undefined,
      baseRef: baseRef.trim() || undefined,
      model: trimmedModel || undefined,
      reasoningEffort: effort,
      intensity,
      context: context.trim() || undefined,
      startId,
    };
    update({
      defaultModel: trimmedModel,
      defaultEffort: effort,
      defaultIntensity: intensity,
      ...(tab === 'repo' && repoPath.trim() ? { lastRepoPath: repoPath.trim() } : {}),
    });
    // 只有慢启动才升浮层:本地分支常几百毫秒就回来,闪一下比不闪更吵
    const rise = window.setTimeout(() => {
      shownAt.current = performance.now();
      setOverlay(true);
    }, START_OVERLAY_DELAY);
    try {
      const review = await window.duetlens.review.start(input);
      window.clearTimeout(rise);
      await settleOverlay(shownAt.current);
      onOpenReview(review.id);
    } catch (e) {
      window.clearTimeout(rise);
      const message = (e as Error).message ?? String(e);
      // 满载是可预期的拦截、不是故障:刷新容量让拦截面板接手,别把一串英文 code 甩给用户。
      // 但只有**确实刷出了满载快照**才交给面板 —— 容量接口本身失败(或此刻已被腾空)时面板
      // 根本不出现,那就退回普通报错,否则用户每点一次都只看见界面纹丝不动、真实原因还全丢了。
      const atLimit = isLiveSessionLimit(message);
      if (atLimit && isAtCapacity(await refreshCapacity())) {
        setOverlay(false);
        setStartStage(null);
        shownAt.current = 0;
        setBusy(false);
        return;
      }
      const shown = atLimit ? stripLimitCode(message) : message;
      // 浮层已经挡住界面,就地转错误态;还没升起来的快速失败仍走卡片内行内报错
      if (shownAt.current) setStartFailed(shown);
      else setError(shown);
      setBusy(false);
    }
  };

  // 返回修改:收浮层、把失败原因留在卡片里,选项与已填内容原样保留
  const dismissOverlay = () => {
    startIdRef.current = null;
    shownAt.current = 0;
    setOverlay(false);
    setStartStage(null);
    if (startFailed) setError(startFailed);
    setStartFailed(null);
  };

  return (
    <div className="entry-wrap">
      <div className="entry-hero">
        <LogoMark size={64} className="entry-mark" />
        <div className="entry-logo mono">
          duet<i>lens</i>
          <span className="cur">_</span>
        </div>
        <div className="entry-tag">
          和 <span className="a">agent</span> 看透每一处改动
        </div>
      </div>

      <div className="entry-card">
        <div className="card-top">
          <div>
            <h2>发起一次审核</h2>
            <div className="sub">选择来源 · Duetlens 会拉取 diff 并启动 agent 会话做首轮机审</div>
          </div>
          <div className="srcseg">
            {SOURCE_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={t.value === tab ? 'on' : ''}
                onClick={() => onSwitchTab(t.value)}
              >
                <t.icon />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'github-pr' ? (
          <GitHubPanel
            prRef={ref}
            setPrRef={setRef}
            repoPath={repoPath}
            setRepoPath={setRepoPath}
            baseRef={baseRef}
            setBaseRef={setBaseRef}
            pickDir={pickDir}
            busy={busy}
            onResolved={setGhResolvedRef}
          />
        ) : (
          <RepoPanel
            source={source}
            repoPath={repoPath}
            pickDir={pickDir}
            pickRepo={pickRepo}
            recentRepos={recentRepos}
            inspection={inspection}
            inspecting={inspecting}
            mode={repoMode}
            forceLocal={forceLocal}
            setForceLocal={setForceLocal}
            selected={ref}
            setSelected={setRef}
            baseRef={baseRef}
            setBaseRef={setBaseRef}
          />
        )}

        <div className="cardfoot">
          <button
            type="button"
            className={ctxOpen ? 'ctxtoggle open' : 'ctxtoggle'}
            onClick={() => setCtxOpen((o) => !o)}
          >
            <span className="ci">✎</span>
            <span className="cl">
              给 agent 附加上下文 <span className="ctx-opt">可选</span>
            </span>
            <span className="chev">▸</span>
          </button>
          {ctxOpen && (
            <div className="ctxbox">
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={
                  '首轮机审前一并发给 agent,可留空。例如:\n· 重点关注并发安全与错误处理\n· 忽略 generated/ 下的文件'
                }
              />
              <div className="ctxhint mono">随首轮机审注入,agent 全程可见 · 不改变 read-only sandbox</div>
            </div>
          )}

          <div className="int-row">
            <span className="int-label">审核强度</span>
            <div className="int-seg">
              {REVIEW_INTENSITIES.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={v === intensity ? 'on' : ''}
                  onClick={() => setIntensity(v)}
                >
                  {INTENSITY_LABELS[v]}
                </button>
              ))}
            </div>
            <span className="int-hint">{INTENSITY_HINTS[intensity]}</span>
          </div>

          <div className="cfg-row">
            <label className="cfg-field">
              <span>模型</span>
              {models && models.length > 0 ? (
                <select className="mono" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">账号默认</option>
                  {model && !models.some((m) => m.model === model) && (
                    <option value={model}>{model}(自定义)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.model} title={m.description}>
                      {m.displayName}
                      {m.isDefault ? ' · 默认' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={models === null ? '加载模型…' : 'codex 模型(留空=账号默认)'}
                />
              )}
            </label>
            <label className="cfg-field">
              <span>effort</span>
              <select
                className="mono"
                value={effort}
                onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
              >
                {REASONING_EFFORTS.map((v) => (
                  <option key={v} value={v}>
                    {EFFORT_LABELS[v]}
                  </option>
                ))}
              </select>
            </label>
            <label className="cfg-notify" title="扫描完成 / 追问回复时,窗口未聚焦弹系统通知,聚焦弹应用内提示">
              <input
                type="checkbox"
                checked={settings.notifyOnComplete}
                onChange={(e) => update({ notifyOnComplete: e.target.checked })}
              />
              完成时通知
            </label>
          </div>

          {error && <p className="start-error">{error}</p>}
          {atCapacity && (
            <CapacityNotice capacity={capacity!} onOpen={onOpenReview} onRefresh={refreshCapacity} />
          )}

          <div className="footcta">
            <span className="target">
              {target ? (
                <>
                  将审核 <b>{target}</b>
                </>
              ) : (
                <span className="target-empty">选择上方的来源目标</span>
              )}
            </span>
            <button type="button" className="gobtn" onClick={start} disabled={!canStart}>
              {busy ? '启动中…' : '开始审核'}
              <span className="arw">→</span>
            </button>
          </div>
        </div>
      </div>

      <RecentReviews reviews={reviews} onOpen={onOpenReview} />

      {overlay && (
        <StartOverlay
          stage={startStage ?? 'resolve'}
          target={target || startRef}
          error={startFailed}
          onRetry={() => void start()}
          onBack={dismissOverlay}
        />
      )}
    </div>
  );
}

/** 浮层升起前的静默期:比这更快返回的启动不该看见浮层一闪。 */
const START_OVERLAY_DELAY = 240;
/** 浮层已经露面时的最短停留,免得刚看清就被换屏。 */
const START_OVERLAY_MIN = 520;

function settleOverlay(shownAt: number): Promise<void> {
  if (!shownAt) return Promise.resolve();
  const rest = START_OVERLAY_MIN - (performance.now() - shownAt);
  return rest > 0 ? new Promise((r) => window.setTimeout(r, rest)) : Promise.resolve();
}

// ---------- GitHub PR panel ----------
function GitHubPanel({
  prRef,
  setPrRef,
  repoPath,
  setRepoPath,
  baseRef,
  setBaseRef,
  pickDir,
  busy,
  onResolved,
}: {
  prRef: string;
  setPrRef: (v: string) => void;
  repoPath: string;
  setRepoPath: (v: string) => void;
  baseRef: string;
  setBaseRef: (v: string) => void;
  pickDir: () => void;
  busy: boolean;
  /** 报上去的是解析出的完整引用(owner/repo#n);空串 = 还不能发起 */
  onResolved: (resolvedRef: string) => void;
}) {
  const [ghAuth, setGhAuth] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [remoteNwo, setRemoteNwo] = useState<string | null>(null);
  const [openPrs, setOpenPrs] = useState<PrSummary[] | null>(null);
  // 反推本地 clone:粘贴 PR 后自动填 repoPath;记住是否为自动匹配、以及已为哪个 nwo 试过(避免重复反推)
  const [inferred, setInferred] = useState(false);
  const [inferring, setInferring] = useState(false);
  const triedInferFor = useRef<string | null>(null);
  // 上一次真正发起解析的查询串:只有它变了才作废旧预览(改本地路径会重解析,但目标 PR 没变)
  const lastQuery = useRef('');
  // open PR 列表默认折叠:已贴 PR 链接时目标已确定,展开会把开始按钮挤出视野
  const [browseOpen, setBrowseOpen] = useState(false);
  // 祖先 PR 链(stacked PR 的形状);连同它是为哪个 PR 拉的一起存,换 PR 后旧链立即作废
  const [chain, setChain] = useState<{ key: string; value: ChainState } | null>(null);
  // 摸链失败后重来一次的闸;链是纯读取,重试无副作用
  const [chainTry, setChainTry] = useState(0);

  const recheckAuth = () => {
    setGhAuth(null);
    window.duetlens.source.checkGhAuth().then(setGhAuth).catch(() => setGhAuth(false));
  };
  useEffect(recheckAuth, []);

  // PR 引用防抖解析预览。
  // **输入一变,上一份解析结果立即作废**:留着它,`ghReady` 会一直是 true,防抖那 450ms 里点
  // 「开始审核」发起的是新 ref、界面与祖先链讲的却还是上一个 PR。
  // 请求发出后 cleanup 只清得掉定时器,故另立 alive 闸 —— 否则先发的那次晚回来会盖掉后发的结果。
  useEffect(() => {
    const q = prRef.trim();
    if (lastQuery.current !== q) {
      lastQuery.current = q;
      setPreview(null);
      setPreviewErr(null);
    }
    if (!q) {
      setPreviewing(false);
      return;
    }
    let alive = true;
    setPreviewing(true);
    const t = setTimeout(() => {
      window.duetlens.source
        .previewPr(q, repoPath.trim() || undefined)
        .then((p) => {
          if (!alive) return;
          setPreview(p);
          setPreviewErr(null);
        })
        .catch((e: Error) => {
          if (!alive) return;
          setPreview(null);
          setPreviewErr(e.message ?? String(e));
        })
        .finally(() => alive && setPreviewing(false));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [prRef, repoPath]);

  // 当前已解析出的目标 PR;祖先链、base、改动面计量、以及**真正发起时用的引用**都以它为准
  const prKey = preview ? `${preview.nwo}#${preview.number}` : '';

  // 可发起门控:gh 已登录 + PR 已成功解析(解析中/失败/未填均不可)。
  // 报上去的是 prKey 而不是一个 bool —— 父层拿它当发起引用,身份就钉在解析那一刻,
  // 不会再被后端按 repoPath 重推一次。
  useEffect(() => {
    onResolved(ghAuth === true && !previewErr ? prKey : '');
  }, [ghAuth, prKey, previewErr, onResolved]);
  useEffect(() => () => onResolved(''), [onResolved]);

  // 解析出 PR 后摸一次祖先链:stacked 时它就是 base 候选,非 stacked 时只有一环(= PR 自己的 base)。
  // **每层一次 gh 调用,现实里要几秒** —— 这段的可见反馈见 BaseProbeRow。
  //
  // **只认 prKey,不吃 preview 与 repoPath**:链只取决于是哪个 PR。prKey 自带 owner/repo,
  // 所以 prBaseChain 那个 repoPath 兜底参数在这条路径上永远用不上;而改本地路径会重跑
  // previewPr、换出一个新的 preview 对象,把这两样留在依赖里就会为同一个 PR 反复重摸 ——
  // 白烧几次 gh 是小事,要命的是重摸期间候选表是空的:选择器与宽范围警告双双消失,
  // 用户手上那条 base 却还在生效,于是可以发起一次自己看不见的宽审核。
  useEffect(() => {
    if (!prKey) {
      setChain(null);
      return;
    }
    let alive = true;
    setChain(null);
    window.duetlens.source
      .prBaseChain(prKey)
      .then((v) => alive && setChain({ key: prKey, value: { state: 'value', value: v } }))
      .catch(
        (e: Error) =>
          alive && setChain({ key: prKey, value: { state: 'error', message: e.message ?? String(e) } }),
      );
    return () => {
      alive = false;
    };
  }, [prKey, chainTry]);

  // 探测中与探测失败必须可分:都落回「没有候选」的话,一次拉不动的链会静悄悄地
  // 表现成「这个 PR 不是 stacked」,而用户本可以重贴一次或去查 gh。
  const chainState: ChainState = chain?.key === prKey ? chain.value : PROBING;
  const ancestors = chainState.state === 'value' ? chainState.value : [];
  const baseOptions = useMemo<BaseOption[]>(
    () => prBaseOptions(ancestors, preview?.number ?? 0),
    [ancestors, preview],
  );
  // **base 属于某一个具体的 PR,目标一变就清** —— 不能改判成「不在候选里才清」:
  // 祖先链是异步的,在它到手前(或它压根拉失败时)候选是空的,那种判法一条都清不掉,
  // 旧 base 会跟着新 PR 一路发起。清空即回到「跟随该 PR 自己的 base」,是安全的那一侧。
  // 手上这条 baseRef 是为哪个 prKey 选的。只在选择事件里写(不在 render 期写),故 render 期读安全。
  const baseOwner = useRef('');
  const lastPrKey = useRef(prKey);
  useEffect(() => {
    if (lastPrKey.current === prKey) return;
    lastPrKey.current = prKey;
    baseOwner.current = '';
    setBaseRef('');
  }, [prKey, setBaseRef]);

  // 链一落定就用它校验手上这条 base:候选里没有它(探测失败 / 链变短了)就清掉。
  // **不能连 probing 一起判** —— 那会让每次改本地路径都白白吞掉用户选好的 base;
  // 而落定后候选是空的,界面上已经既不显示这条 base、也不出宽范围警告了,
  // 再拿它发起就是「说的和做的不一样」(错误行写的是「先按该 PR 自己的 base 审」)。
  useEffect(() => {
    if (chainState.state === 'probing' || !baseRef) return;
    if (baseOptions.some((o) => o.ref === baseRef)) return;
    baseOwner.current = '';
    setBaseRef('');
  }, [chainState.state, baseOptions, baseRef, setBaseRef]);

  const prLadder = prLadderNodes(ancestors, preview?.number ?? 0);
  const prBaseIndex = Math.max(0, prLadder.indexOf(ladderLabel(ancestors, baseRef || ancestors[0]?.ref)));
  // **不等祖先链**:默认档的计量与链无关(PR 自己的 base 就是默认档),而链要串几次 gh。
  // 串着发会让「链回来」和「数回来」排成两段等待;并行发出后,链一到手数往往已经在了。
  // 代价是非 stacked PR 也会白算一次 —— github source 不落地(prepare + getDiff 两次 gh、无 clone),
  // 换掉一整段可见的空白等待值这个价。
  // 目标刚换、旧 base 还没清掉的那一帧,别拿上一个 PR 的 base 去问新 PR 的 compare:
  // 清理走 effect(commit 后才生效),而计量的 effect 就在同一轮 flush 里、闭包里捏的还是旧值,
  // 请求发出去就撤不回来了。**只能在 render 期派生**。
  // 判据是「这条 base 是为哪个 PR 选的」,不是「它在不在新 PR 的候选表里」——
  // 两个 PR 的候选里撞上同名 ref 是常事(stack 换条线重开就会),按候选表判会把旧 base 放过去。
  const statBase = baseOwner.current === prKey ? baseRef : '';
  const stat = useDiffStat({
    source: 'github-pr',
    ref: prKey,
    repoPath: repoPath.trim(),
    baseRef: statBase,
    enabled: !!preview,
  });

  // 指定本地仓库后:取 remote 归属(用于匹配校验 + 作为 open PR 列表的来源)
  useEffect(() => {
    const p = repoPath.trim();
    setOpenPrs(null);
    setBrowseOpen(false);
    if (!p) {
      setRemoteNwo(null);
      return;
    }
    let alive = true;
    window.duetlens.source.getRepoRemote(p).then((info) => {
      if (alive) setRemoteNwo(info.nwo);
    });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  // 展开时才拉列表:折叠状态不该为看不见的内容打 gh
  useEffect(() => {
    const p = repoPath.trim();
    if (!browseOpen || !remoteNwo || openPrs !== null) return;
    let alive = true;
    window.duetlens.source
      .listOpenPrs({ repoPath: p })
      .then((prs) => alive && setOpenPrs(prs))
      .catch(() => alive && setOpenPrs([]));
    return () => {
      alive = false;
    };
  }, [browseOpen, remoteNwo, openPrs, repoPath]);

  // PR 解析成功且用户未填本地路径时,自动反推本机 clone 并预填(每个 nwo 只试一次,尊重手动输入)
  useEffect(() => {
    if (!preview || repoPath.trim() || triedInferFor.current === preview.nwo) return;
    triedInferFor.current = preview.nwo;
    let alive = true;
    setInferring(true);
    window.duetlens.source
      .inferLocalRepo(preview.nwo)
      .then((p) => {
        if (alive && p) {
          setRepoPath(p);
          setInferred(true);
        }
      })
      .catch(() => {})
      .finally(() => alive && setInferring(false));
    return () => {
      alive = false;
    };
  }, [preview, repoPath, setRepoPath]);

  // 手动改动路径即视为用户接管,撤下「自动匹配」标记
  const onPathChange = (v: string) => {
    setRepoPath(v);
    setInferred(false);
  };

  if (ghAuth === false) {
    return (
      <div className="src-panel">
        <div className="gh-auth">
          <div className="ga-head">
            <span className="ga-ic">⚠</span> <b>未检测到 GitHub CLI 登录</b>
          </div>
          <div className="ga-body">
            Duetlens 通过 <code>gh</code> CLI 拉取 PR diff、并在提交时回写 review。请先在终端登录:
          </div>
          <div className="ga-cmd mono">$ gh auth login</div>
          <div className="ga-actions">
            <button type="button" className="ga-retry" onClick={recheckAuth}>
              已登录,重试
            </button>
          </div>
          <div className="ga-alt">◇ 本地分支 / GitButler 来源无需 gh,可直接开始。</div>
        </div>
      </div>
    );
  }

  const mismatch = preview && remoteNwo && remoteNwo !== preview.nwo;


  return (
    <div className="src-panel">
      <div className={previewErr ? 'ghfield err' : 'ghfield'}>
        <span className="gh">
          <GhIcon />
        </span>
        <input
          value={prRef}
          spellCheck={false}
          onChange={(e) => setPrRef(e.target.value)}
          placeholder="粘贴 PR 链接 · 或 owner/repo#123"
        />
        {previewing && <Busy>解析 PR…</Busy>}
      </div>

      {preview && (
        <div className="pr-resolved ok derived">
          <span className="ok">✓</span>
          <div className="info">
            <div className="l1">
              <span className="num mono">#{preview.number}</span> <span className="ttl">{preview.title}</span>
            </div>
            <div className="l2 mono">
              <span>@{preview.author}</span>
              <span>
                <span className="a">+{preview.additions}</span> <span className="d">−{preview.deletions}</span> ·{' '}
                {preview.changedFiles} files
              </span>
              <span className="base">← {preview.baseRef}</span>
            </div>
          </div>
        </div>
      )}
      {previewErr && (
        <div className="pr-resolved err derived">
          <span className="ok err">!</span>
          <div className="info">
            <div className="l1">
              <span className="ttl">无法解析这个 PR</span>
            </div>
            <div className="l2">
              <span className="emsg">{previewErr}</span> 确认链接,或用 <code className="mono">owner/repo#123</code> 格式重试。
            </div>
          </div>
        </div>
      )}

      {/* 摸链期间就把这一区摆出来:摸出多个候选就原地换成选择器(两者等高,不推屏);
          非 stacked 则收起 —— 那时 PR 卡片的「← base」已经把话说全了。
          **收起要过渡,不能直接撤**:多数 PR 走的正是这一支,硬撤会让下面凭空上跳一行。 */}
      {preview && !(chainState.state === 'value' && baseOptions.length > 1) && (
        <BaseSection tucked collapsed={chainState.state === 'value'}>
          <BaseProbeRow
            error={chainState.state === 'error' ? chainState.message : undefined}
            onRetry={() => setChainTry((n) => n + 1)}
          />
        </BaseSection>
      )}
      {baseOptions.length > 1 && (
        <BaseSection tucked>
          <BaseRow
            options={baseOptions}
            value={baseRef}
            onChange={(ref) => {
              baseOwner.current = prKey;
              setBaseRef(ref);
            }}
            stat={stat}
          />
          <StackLadder nodes={prLadder} baseIndex={prBaseIndex} />
          {baseRef && (
            <div className="scopewarn derived">
              <span className="si">◇</span>
              <div>
                本次会连下面几个 PR 的改动一起审。那些行不在 <code className="mono">#{preview!.number}</code>{' '}
                自己的 diff 里,锚在那儿的 finding 提交时会被 GitHub 拒收 ——
                提交屏会把它们单列出来,可并入摘要评论或导出。
              </div>
            </div>
          )}
        </BaseSection>
      )}

      <label className={mismatch ? 'pathfield warn' : 'pathfield'}>
        <span className="pf-ic">⌂</span>
        <input
          value={repoPath}
          spellCheck={false}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder="本地仓库路径(可选)· 让 agent 读全量代码,留空则临时 checkout"
        />
        <button type="button" className="pf-pick" onClick={pickDir} disabled={busy}>
          选择…
        </button>
        {inferring && !repoPath.trim() && <Busy>查找本地 clone…</Busy>}
        {repoPath.trim() && remoteNwo && (
          <span className={mismatch ? 'pf-tag warn' : 'pf-tag'}>
            {mismatch ? 'remote 不匹配 ⚠' : inferred ? '自动匹配 ✓' : '已匹配 ✓'}
          </span>
        )}
      </label>
      {mismatch && (
        <div className="path-warn derived">
          该目录的 remote 是 <code className="mono">{remoteNwo}</code>,不是 <code className="mono">{preview!.nwo}</code>。
          继续将忽略本地路径、改用临时 checkout;或选对目录以复用本地全量代码。
        </div>
      )}

      {remoteNwo && (
        <div className="prbrowse derived">
          <button
            type="button"
            className={browseOpen ? 'prtoggle open' : 'prtoggle'}
            onClick={() => setBrowseOpen((o) => !o)}
          >
            <span className="pi">
              <GhIcon />
            </span>
            <span className="pl">
              从 <code className="mono">{remoteNwo}</code> 的 open PR 中选择
              {openPrs && openPrs.length > 0 ? <span className="prcount mono">{openPrs.length}</span> : null}
            </span>
            <span className="chev">▸</span>
          </button>
          {browseOpen && (
            <div className="prbox">
              {openPrs === null && (
                <div className="list-loading">
                  <Busy>列举 open PR…</Busy>
                </div>
              )}
              {openPrs?.length === 0 && <div className="list-empty">该仓库没有 open PR。</div>}
              {openPrs && openPrs.length > 0 && (
                <div className="prlist">
                  {openPrs.map((p) => (
                    <div
                      key={p.number}
                      className={preview?.number === p.number ? 'pritem sel' : 'pritem'}
                      onClick={() => {
                        setPrRef(`${remoteNwo}#${p.number}`);
                        setBrowseOpen(false);
                      }}
                    >
                      <span className="num mono">#{p.number}</span>
                      <div className="m">
                        <div className="t">{p.title}</div>
                        <div className="s mono">
                          <span>@{p.author}</span>
                          <span>
                            <span className="a">+{p.additions}</span> <span className="d">−{p.deletions}</span>
                          </span>
                        </div>
                      </div>
                      <span className="go">→</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 本地仓库 panel(模式由探测结果决定:虚拟分支 / 普通 git 分支)----------
function RepoPanel({
  source,
  repoPath,
  pickDir,
  pickRepo,
  recentRepos,
  inspection,
  inspecting,
  mode,
  forceLocal,
  setForceLocal,
  selected,
  setSelected,
  baseRef,
  setBaseRef,
}: {
  source: SourceKind;
  repoPath: string;
  pickDir: () => void;
  pickRepo: (v: string) => void;
  recentRepos: string[];
  inspection: RepoInspection | null;
  inspecting: boolean;
  mode: RepoMode;
  forceLocal: boolean;
  setForceLocal: (v: boolean) => void;
  selected: string;
  setSelected: (v: string) => void;
  baseRef: string;
  setBaseRef: (v: string) => void;
}) {
  // 列表连同它属于哪次请求一起存:换仓库/换 base 后,旧结果在下一次结果到手前一律作废
  const [list, setList] = useState<{ key: string; value: LocalBranchList } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 普通 git 分支模式才列分支;vbranch 列表随探测一并回来,无需再拉
  const isGit = inspection?.isGit ?? false;
  const listing = mode === 'local' && isGit;
  const listKey = `${repoPath.trim()}\u0000${baseRef.trim()}`;
  const branchList = list?.key === listKey ? list.value : null;
  // 探测结果同理:inspect 回的是归一后的仓库路径,和当前路径对不上就是上一个仓库的
  const insp = !inspecting && inspection?.repoPath === repoPath.trim() ? inspection : null;
  const gbBranches = insp?.gitbutler?.branches;
  // 候选还没到手(探测中 / 列举中 / 结果已作废)—— 此时不给默认值,也不该让人发起审核
  const pending = listing ? loading || !branchList : !insp;

  useEffect(() => {
    const p = repoPath.trim();
    if (!p || !listing) {
      setList(null);
      // 上一次列举可能被切仓库/切模式打断(finally 只在 alive 时收尾),这里兜住残留的 loading
      setLoading(false);
      setErr(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    const key = listKey;
    window.duetlens.source
      .listLocalBranches(p, baseRef.trim() || undefined)
      .then((l) => {
        if (!alive) return;
        setList({ key, value: l });
      })
      .catch((e: Error) => alive && setErr(e.message ?? String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoPath, baseRef, listing]);

  const options = useMemo<BranchOption[]>(() => {
    if (mode === 'gitbutler') {
      return (gbBranches ?? []).map((b) => ({
        name: b.name,
        kind: 'vbranch',
        tag: 'vbranch',
        meta: b.fileCount === null ? '改动面未知' : `${b.fileCount} files`,
        detail: [b.hasUncommitted ? '未提交改动' : '', b.commitCount > 0 ? `归属 ${b.commitCount} 个 commit` : '']
          .filter(Boolean)
          .join(' · '),
      }));
    }
    return (branchList?.branches ?? []).map((b) => ({
      name: b.name,
      kind: 'git',
      isHead: b.isHead,
      badge: b.isHead ? 'HEAD' : undefined,
      tag: `← ${branchList!.base}`,
      meta: `${b.ahead} commits ahead`,
      detail: b.subject,
      updatedAt: b.updatedAt,
    }));
  }, [mode, gbBranches, branchList]);

  // 默认选中:普通 git 取 HEAD 所在分支,虚拟分支取第一条 —— 进屏即有目标,底部 CTA 不再是灰的
  useEffect(() => {
    if (pending) return;
    if (!options.length) {
      if (selected) setSelected('');
      return;
    }
    if (!options.some((o) => o.name === selected)) {
      setSelected((options.find((o) => o.isHead) ?? options[0]).name);
    }
  }, [options, pending, selected, setSelected]);

  const current = options.find((o) => o.name === selected) ?? null;

  // base 候选:vbranch 取同 stack 下层各条 + workspace base;普通 git 分支取后端给的 ref 候选
  const effectiveBase = baseRef || branchList?.base || '';
  const baseOptions = useMemo<BaseOption[]>(
    () =>
      mode === 'gitbutler'
        ? vbranchBaseOptions(gbBranches ?? [], insp?.gitbutler?.targetRef ?? null, selected)
        : localBaseOptions(branchList?.baseCandidates ?? [], branchList?.detectedBase ?? '', selected),
    [mode, gbBranches, insp, selected, branchList],
  );

  // **只在 base 对当前被审分支非法时才清**,判据是候选集本身(vbranch 取同 stack 下层各条,
  // 普通 git 取后端给的 ref 候选)。别改成「换分支就清」:清空等于回落到探测出的默认基线,而后端
  // 列分支时会把等于 base 的那条剔掉 —— 于是「审 main、比 release」只能先选 base 再选目标,
  // 而选中 main 的那一刻 base 被清回 main,目标又从列表里消失、被默认选中的 effect 换成 HEAD。
  // 候选**合法地为空**也要清(stack 最底层那条且读不到 targetRef),所以必须等候选到手再判,
  // 不能拿「空集」当「还没加载」搪塞 —— `pending` 就是这道闸。
  useEffect(() => {
    if (pending || !baseRef) return;
    if (!baseOptions.some((o) => o.ref === baseRef)) setBaseRef('');
  }, [pending, baseOptions, baseRef, setBaseRef]);

  const stat = useDiffStat({
    source,
    ref: selected,
    repoPath: repoPath.trim(),
    baseRef,
    enabled: !pending && !!selected,
  });

  if (!repoPath.trim()) {
    return (
      <div className="src-panel">
        <PickRepoEmpty
          pickDir={pickDir}
          hint="选择一个本地 git 仓库;在 gitbutler/workspace 分支上将按虚拟分支审核"
        />
        {recentRepos.length > 0 && (
          <div className="recent-repos">
            <span className="rr-lbl">最近用过</span>
            {recentRepos.slice(0, 5).map((p) => (
              <button key={p} type="button" className="rr-item" title={p} onClick={() => pickRepo(p)}>
                <span className="rr-name mono">{baseName(p)}</span>
                <span className="rr-dir mono">{parentDir(p)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const gb = insp?.gitbutler;
  return (
    <div className="src-panel">
      <div className="local-head">
        <span className="lbl">仓库</span>
        <span className="repo-path mono" title={repoPath}>
          {repoPath}
        </span>
        <RepoSwitch current={repoPath} recents={recentRepos} onPick={pickRepo} onBrowse={pickDir} />
        {/* 模式是自动判定的,普通分支这档也要说出来,否则「为什么不是虚拟分支」无处可查 */}
        {listing && insp && !insp.degraded && (
          <span className="mode-chip mono" title={insp.head ? `HEAD: ${insp.head}` : undefined}>
            git 分支
          </span>
        )}
      </div>

      {!insp && (
        <div className="list-loading derived">
          <Busy>探测仓库形态…</Busy>
        </div>
      )}

      {insp && !insp.isGit && (
        <div className="gb-hint warn derived">
          ⌂ <b>{repoPath}</b> 不是 git 仓库 ·{' '}
          <button type="button" className="link-btn" onClick={pickDir}>
            换个目录
          </button>
        </div>
      )}

      {insp?.degraded && (
        <div className="gb-hint warn derived">
          ⎇ 当前在 <code className="mono">gitbutler/workspace</code> 分支,但
          {insp.degraded === 'but-missing' ? '未找到 but CLI' : '该目录不是 GitButler 项目(未 setup)'} ·
          已按普通 git 分支审核
        </div>
      )}

      {mode === 'gitbutler' && gb && (
        <div className="gb-hint derived">
          ⎇ GitButler workspace · <b>{gb.repoName}</b> · {gb.branches.length} 个 virtual branch ·{' '}
          <button type="button" className="link-btn" onClick={() => setForceLocal(true)}>
            改按普通 git 分支审核
          </button>
        </div>
      )}
      {forceLocal && insp?.mode === 'gitbutler' && (
        <div className="gb-hint derived">
          ⎇ 已改按普通 git 分支审核 ·{' '}
          <button type="button" className="link-btn" onClick={() => setForceLocal(false)}>
            回到虚拟分支
          </button>
        </div>
      )}

      {insp && (listing || mode === 'gitbutler') && (
        <>
          <div className="picker-row">
            <span className="lbl w">审核分支</span>
            <BranchPicker
              options={options}
              value={selected}
              onChange={setSelected}
              loading={pending}
              emptyHint={
                listing ? `没有相对 ${effectiveBase} 领先的分支` : '该 workspace 暂无 applied 虚拟分支'
              }
            />
          </div>
          <BaseSection>
            {!pending && !!selected && baseOptions.length > 0 && (
              <BaseRow options={baseOptions} value={baseRef} onChange={setBaseRef} stat={stat} />
            )}
            {mode === 'gitbutler' && (
              <StackLadder
                nodes={stackNodes(gbBranches ?? [], insp?.gitbutler?.targetRef ?? null, selected)}
                baseIndex={stackBaseIndex(
                  gbBranches ?? [],
                  insp?.gitbutler?.targetRef ?? null,
                  selected,
                  baseRef || baseOptions.find((o) => o.isDefault)?.ref || '',
                )}
              />
            )}
          </BaseSection>
          {current && <BranchSummary option={current} base={listing ? effectiveBase : undefined} />}
          {err && <div className="start-error derived">{err}</div>}
        </>
      )}
    </div>
  );
}

/** 祖先链的三态。**探测中与探测失败不能并成一档** —— 见 chainState 处的说明。 */
type ChainState =
  | { state: 'probing' }
  | { state: 'value'; value: PrAncestor[] }
  | { state: 'error'; message: string };

const PROBING: ChainState = { state: 'probing' };

/**
 * stacked PR 的 base 候选:祖先链的每一环。`[0]` 是 PR 自己的 base,即默认基线。
 * 范围标签按「往下数到这一环为止会把哪几个 PR 算进来」写,列 PR 号而不是分支名 ——
 * 用户脑子里的 stack 是「pr1 → pr2 → pr3」,不是三个分支名。
 */
function prBaseOptions(chain: PrAncestor[], prNumber: number): BaseOption[] {
  return chain.map((a, i) => {
    const covered = [...chain.slice(0, i).map((x) => x.number), prNumber].filter(
      (n): n is number => n != null,
    );
    return {
      ref: a.ref,
      // number 为空只说明「没有以它为 head 的 open PR」,不等于它就是默认分支 —— 那要后端确认过才敢说
      label: a.number
        ? `PR #${a.number} 的 head${a.title ? ` · ${a.title}` : ''}`
        : a.isDefaultBranch
          ? '仓库默认分支'
          : '普通分支 · 无对应 open PR',
      scope: covered.length <= 1 ? `只审 #${prNumber}` : `含 ${covered.map((n) => `#${n}`).join(' ')}`,
      isDefault: i === 0,
    };
  });
}

/** 链路条上一环的显示名:有 PR 就用号,没有(仓库默认分支)就用分支名。 */
function ladderLabel(chain: PrAncestor[], ref: string | undefined): string {
  const hit = chain.find((a) => a.ref === ref);
  return hit?.number ? `#${hit.number}` : ref ?? '';
}

/** PR 链路条的节点,自底向上:最远的祖先 → … → 被审的这个 PR。 */
function prLadderNodes(chain: PrAncestor[], prNumber: number): string[] {
  if (!chain.length) return [];
  return [...chain.map((a) => (a.number ? `#${a.number}` : a.ref)).reverse(), `#${prNumber}`];
}

/** 同 stack 内位于 `selected` 下方的各条(近的在前);跨 stack 的分支不在其中 —— 它们之间没有叠加关系。 */
function lowerInStack(branches: VbranchSummary[], selected: string): VbranchSummary[] {
  const me = branches.find((b) => b.name === selected);
  if (!me) return [];
  return branches
    .filter((b) => b.stackId === me.stackId && b.stackOrder > me.stackOrder)
    .sort((a, b) => a.stackOrder - b.stackOrder);
}

/**
 * 虚拟分支的 base 候选:同 stack 各下层分支 + workspace base。
 * 默认那条 = 紧邻的下层分支(没有下层则是 workspace base)—— 那正是 `but diff <branch>` 的口径。
 */
function vbranchBaseOptions(
  branches: VbranchSummary[],
  targetRef: string | null,
  selected: string,
): BaseOption[] {
  if (!selected) return [];
  const lower = lowerInStack(branches, selected);
  const opts: BaseOption[] = lower.map((b, i) => ({
    ref: b.name,
    label: '同 stack 下层分支',
    scope: coverScope(i + 1),
    isDefault: i === 0,
  }));
  if (targetRef) {
    opts.push({
      ref: targetRef,
      label: 'workspace base',
      scope: coverScope(lower.length + 1),
      isDefault: lower.length === 0,
    });
  }
  return opts;
}

/**
 * 普通 git 分支的 base 候选;`detected` 必须是**自动探测**出的那条,不是本次生效的那条。
 *
 * **排除被审分支自己**:选中它并不会得到一份空 diff 就完事 —— 后端列分支时会把等于 base 的那条
 * 剔出去,于是「审核分支」在候选里消失,默认选中的 effect 接手改成 HEAD/首项。一次改 base 的操作
 * 会静默把审核目标也换掉,而界面上只有那一行下拉动过。
 */
function localBaseOptions(candidates: string[], detected: string, selected: string): BaseOption[] {
  return candidates
    .filter((ref) => ref !== selected)
    .map((ref) => ({
      ref,
      label: ref === detected ? '自动探测的基线' : '',
      scope: '',
      isDefault: ref === detected,
    }));
}

/** 覆盖 N 层时的范围短语。 */
function coverScope(covered: number): string {
  return covered <= 1 ? '只审这一层' : `含 ${covered} 条分支`;
}

/** 链路条的节点,自底向上:workspace base → 各下层分支 → 被审那条。 */
function stackNodes(branches: VbranchSummary[], targetRef: string | null, selected: string): string[] {
  if (!selected) return [];
  const lower = lowerInStack(branches, selected);
  return [...(targetRef ? [targetRef] : []), ...lower.map((b) => b.name).reverse(), selected];
}

/** 当前 base 在链路条上的位次;落不到(候选刚变)就退到栈底,宁可把范围画大也别画成空。 */
function stackBaseIndex(
  branches: VbranchSummary[],
  targetRef: string | null,
  selected: string,
  baseRef: string,
): number {
  const i = stackNodes(branches, targetRef, selected).indexOf(baseRef);
  return i >= 0 ? i : 0;
}

function PickRepoEmpty({ pickDir, hint }: { pickDir: () => void; hint: string }) {
  return (
    <div className="pick-empty">
      <button type="button" className="pick-cta" onClick={pickDir}>
        选择仓库目录…
      </button>
      <span className="pick-hint">{hint}</span>
    </div>
  );
}

/** 底部 CTA 的目标标签(来源 + 已选 ref)。 */
function useTargetLabel(source: SourceKind, ref: string): string {
  return useMemo(() => {
    const r = ref.trim();
    if (!r) return '';
    if (source === 'github-pr') {
      const num = r.match(/#?(\d+)\s*$/)?.[1];
      return num ? `GitHub #${num}` : `GitHub ${r}`;
    }
    if (source === 'local-branch') return `本地 ${r}`;
    return `vbranch ${r}`;
  }, [source, ref]);
}
