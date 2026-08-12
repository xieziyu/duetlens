import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Finding, Review } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import {
  buildReviewMarkdown,
  exportFileName,
  isKept,
  DEFAULT_EXPORT_OPTIONS,
  type ExportOptions,
} from '@shared/export-markdown';
import { isSubmittable, needsRecheckFollowUp } from '@shared/github-review';
import { renderMarkdown } from './markdown';
import './ExportMarkdownScreen.css';

const SEV_DOT: Record<Finding['severity'], string> = { high: 'high', medium: 'med', low: 'low' };

interface Props {
  review: Review;
  findings: Finding[];
  onBack: () => void;
  /** 切换某条 finding 的保留/剔除(经 setTriage 落库);同 diff-review triage 管线。 */
  onToggleKeep: (finding: Finding) => void;
  /** 终点切换分段(github-pr 才有);给了就顶掉面包屑。 */
  tabs?: ReactNode;
  /**
   * 给 suggestion 补缩进所依据的 diff(见 alignSuggestion)。github-pr 下由提交屏转来 ——
   * 那边会现拉最新 diff 并据它重锚,这里再去读审核快照的话,同一个 file:line 可能是另一行。
   * 不给则自己读快照:其余 source 没有提交这一步,锚点不会动。
   */
  diff?: DiffFile[];
  /** 返回 diff 屏并就地开一轮复审;不给(如提交在途 / 仍在扫描)则不出这个入口。 */
  onRerun?: () => void;
}

