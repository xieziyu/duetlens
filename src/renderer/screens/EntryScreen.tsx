import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { RecentReview, ReviewStartInput, ReviewStartStage } from '@shared/ipc';
import type {
  LocalBranchList,
  PrPreview,
  PrSummary,
  RepoInspection,
  RepoMode,
} from '@shared/source-discovery';
import { useSettings } from '../settings/SettingsProvider';
import { BranchPicker, BranchSummary, type BranchOption } from './entry/BranchPicker';
import { GhIcon, LocalBranchIcon } from './entry/icons';
import { RecentReviews } from './entry/RecentReviews';
import { StartOverlay } from './entry/StartOverlay';
import { LogoMark } from '../components/LogoMark';
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
  const [ghReady, setGhReady] = useState(false);

  const refreshRecent = () => window.duetlens.review.listRecent().then(setReviews);
  useEffect(() => {
    void refreshRecent();
    window.duetlens.agent.listModels().then(setModels).catch(() => setModels([]));
    window.duetlens.source.listRepoPaths().then(setRecentRepos).catch(() => setRecentRepos([]));
  }, []);

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

  const target = useTargetLabel(source, ref);
  const canStart =
    !busy &&
    !!ref.trim() &&
    (tab === 'github-pr' ? ghReady : !!repoPath.trim());

  const start = async () => {
    const startId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    startIdRef.current = startId;
    setBusy(true);
    setError(null);
    setStartFailed(null);
    setStartStage('resolve');
    const trimmedModel = model.trim();
    const input: ReviewStartInput = {
      source,
      ref: ref.trim(),
      repoPath: repoPath.trim() || undefined,
      baseRef: source === 'local-branch' ? baseRef.trim() || undefined : undefined,
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
      // 浮层已经挡住界面,就地转错误态;还没升起来的快速失败仍走卡片内行内报错
      if (shownAt.current) setStartFailed(message);
      else setError(message);
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
          和 <span className="a">agent</span> 一起,看懂每一次改动
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
            pickDir={pickDir}
            busy={busy}
            onReady={setGhReady}
          />
        ) : (
          <RepoPanel
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
          target={target || ref.trim()}
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
  pickDir,
  busy,
  onReady,
}: {
  prRef: string;
  setPrRef: (v: string) => void;
  repoPath: string;
  setRepoPath: (v: string) => void;
  pickDir: () => void;
  busy: boolean;
  onReady: (ready: boolean) => void;
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
  // open PR 列表默认折叠:已贴 PR 链接时目标已确定,展开会把开始按钮挤出视野
  const [browseOpen, setBrowseOpen] = useState(false);

  const recheckAuth = () => {
    setGhAuth(null);
    window.duetlens.source.checkGhAuth().then(setGhAuth).catch(() => setGhAuth(false));
  };
  useEffect(recheckAuth, []);

  // 可发起门控:gh 已登录 + PR 已成功解析(解析中/失败/未填均不可)
  useEffect(() => {
    onReady(ghAuth === true && !!preview && !previewErr);
  }, [ghAuth, preview, previewErr, onReady]);
  useEffect(() => () => onReady(false), [onReady]);

  // PR 引用防抖解析预览
  useEffect(() => {
    const q = prRef.trim();
    if (!q) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    setPreviewing(true);
    const t = setTimeout(() => {
      window.duetlens.source
        .previewPr(q, repoPath.trim() || undefined)
        .then((p) => {
          setPreview(p);
          setPreviewErr(null);
        })
        .catch((e: Error) => {
          setPreview(null);
          setPreviewErr(e.message ?? String(e));
        })
        .finally(() => setPreviewing(false));
    }, 450);
    return () => clearTimeout(t);
  }, [prRef, repoPath]);

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
        {previewing && <span className="fld-spin mono">解析…</span>}
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
        {inferring && !repoPath.trim() && <span className="pf-tag muted mono">查找本地…</span>}
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
              {openPrs === null && <div className="list-loading mono">列举 open PR…</div>}
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
        if (!baseRef) setBaseRef(l.base);
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
        meta: `${b.fileCount} files`,
        detail: [b.hasUncommitted ? '未提交改动' : '', b.commitCount > 0 ? `归属 ${b.commitCount} 个 commit` : '']
          .filter(Boolean)
          .join(' · '),
      }));
    }
    return (branchList?.branches ?? []).map((b) => ({
      name: b.name,
      kind: 'git',
      isHead: b.isHead,
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
        <button type="button" className="pf-pick" onClick={pickDir}>
          切换…
        </button>
        {/* 模式是自动判定的,普通分支这档也要说出来,否则「为什么不是虚拟分支」无处可查 */}
        {listing && insp && !insp.degraded && (
          <span className="mode-chip mono" title={insp.head ? `HEAD: ${insp.head}` : undefined}>
            git 分支
          </span>
        )}
      </div>

      {!insp && <div className="list-loading mono derived">探测仓库…</div>}

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
            <span className="lbl">审核分支</span>
            <BranchPicker
              options={options}
              value={selected}
              onChange={setSelected}
              loading={pending}
              emptyHint={
                listing ? `没有相对 ${branchList?.base ?? baseRef} 领先的分支` : '该 workspace 暂无 applied 虚拟分支'
              }
            />
            {listing && (
              <>
                <span className="lbl base-lbl">对比 base</span>
                <select className="mono" value={baseRef} onChange={(e) => setBaseRef(e.target.value)}>
                  {(branchList?.baseCandidates ?? [baseRef].filter(Boolean)).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {current && <BranchSummary option={current} base={listing ? branchList?.base : undefined} />}
          {err && <div className="start-error derived">{err}</div>}
        </>
      )}
    </div>
  );
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

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const parentDir = (p: string) => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/');

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
