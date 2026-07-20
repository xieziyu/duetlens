import { useEffect, useState } from 'react';
import type { Review, SourceKind } from '@shared/domain';
import type { ReviewStartInput } from '@shared/ipc';
import './EntryScreen.css';

const SOURCE_OPTIONS: { value: SourceKind; label: string; disabled?: boolean }[] = [
  { value: 'local-branch', label: '本地分支' },
  { value: 'github-pr', label: 'GitHub PR' },
  { value: 'gitbutler-vbranch', label: 'GitButler 虚拟分支' },
];

// → mockup/entry.html:Hero + 发起审核卡片 + 最近的审核
export function EntryScreen({ onOpenReview }: { onOpenReview: (id: string) => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [source, setSource] = useState<SourceKind>('local-branch');
  const [ref, setRef] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => window.duetlens.review.list().then(setReviews);
  useEffect(() => {
    void refresh();
  }, []);

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
    const input: ReviewStartInput = {
      source,
      ref: ref.trim(),
      repoPath: repoPath.trim() || undefined,
      baseRef: baseRef.trim() || undefined,
    };
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
        </div>

        {error && <p className="start-error">{error}</p>}

        <div className="start-actions">
          <button className="start-cta" onClick={start} disabled={!canStart}>
            {busy ? '启动中…' : '▶ 开始审核'}
          </button>
          <button className="start-demo-link" onClick={startDemo} disabled={busy}>
            或跑内置演示
          </button>
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