// 左预览(渲染/源码)+ 右导出配置。
export function ExportMarkdownScreen({
  review,
  findings,
  onBack,
  onToggleKeep,
  tabs,
  diff,
  onRerun,
}: Props) {
  const isGithub = review.source === 'github-pr';
  const round = review.currentRound;
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');
  const [copied, setCopied] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // 上层没给就自己读审核快照;读不到就原样导出,不挡预览
  const [ownDiff, setOwnDiff] = useState<DiffFile[]>([]);
  useEffect(() => {
    if (diff) return;
    void window.duetlens.review.diff(review.id).then(setOwnDiff);
  }, [diff, review.id]);

  const anchorDiff = diff ?? ownDiff;
  const md = useMemo(
    () => buildReviewMarkdown(review, findings, opts, anchorDiff),
    [review, findings, opts, anchorDiff],
  );
  const fileName = useMemo(() => exportFileName(review), [review]);
  const rendered = useMemo(() => renderMarkdown(md), [md]);

  const keptCount = findings.filter(isKept).length;
  const dropCount = findings.length - keptCount;
  const pendingCount = findings.filter((f) => isSubmittable(f, round)).length;

  const toggleOpt = (key: keyof ExportOptions) =>
    setOpts((o) => ({ ...o, [key]: !o[key] } as ExportOptions));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  const save = async () => {
    const path = await window.duetlens.dialog.saveTextFile(fileName, md);
    if (path) {
      setSavedPath(path);
      setTimeout(() => setSavedPath(null), 4000);
    }
  };

  return (
    <div className="export-md">
      <div className="exp-topbar">
        <button className="back" onClick={onBack}>
          ← 返回 diff
        </button>
        <span className="src-chip">
          <span className="ic">⎇</span> {isGithub ? 'GitHub' : (review.title ?? review.sourceRef)}
          <b>{review.sourceRef}</b>
        </span>
        {tabs ?? (
          <span className="crumb">
            Review · <b>导出 Markdown</b>
          </span>
        )}
      </div>

      <div className="exp-main">
        {/* ---- 左:报告预览 ---- */}
        <div className="pane preview">
          <div className="pv-head">
            <span className="lbl">
              报告预览 <span className="fn">{fileName}</span>
            </span>
            <div className="mini-seg">
              <button className={mode === 'rendered' ? 'on' : ''} onClick={() => setMode('rendered')}>
                渲染
              </button>
              <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>
                源码
              </button>
            </div>
          </div>
          <div className="pv-body">
            {mode === 'rendered' ? (
              <div className="md-doc" dangerouslySetInnerHTML={{ __html: rendered }} />
            ) : (
              <div className="md-raw">
                <pre>{md}</pre>
              </div>
            )}
          </div>
        </div>

        {/* ---- 右:导出配置 ---- */}
        <div className="pane config">
          <div className="cfg-head">
            <div className="t">↓ 导出为 Markdown</div>
            <div className="s">
              {isGithub
                ? '把这次 review 导出成一份报告,用于分享 / 存档 / 贴到别处;发给 PR 作者走「提交到 GitHub」。'
                : '本地分支无 PR 可提交,把这次 review 导出成一份报告,用于分享 / 存档 / 贴到别处。'}
            </div>
          </div>

          <div className="cfg-body">
            {isGithub && (
              <>
                <div className="sec-lbl">范围</div>
                <div className="grp-seg">
                  <button
                    className={opts.scope === 'all' ? 'on' : ''}
                    onClick={() => setOpts((o) => ({ ...o, scope: 'all' }))}
                  >
                    全部保留项 {keptCount}
                  </button>
                  <button
                    className={opts.scope === 'pending' ? 'on' : ''}
                    onClick={() => setOpts((o) => ({ ...o, scope: 'pending' }))}
                  >
                    仅未提交 {pendingCount}
                  </button>
                </div>
              </>
            )}

            <div className="sec-lbl">包含内容</div>
            <label className={'opt' + (opts.suggestion ? ' on' : '')} onClick={() => toggleOpt('suggestion')}>
              <span className="sw" />
              suggestion 代码块
            </label>
            <label className={'opt' + (opts.dismissed ? ' on' : '')} onClick={() => toggleOpt('dismissed')}>
              <span className="sw" />
              已剔除项<span className="sub">（划线列出）</span>
            </label>

            <div className="sec-lbl">Findings 分组</div>
            <div className="grp-seg">
              <button
                className={opts.group === 'severity' ? 'on' : ''}
                onClick={() => setOpts((o) => ({ ...o, group: 'severity' }))}
              >
                按严重度
              </button>
              <button
                className={opts.group === 'file' ? 'on' : ''}
                onClick={() => setOpts((o) => ({ ...o, group: 'file' }))}
              >
                按文件
              </button>
            </div>

            <div className="sec-lbl">保留哪些 finding</div>
            <div className="ck-tally">
              <span className="keep">保留 {keptCount}</span>
              <span className="drop">剔除 {dropCount}</span>
            </div>
            <div className="ck-list">
              {findings.map((f) => {
                const kept = isKept(f);
                // 已提交即锁定,与提交屏同一判据 —— 从这里改 triage 会把作者已收到的评论
                // 从待提交集里抹掉(欠一条复核追评的除外,那条发不发仍是 reviewer 的决定)
                const locked = isGithub && f.submission === 'submitted' && !needsRecheckFollowUp(f, round);
                return (
                  <div
                    key={f.id}
                    className={'ck-item' + (kept ? ' on' : ' off') + (locked ? ' locked' : '')}
                    onClick={() => !locked && onToggleKeep(f)}
                    title={locked ? '已提交到 GitHub · 锁定' : undefined}
                  >
                    <span className="ck">✓</span>
                    <span className={`dot ${SEV_DOT[f.severity]}`} />
                    <span className="t">{f.title}</span>
                    {locked && <span className="sub-flag">已提交</span>}
                    <span className="an">
                      {f.file}:{f.line}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="cfg-foot">
            <button className={'btn-copy' + (copied ? ' done' : '')} onClick={copy}>
              {copied ? '已复制到剪贴板 ✓' : '复制 Markdown'}
            </button>
            <button className="btn-save" onClick={save}>
              ↓ 保存为 .md 文件
            </button>
            {savedPath && <div className="note ok">已保存 · {savedPath}</div>}
            {/* 导出完通常是等作者改完再复审一轮 —— 少走一趟 diff 屏的顶栏 */}
            {onRerun && (
              <button className="btn-rerun" onClick={onRerun} title="⌘E">
                ↻ 返回 diff 并重跑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
