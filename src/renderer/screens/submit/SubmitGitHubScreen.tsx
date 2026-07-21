import { useEffect, useMemo, useState } from 'react';
import type { Finding, Review } from '@shared/domain';
import type { SubmitReviewResult } from '@shared/ipc';
import { GH_REVIEW_EVENTS, hasAnchor, isSubmittable, type GhReviewEvent } from '@shared/github-review';
import './SubmitGitHubScreen.css';

const SEV_CLASS: Record<Finding['severity'], string> = { high: 'high', medium: 'med', low: 'low' };

const EVENT_META: Record<GhReviewEvent, { glyph: string; label: string; desc: string }> = {
  comment: { glyph: '💬', label: 'Comment', desc: '仅评论,不表态' },
  request_changes: { glyph: '✕', label: 'Request changes', desc: '要求修改后再合并' },
  approve: { glyph: '✓', label: 'Approve', desc: '批准合并' },
};

type SubState = 'ready' | 'submitting' | 'success' | 'invalid' | 'failed';

interface Props {
  review: Review;
  findings: Finding[];
  onBack: () => void;
}

// → mockup/submit-to-github.html:左 findings 筛选 + 右 Finish your review。
export function SubmitGitHubScreen({ review, findings, onBack }: Props) {
  const reviewId = review.id;
  const [event, setEvent] = useState<GhReviewEvent>('comment');
  const [sub, setSub] = useState<SubState>('ready');
  const [result, setResult] = useState<SubmitReviewResult | null>(null);
  const [summary, setSummary] = useState(review.summaryBody ?? '');

  // review body 若被别处(diff 屏 Summary tab)改动,同步进草稿(未编辑时)
  useEffect(() => setSummary(review.summaryBody ?? ''), [review.summaryBody]);

  const pending = useMemo(() => findings.filter(isSubmittable), [findings]);
  const submitted = useMemo(() => findings.filter((f) => f.submission === 'submitted'), [findings]);
  const dismissed = useMemo(() => findings.filter((f) => f.triage === 'dismiss'), [findings]);
  const inlineCount = pending.filter(hasAnchor).length;
  const keptCount = findings.filter((f) => f.triage !== 'dismiss').length;

  const toggleKeep = (f: Finding) => {
    if (f.submission === 'submitted') return; // 已提交锁定
    void window.duetlens.review.setTriage(reviewId, f.id, f.triage === 'dismiss' ? 'keep' : 'dismiss');
  };

  const saveSummary = () => {
    if (summary !== (review.summaryBody ?? '')) void window.duetlens.review.updateSummary(reviewId, summary);
  };

  const submit = async () => {
    if (pending.length === 0 || sub === 'submitting') return;
    setSub('submitting');
    const res = await window.duetlens.review.submit(reviewId, { event, summaryBody: summary });
    setResult(res);
    setSub(res.status);
  };

  const btnLabel =
    inlineCount > 0
      ? `提交到 GitHub · ${inlineCount} 行评论${summary.trim() ? ' + 摘要' : ''} →`
      : '提交到 GitHub · 仅摘要 →';

  return (
    <div className="submit-gh">
      <div className="sg-topbar">
        <button className="back" onClick={onBack}>
          ← 返回 diff
        </button>
        <span className="pr-chip">
          <span className="gh">⎇ GitHub</span> <b>{review.sourceRef}</b>
        </span>
        <span className="crumb">
          Review · <b>提交 findings</b>
        </span>
      </div>

      <div className="sg-main">
        {/* ---- 左:curate ---- */}
        <div className="pane curate">
          <div className="c-head">
            <h1>Submit review</h1>
            <span className="to">
              提交到 <b>{review.sourceRef}</b>
            </span>
          </div>
          <div className="c-sub">
            勾选要提交的 findings,剔除无用项。有行锚点的作为 inline 行评论,无锚点的归入 review 摘要。
          </div>

          <div className="bulkbar">
            <span className="lbl">agent 报告 {findings.filter((f) => f.origin === 'agent').length}</span>
            <span className="muted">· 你新增 {findings.filter((f) => f.origin !== 'agent').length}</span>
            <div className="tally">
              <span className="keep">保留 {keptCount}</span>
              <span className="drop">剔除 {dismissed.length}</span>
            </div>
          </div>

          {submitted.length > 0 && (
            <div className="incbar">↻ 上次已提交 {submitted.length} 条 · 已锁定,不重发</div>
          )}

          {findings.map((f) => {
            const isSubmitted = f.submission === 'submitted';
            const isDismissed = f.triage === 'dismiss';
            // 422 只说「某条锚点失效」,GitHub 不告诉是哪条 → 不逐条误标,只在 banner 提示。
            const cls =
              'finding' + (isSubmitted ? ' locked' : isDismissed ? ' dismissed' : ' kept');
            return (
              <div key={f.id} className={cls}>
                <span
                  className={'chk' + (!isDismissed ? ' on' : '')}
                  onClick={() => toggleKeep(f)}
                  title={isSubmitted ? '已提交锁定' : isDismissed ? '恢复' : '剔除'}
                >
                  {!isDismissed ? '✓' : ''}
                </span>
                <div className="f-main">
                  <div className="f-top">
                    <span className={`sev ${SEV_CLASS[f.severity]}`}>
                      {f.severity}
                      {f.category ? ` · ${f.category}` : ''}
                    </span>
                    <span className="f-title">{f.title}</span>
                  </div>
                  <div className="f-top">
                    <span className="f-anchor">
                      📍 <b>{f.file}</b>:{f.line}
                    </span>
                    <span className={'origin' + (f.origin === 'agent' ? ' agent' : ' human')}>
                      <span className="d" />
                      {f.origin === 'agent' ? 'codex · report_finding' : '你 · ' + (f.origin === 'promoted' ? '由 discussion 提升' : '手动新增')}
                    </span>
                  </div>
                  {!isDismissed && f.body.trim() && <div className="f-body">{f.body}</div>}
                  {!isDismissed && f.suggestion?.trim() && (
                    <div className="f-sugg">
                      <div className="h">suggestion · 将作为 GitHub suggestion 块</div>
                      <pre>{f.suggestion}</pre>
                    </div>
                  )}
                  {isSubmitted && (
                    <div className="f-status done">
                      已提交{f.submittedUrl ? '' : ''} · inline {f.file}:{f.line}
                    </div>
                  )}
                </div>
                {isDismissed && !isSubmitted && (
                  <button className="restore" onClick={() => toggleKeep(f)}>
                    ↩ 恢复
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- 右:finish ---- */}
        <div className="pane finish">
          <div className="h">
            <div className="t">◆ Finish your review</div>
            <div className="s">将组成 {review.sourceRef} 的一次 review 提交</div>
          </div>

          {sub === 'success' && result?.status === 'success' && (
            <div className="sub-banner ok">
              <span className="bi">✓</span>
              <div className="bt">
                <b>review 已提交</b> · {result.submittedCount} 行评论 + 摘要 ·{' '}
                <a href={result.url} target="_blank" rel="noreferrer">
                  在 GitHub 查看 ↗
                </a>
              </div>
            </div>
          )}
          {sub === 'invalid' && result?.status === 'invalid' && (
            <div className="sub-banner err">
              <span className="bi">⛔</span>
              <div className="bt">
                <b>提交被 GitHub 拒绝(422)</b> —— {result.message} PR review 是原子提交,须先处理该条(改锚点 / 降级为摘要 / 剔除)再整份重提。
              </div>
            </div>
          )}
          {sub === 'failed' && result?.status === 'failed' && (
            <div className="sub-banner err">
              <span className="bi">⚠</span>
              <div className="bt">
                <b>提交失败</b> —— {result.message} review <b>未提交</b>,findings 保持未提交,可重试。
              </div>
            </div>
          )}

          <div className="finish-body">
            <div className="field-lbl">Review 摘要(body)</div>
            <textarea
              className="summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={saveSummary}
              placeholder="review 的整体结论;无锚点 finding 会并入这里…"
              rows={5}
            />

            <div className="field-lbl mt">提交类型(event)</div>
            <div className="events">
              {GH_REVIEW_EVENTS.map((ev) => {
                const m = EVENT_META[ev];
                return (
                  <div
                    key={ev}
                    className={'event' + (event === ev ? ' on' : '')}
                    onClick={() => setEvent(ev)}
                  >
                    <span className="radio" />
                    <div>
                      <div className="et">
                        {m.glyph} {m.label}
                      </div>
                      <div className="ed">{m.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="finish-foot">
            {sub === 'success' ? (
              <>
                <button className="submit ghost" onClick={onBack}>
                  完成 · 返回 diff
                </button>
                <div className="foot-note">findings 已标记为已提交(锁定)</div>
              </>
            ) : sub === 'submitting' ? (
              <>
                <button className="submit busy" disabled>
                  <span className="spin-ic" /> 正在提交 review…
                </button>
                <div className="foot-note">调用 gh api …/reviews 中,请勿关闭</div>
              </>
            ) : (
              <>
                <button
                  className={'submit' + (sub === 'failed' ? ' retry' : '')}
                  onClick={submit}
                  disabled={pending.length === 0}
                >
                  {sub === 'failed' ? '↻ 重试提交' : pending.length === 0 ? '无可提交的 finding' : btnLabel}
                </button>
                <div className="foot-note">
                  {sub === 'invalid'
                    ? '修正红框那条后再整份提交'
                    : '经 gh 创建一次 PR review(原子) · 只读 sandbox 不影响'}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
