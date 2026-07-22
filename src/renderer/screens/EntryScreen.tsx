import { useEffect, useMemo, useRef, useState } from 'react';
import {
  REASONING_EFFORTS,
  type CodexModelInfo,
  type ReasoningEffort,
  type SourceKind,
} from '@shared/domain';
import type { RecentReview, ReviewStartInput } from '@shared/ipc';
import type {
  GitButlerStatus,
  LocalBranchList,
  PrPreview,
  PrSummary,
} from '@shared/source-discovery';
import { useSettings } from '../settings/SettingsProvider';
import { GhIcon, GitButlerIcon, LocalBranchIcon } from './entry/icons';
import { RecentReviews } from './entry/RecentReviews';
import './EntryScreen.css';

const SOURCE_TABS: { value: SourceKind; label: string; icon: () => JSX.Element }[] = [
  { value: 'github-pr', label: 'GitHub PR', icon: GhIcon },
  { value: 'local-branch', label: '本地分支', icon: LocalBranchIcon },
  { value: 'gitbutler-vbranch', label: 'GitButler', icon: GitButlerIcon },
];

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'minimal · 最快',
  low: 'low',
  medium: 'medium · 默认',
  high: 'high',
  xhigh: 'xhigh · 最深',
};

// → mockup/entry.html:三来源分段选择器 + 各 panel + 附加上下文 + 最近的审核
export function EntryScreen({ onOpenReview }: { onOpenReview: (id: string) => void }) {
  const { settings, update, loaded } = useSettings();
  const [reviews, setReviews] = useState<RecentReview[]>([]);
  const [source, setSource] = useState<SourceKind>('github-pr');

  // 三来源共享:选定的 ref(PR 引用 / 分支名 / vbranch 名)与仓库路径
  const [ref, setRef] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseRef, setBaseRef] = useState('');

  // 审核配置
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('medium');
  const [context, setContext] = useState('');
  const [ctxOpen, setCtxOpen] = useState(false);
  const [models, setModels] = useState<CodexModelInfo[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // github 面板上报的「PR 已成功解析且 gh 已登录」;作为该来源可发起的门控
  const [ghReady, setGhReady] = useState(false);

  const refreshRecent = () => window.duetlens.review.listRecent().then(setReviews);
  useEffect(() => {
    void refreshRecent();
    window.duetlens.agent.listModels().then(setModels).catch(() => setModels([]));
  }, []);

  // settings 落地后预填模型/effort 一次(不覆盖用户随后编辑)
  const prefilled = useRef(false);
  useEffect(() => {
    if (loaded && !prefilled.current) {
      prefilled.current = true;
      setModel(settings.defaultModel);
      setEffort(settings.defaultEffort);
    }
  }, [loaded, settings.defaultModel, settings.defaultEffort]);

  // 切来源时重置该来源无关的选择(仓库路径可跨来源沿用,便于三来源指同一仓库)
  const onSwitchSource = (next: SourceKind) => {
    if (next === source) return;
    setSource(next);
    setRef('');
    setError(null);
  };

  const pickDir = async () => {
    const dir = await window.duetlens.dialog.pickDirectory();
    if (dir) setRepoPath(dir);
  };

  const target = useTargetLabel(source, ref);
  const canStart =
    !busy &&
    !!ref.trim() &&
    (source === 'github-pr' ? ghReady : !!repoPath.trim());

  const start = async () => {
    setBusy(true);
    setError(null);
    const trimmedModel = model.trim();
    const input: ReviewStartInput = {
      source,
      ref: ref.trim(),
      repoPath: repoPath.trim() || undefined,
      baseRef: source === 'local-branch' ? baseRef.trim() || undefined : undefined,
      model: trimmedModel || undefined,
      reasoningEffort: effort,
      context: context.trim() || undefined,
    };
    update({ defaultModel: trimmedModel, defaultEffort: effort });
    try {
      const review = await window.duetlens.review.start(input);
      onOpenReview(review.id);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const startDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const review = await window.duetlens.review.startDemo();
      onOpenReview(review.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="entry-wrap">
      <div className="entry-hero">
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
                className={t.value === source ? 'on' : ''}
                onClick={() => onSwitchSource(t.value)}
              >
                <t.icon />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {source === 'github-pr' && (
          <GitHubPanel
            prRef={ref}
            setPrRef={setRef}
            repoPath={repoPath}
            setRepoPath={setRepoPath}
            pickDir={pickDir}
            busy={busy}
            onReady={setGhReady}
          />
        )}
        {source === 'local-branch' && (
          <LocalPanel
            repoPath={repoPath}
            pickDir={pickDir}
            selected={ref}
            setSelected={setRef}
            baseRef={baseRef}
            setBaseRef={setBaseRef}
          />
        )}
        {source === 'gitbutler-vbranch' && (
          <GitButlerPanel
            repoPath={repoPath}
            setRepoPath={setRepoPath}
            pickDir={pickDir}
            selected={ref}
            setSelected={setRef}
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
                  placeholder={models === null ? '加载模型…' : '模型(留空=账号默认)'}
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
              <button type="button" className="demo-link" onClick={startDemo} disabled={busy}>
                或跑内置演示
              </button>
            </span>
            <button type="button" className="gobtn" onClick={start} disabled={!canStart}>
              {busy ? '启动中…' : '开始审核'}
              <span className="arw">→</span>
            </button>
          </div>
        </div>
      </div>

      <RecentReviews reviews={reviews} onOpen={onOpenReview} />
    </div>
  );
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

  // 指定本地仓库后:取 remote 归属(用于匹配校验 + 列该仓库 open PR)
  useEffect(() => {
    const p = repoPath.trim();
    if (!p) {
      setRemoteNwo(null);
      setOpenPrs(null);
      return;
    }
    let alive = true;
    window.duetlens.source.getRepoRemote(p).then((info) => {
      if (!alive) return;
      setRemoteNwo(info.nwo);
      if (info.nwo) {
        window.duetlens.source
          .listOpenPrs({ repoPath: p })
          .then((prs) => alive && setOpenPrs(prs))
          .catch(() => alive && setOpenPrs([]));
      } else {
        setOpenPrs(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [repoPath]);

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
        <div className="resolved ok">
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
        <div className="resolved err">
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
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="本地仓库路径(可选)· 让 agent 读全量代码,留空则临时 checkout"
        />
        <button type="button" className="pf-pick" onClick={pickDir} disabled={busy}>
          选择…
        </button>
        {repoPath.trim() && remoteNwo && (
          <span className={mismatch ? 'pf-tag warn' : 'pf-tag'}>{mismatch ? 'remote 不匹配 ⚠' : '已匹配 ✓'}</span>
        )}
      </label>
      {mismatch && (
        <div className="path-warn">
          该目录的 remote 是 <code className="mono">{remoteNwo}</code>,不是 <code className="mono">{preview!.nwo}</code>。
          继续将忽略本地路径、改用临时 checkout;或选对目录以复用本地全量代码。
        </div>
      )}

      {remoteNwo && openPrs && openPrs.length > 0 && (
        <>
          <div className="orline mono">{remoteNwo} 的最近 open PR</div>
          <div className="prlist">
            {openPrs.map((p) => (
              <div
                key={p.number}
                className={prRef.trim().includes(`#${p.number}`) ? 'pritem sel' : 'pritem'}
                onClick={() => setPrRef(`${remoteNwo}#${p.number}`)}
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
        </>
      )}
    </div>
  );
}

// ---------- Local branch panel ----------
function LocalPanel({
  repoPath,
  pickDir,
  selected,
  setSelected,
  baseRef,
  setBaseRef,
}: {
  repoPath: string;
  pickDir: () => void;
  selected: string;
  setSelected: (v: string) => void;
  baseRef: string;
  setBaseRef: (v: string) => void;
}) {
  const [list, setList] = useState<LocalBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const p = repoPath.trim();
    if (!p) {
      setList(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    window.duetlens.source
      .listLocalBranches(p, baseRef.trim() || undefined)
      .then((l) => {
        if (!alive) return;
        setList(l);
        if (!baseRef) setBaseRef(l.base);
      })
      .catch((e: Error) => alive && setErr(e.message ?? String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoPath, baseRef]);

  if (!repoPath.trim()) {
    return (
      <div className="src-panel">
        <PickRepoEmpty pickDir={pickDir} hint="选择一个本地 git 仓库,列出其分支" />
      </div>
    );
  }

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
        <span className="lbl base-lbl">对比 base</span>
        <select className="mono" value={baseRef} onChange={(e) => setBaseRef(e.target.value)}>
          {(list?.baseCandidates ?? [baseRef].filter(Boolean)).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      {loading && <div className="list-loading mono">列举分支…</div>}
      {err && <div className="start-error">{err}</div>}
      {list && list.branches.length === 0 && !loading && (
        <div className="list-empty">没有相对 {list.base} 领先的分支。</div>
      )}
      {list?.branches.map((b) => (
        <div
          key={b.name}
          className={selected === b.name ? 'branchrow sel' : 'branchrow'}
          onClick={() => setSelected(b.name)}
        >
          <span className="ic b">
            <LocalBranchIcon />
          </span>
          <div className="m">
            <div className="bn mono">{b.name}</div>
            <div className="bd">
              {b.isHead ? 'HEAD · ' : ''}
              {b.ahead} commits ahead · {b.subject}
            </div>
          </div>
          <span className="cmp mono">← {list.base}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- GitButler panel ----------
function GitButlerPanel({
  repoPath,
  setRepoPath,
  pickDir,
  selected,
  setSelected,
}: {
  repoPath: string;
  setRepoPath: (v: string) => void;
  pickDir: () => void;
  selected: string;
  setSelected: (v: string) => void;
}) {
  const [status, setStatus] = useState<GitButlerStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const p = repoPath.trim();
    if (!p) {
      setStatus(null);
      return;
    }
    let alive = true;
    setLoading(true);
    window.duetlens.source
      .detectGitButler(p)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus({ isWorkspace: false, repoName: '', branches: [] }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoPath]);

  if (!repoPath.trim()) {
    return (
      <div className="src-panel">
        <PickRepoEmpty pickDir={pickDir} hint="选择一个 GitButler 项目目录,检测其虚拟分支" />
      </div>
    );
  }

  return (
    <div className="src-panel">
      {loading && <div className="list-loading mono">检测 workspace…</div>}
      {status && !status.isWorkspace && !loading && (
        <div className="gb-hint warn">
          ⎇ <b>{repoPath}</b> 不是 GitButler workspace ·{' '}
          <button type="button" className="link-btn" onClick={pickDir}>
            换个目录
          </button>
        </div>
      )}
      {status?.isWorkspace && (
        <>
          <div className="gb-hint">
            ⎇ 检测到 GitButler workspace · <b>{status.repoName}</b> · {status.branches.length} 个 virtual branch ·{' '}
            <button type="button" className="link-btn" onClick={pickDir}>
              切换…
            </button>
          </div>
          {status.branches.length === 0 && <div className="list-empty">该 workspace 暂无 applied 虚拟分支。</div>}
          {status.branches.map((b) => (
            <div
              key={b.name}
              className={selected === b.name ? 'branchrow sel' : 'branchrow'}
              onClick={() => {
                setSelected(b.name);
                setRepoPath(repoPath);
              }}
            >
              <span className="ic v">
                <GitButlerIcon />
              </span>
              <div className="m">
                <div className="bn mono">{b.name}</div>
                <div className="bd">
                  {b.fileCount} files{b.hasUncommitted ? ' · 未提交改动' : ''}
                  {b.commitCount > 0 ? ` · 归属 ${b.commitCount} 个 commit` : ''}
                </div>
              </div>
              <span className="cmp mono">vbranch</span>
            </div>
          ))}
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
