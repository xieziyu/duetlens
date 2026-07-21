import { useEffect, useRef, useState } from 'react';
import { REASONING_EFFORTS, type ReasoningEffort, type Review, type SourceKind } from '@shared/domain';
import type { ReviewStartInput } from '@shared/ipc';
import { useSettings } from '../settings/SettingsProvider';
import './EntryScreen.css';

const SOURCE_OPTIONS: { value: SourceKind; label: string; disabled?: boolean }[] = [
  { value: 'local-branch', label: '本地分支' },
  { value: 'github-pr', label: 'GitHub PR' },
  { value: 'gitbutler-vbranch', label: 'GitButler 虚拟分支' },
];

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'minimal · 最快',
  low: 'low',
  medium: 'medium · 默认',
  high: 'high',
  xhigh: 'xhigh · 最深',
};

// → mockup/entry.html:Hero + 发起审核卡片 + 最近的审核
export function EntryScreen({ onOpenReview }: { onOpenReview: (id: string) => void }) {
  const { settings, update, loaded } = useSettings();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [source, setSource] = useState<SourceKind>('local-branch');
  const [ref, setRef] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => window.duetlens.review.list().then(setReviews);
  useEffect(() => {
    void refresh();
  }, []);

  // 首帧用默认渲染,settings 落地后预填一次(不覆盖用户随后的编辑)
  const prefilled = useRef(false);
  useEffect(() => {
    if (loaded && !prefilled.current) {
      prefilled.current = true;
      setModel(settings.defaultModel);
      setEffort(settings.defaultEffort);
    }
  }, [loaded, settings.defaultModel, settings.defaultEffort]);

  const isLocal = source === 'local-branch';
  const isGithub = source === 'github-pr';
  const isButler = source === 'gitbutler-vbranch';
  // 本地/GitButler 必须指定仓库目录;GitButler 还需虚拟分支名;PR 只需 PR 标识
  const canStart =
    !busy &&
    (isGithub ? !!ref.trim() : isButler ? !!(repoPath.trim() && ref.trim()) : !!repoPath.trim());

  const pickDir = async () => {
    const dir = await window.duetlens.dialog.pickDirectory();
    if (dir) setRepoPath(dir);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    const trimmedModel = model.trim();
    const input: ReviewStartInput = {
      source,
      ref: ref.trim(),
      repoPath: repoPath.trim() || undefined,
      baseRef: baseRef.trim() || undefined,
      model: trimmedModel || undefined,
      reasoningEffort: effort,
    };
    // 记住本次选择作为下次发起的缺省
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
    <section className="entry">
      <div className="hero">
        <h1 className="mono hero-mark">duetlens_</h1>
        <p className="hero-sub">人与 agent 协同对话式 code review</p>
      </div>

      <div className="start-card">
        <div className="start-head">发起审核</div>

        <div className="start-form">
          <label className="field">
            <span className="field-label">source</span>
            <select
              className="field-input mono"
              value={source}
              onChange={(e) => setSource(e.target.value as SourceKind)}
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">{isGithub ? 'PR' : '分支'}</span>
            <input
              className="field-input mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder={
                isGithub
                  ? 'PR url / owner/repo#123 / 号'
                  : isButler
                    ? '虚拟分支名'
                    : '分支名(空=当前 HEAD)'
              }
            />
          </label>

          <label className="field">
            <span className="field-label">仓库</span>
            <span className="field-row">
              <input
                className="field-input mono"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder={
                  isGithub
                    ? '本地仓库路径(可选,读全量代码)'
                    : isButler
                      ? 'GitButler 项目目录'
                      : '本地 git 仓库目录'
                }
              />
              <button className="field-pick" type="button" onClick={pickDir} disabled={busy}>
                选择…
              </button>
            </span>
          </label>

          {isLocal && (
            <label className="field">
              <span className="field-label">基线</span>
              <input
                className="field-input mono"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                placeholder="diff 基线分支(空=自动探测默认分支)"
              />
            </label>
          )}

          <div className="field-pair">
            <label className="field">
              <span className="field-label">模型</span>
              <input
                className="field-input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="codex 模型(留空=账号默认)"
              />
            </label>
            <label className="field">
              <span className="field-label">effort</span>
              <select
                className="field-input mono"
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
          </div>
        </div>

        {error && <p className="start-error">{error}</p>}

        <div className="start-actions">
          <button className="start-cta" onClick={start} disabled={!canStart}>
            {busy ? '启动中…' : '▶ 开始审核'}
          </button>
          <button className="start-demo-link" onClick={startDemo} disabled={busy}>
            或跑内置演示
          </button>
          <span className="field-row" style={{ flex: 1 }} />
          <label className="start-pref" title="扫描完成 / 追问回复时,窗口未聚焦弹系统通知,聚焦弹应用内提示">
            <input
              type="checkbox"
              checked={settings.notifyOnComplete}
              onChange={(e) => update({ notifyOnComplete: e.target.checked })}
            />
            完成时通知
          </label>
        </div>
      </div>

      <div className="recent">
        <div className="recent-head">
          最近的审核 <span className="count">{reviews.length}</span>
        </div>
        {reviews.length === 0 ? (
          <p className="recent-empty">还没有审核记录。</p>
        ) : (
          <ul className="recent-list">
            {reviews.map((r) => (
              <li key={r.id} className="recent-row" onClick={() => onOpenReview(r.id)}>
                <span className={`badge s-${r.status}`}>{r.status}</span>
                <span className="recent-title">{r.title ?? r.sourceRef}</span>
                <span className="mono recent-source">{r.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
