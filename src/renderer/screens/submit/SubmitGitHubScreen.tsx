import { useEffect, useMemo, useState } from 'react';
import type { Finding, Review } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { SubmitReviewResult } from '@shared/ipc';
import {
  GH_REVIEW_EVENTS,
  buildPrReviewPayload,
  hasAnchor,
  isStaleAnchor,
  isSubmittable,
  nearestLiveLine,
  submitBlocker,
  type GhReviewEvent,
} from '@shared/github-review';
import { renderMarkdown } from '../review/markdown';
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

// 左 findings 筛选 + 右 Finish your review。
export function SubmitGitHubScreen({ review, findings, onBack }: Props) {
  const reviewId = review.id;
  const [event, setEvent] = useState<GhReviewEvent>('comment');
  const [sub, setSub] = useState<SubState>('ready');
  const [result, setResult] = useState<SubmitReviewResult | null>(null);
  const [summary, setSummary] = useState(review.summaryBody ?? '');
  const [diff, setDiff] = useState<DiffFile[]>([]);

  // review body 若被别处(diff 屏 Summary tab)改动,同步进草稿(未编辑时)
  useEffect(() => setSummary(review.summaryBody ?? ''), [review.summaryBody]);
  // 拉最新 diff 以本地预判哪条 finding 行锚点已失效(GitHub 422 不告知是哪条)
  useEffect(() => {
    void window.duetlens.review.diff(reviewId).then(setDiff);
  }, [reviewId]);

  const pending = useMemo(() => findings.filter(isSubmittable), [findings]);
  const submitted = useMemo(() => findings.filter((f) => f.submission === 'submitted'), [findings]);
  const dismissed = useMemo(() => findings.filter((f) => f.triage === 'dismiss'), [findings]);
  const staleIds = useMemo(
    () => new Set(findings.filter((f) => isStaleAnchor(f, diff)).map((f) => f.id)),
    [findings, diff],
  );
  const inlineCount = pending.filter(hasAnchor).length;
  const keptCount = findings.filter((f) => f.triage !== 'dismiss').length;

  // suggestion diff 的「原行」文本:按 file+新侧行号从最新 diff 取,取不到则只渲染增行。
  const originalLineOf = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const file of diff)
      for (const hunk of file.hunks)
        for (const l of hunk.lines) if (l.newLine != null) byKey.set(`${file.path}:${l.newLine}`, l.text);
    return (f: Finding) => byKey.get(`${f.file}:${f.line}`);
  }, [diff]);

  const degradeToSummary = (f: Finding) => void window.duetlens.review.setFindingAnchor(reviewId, f.id, 0);
  const reAnchor = (f: Finding) => {
    const line = nearestLiveLine(f.file, f.line, diff);
    if (line != null) void window.duetlens.review.setFindingAnchor(reviewId, f.id, line);
  };

  const toggleKeep = (f: Finding) => {
    if (f.submission === 'submitted') return; // 已提交锁定
    void window.duetlens.review.setTriage(reviewId, f.id, f.triage === 'dismiss' ? 'open' : 'dismiss');
  };

  const saveSummary = () => {
    if (summary !== (review.summaryBody ?? '')) void window.duetlens.review.updateSummary(reviewId, summary);
  };

  // 按钮可用性走后端同一套判定(草稿 summary 先并进去,与实际提交内容一致)
  const blocked = useMemo(
    () => submitBlocker(buildPrReviewPayload({ ...review, summaryBody: summary }, pending, event)),
    [review, summary, pending, event],
  );

  const submit = async () => {
    if (blocked || sub === 'submitting') return;
    setSub('submitting');
    const res = await window.duetlens.review.submit(reviewId, { event, summaryBody: summary });
    setResult(res);
    setSub(res.status);
  };

  const btnLabel = (() => {
    const parts: string[] = [];
    if (inlineCount > 0) parts.push(`${inlineCount} 行评论`);
    if (summary.trim()) parts.push('摘要');
    return `提交到 GitHub · ${parts.length ? parts.join(' + ') : `仅 ${EVENT_META[event].label}`} →`;
  })();

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
          </div>
          {findings.length > 0 && (
            <div className="c-sub">
              勾选要提交的 findings,剔除无用项。有行锚点的作为 inline 行评论,无锚点的归入 review 摘要。
            </div>
          )}

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

          {findings.length === 0 && (
            <div className="c-empty">
              没有 finding —— 仍可只提交一次表态:填写 Review 意见后 Comment / Request changes,或直接 Approve。
            </div>
          )}

          {findings.map((f) => {
            const isSubmitted = f.submission === 'submitted';
            const isDismissed = f.triage === 'dismiss';
            // GitHub 422 不告知是哪条锚点失效 → 本地据最新 diff 预判并逐条标红。
            const isStale = staleIds.has(f.id);
            const canReAnchor = isStale && nearestLiveLine(f.file, f.line, diff) != null;
            const cls =
              'finding' +
              (isSubmitted ? ' locked' : isDismissed ? ' dismissed' : ' kept') +
              (isStale ? ' risky' : '');
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
                      {f.origin === 'agent' ? 'agent' : '你 · ' + (f.origin === 'promoted' ? '由 discussion 提升' : '手动新增')}
                    </span>
                  </div>
                  {!isDismissed && f.body.trim() && (
                    <div className="f-body">{renderMarkdown(f.body)}</div>
                  )}
                  {!isDismissed && f.suggestion?.trim() && (
                    <div className="f-sugg">
                      <div className="f-sugg-lbl">
                        <span className="dia">◇</span> suggestion
                      </div>
                      <div className="f-sugg-diff">
                        {(() => {
                          const orig = originalLineOf(f);
                          return orig != null ? (
                            <div className="fsd-row del">
                              <span className="fsd-gut">−</span>
                              <span className="fsd-code">{orig || ' '}</span>
                            </div>
                          ) : null;
                        })()}
                        {f.suggestion.split('\n').map((l, i) => (
                          <div className="fsd-row add" key={i}>
                            <span className="fsd-gut">＋</span>
                            <span className="fsd-code">{l || ' '}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {isSubmitted && (
                    <div className="f-status done">
                      已提交{f.submittedUrl ? '' : ''} · inline {f.file}:{f.line}
                    </div>
                  )}
                  {isStale && !isDismissed && !isSubmitted && (
                    <div className={'f-invalid' + (sub === 'invalid' ? ' escalated' : '')}>
                      <b>⛔ 行锚点失效</b> —— <code>{f.file}:{f.line}</code>{' '}
                      不在最新 diff 的新增侧(base 已更新,原行已移位)。作为 inline 评论会让整份 review 被 422 拒。
                      <div className="fix">
                        <span onClick={() => degradeToSummary(f)}>降级为摘要评论</span>
                        {canReAnchor && (
                          <span onClick={() => reAnchor(f)}>
                            改锚点到最近改动行(:{nearestLiveLine(f.file, f.line, diff)})
                          </span>
                        )}
                        <span onClick={() => toggleKeep(f)}>剔除此条</span>
                      </div>
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
          </div>

          {sub === 'success' && result?.status === 'success' && (
            <div className="sub-banner ok">
              <span className="bi">✓</span>
              <div className="bt">
                <b>review 已提交</b> ·{' '}
                {result.submittedCount > 0 ? `${result.submittedCount} 行评论 + 摘要` : EVENT_META[event].label} ·{' '}
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
                <b>提交被 GitHub 拒绝(422)</b> ——{' '}
                {staleIds.size > 0
                  ? `已在左侧定位 ${staleIds.size} 条失效锚点(红框),逐条处理(改锚点 / 降级为摘要 / 剔除)后整份重提。`
                  : `${result.message} PR review 是原子提交,须先处理失效锚点再整份重提。`}
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
            <div className="field-lbl">Review 意见</div>
            <textarea
              className="summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={saveSummary}
              placeholder="可选"
              rows={5}
            />

            <div className="field-lbl mt">提交类型</div>
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
                  disabled={blocked !== null}
                >
                  {sub === 'failed' ? '↻ 重试提交' : blocked ? '需要填写 Review 意见' : btnLabel}
                </button>
                {!blocked && (sub === 'invalid' || staleIds.size > 0) && (
                  <div className="foot-note">
                    {sub === 'invalid'
                      ? '修正红框那条后再整份提交'
                      : `⛔ ${staleIds.size} 条锚点已失效(红框),提交会被 422 拒 —— 建议先处理`}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
