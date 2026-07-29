import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  findingAnchorText,
  findingNarrative,
  findingSuggestion,
  type Finding,
  type Review,
} from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { SubmitReviewResult } from '@shared/ipc';
import {
  GH_REVIEW_EVENTS,
  buildPrReviewPayload,
  hasAnchor,
  isStaleAnchor,
  isSubmittable,
  needsRecheckFollowUp,
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

/**
 * 锚点判定所依据的 diff 有多新。审核时的 diff 快照可能已落后于 GitHub —— 那正是 422 的成因,
 * 此时按快照预判会「一条失效锚点都找不到」,用户无从下手。故要能现拉最新 diff 重判。
 */
type Freshness =
  | { state: 'snapshot' }
  | { state: 'checking' }
  | { state: 'synced'; headMoved: boolean; headSha: string | null }
  | { state: 'error'; message: string };

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

interface Props {
  review: Review;
  findings: Finding[];
  onBack: () => void;
  /** 终点切换分段(github-pr 有导出这个并列终点);给了就顶掉面包屑。 */
  tabs?: ReactNode;
  /** 提交在途时上报,好让外壳一并冻住屏外那些能改 triage 的入口。 */
  onBusyChange?: (busy: boolean) => void;
}

// 左 findings 筛选 + 右 Finish your review。
export function SubmitGitHubScreen({ review, findings, onBack, tabs, onBusyChange }: Props) {
  const reviewId = review.id;
  const [event, setEvent] = useState<GhReviewEvent>('comment');
  /** 实际发出去的那次表态;结果 banner 只能说这一个,否则事后改选框会让它改口。 */
  const [sentEvent, setSentEvent] = useState<GhReviewEvent | null>(null);
  const [sub, setSub] = useState<SubState>('ready');
  const [result, setResult] = useState<SubmitReviewResult | null>(null);
  // reviewer 手填的 review 意见:只属于这一次提交,不落库、也不取 agent 的总结
  const [body, setBody] = useState('');
  const [diff, setDiff] = useState<DiffFile[]>([]);
  const [fresh, setFresh] = useState<Freshness>({ state: 'snapshot' });
  /** 上次被 422 拒后、按最新 diff 定位到的失效锚点条数(null=尚未定位/拉取失败)。 */
  const [rejectStale, setRejectStale] = useState<number | null>(null);

  // 先用审核时的 diff 快照即时预判哪条行锚点已失效(GitHub 422 不告知是哪条)
  useEffect(() => {
    void window.duetlens.review.diff(reviewId).then(setDiff);
  }, [reviewId]);

  /** 现拉 PR 最新 diff 并据此重判锚点;返回最新 diff(拉取失败返回 null)。 */
  const syncLatest = useCallback(async () => {
    setFresh({ state: 'checking' });
    const res = await window.duetlens.review.latestDiff(reviewId);
    if (!res.ok) {
      setFresh({ state: 'error', message: res.message });
      return null;
    }
    setDiff(res.diff);
    setFresh({ state: 'synced', headMoved: res.headMoved, headSha: res.headSha });
    return res.diff;
  }, [reviewId]);

  const round = review.currentRound;
  const pending = useMemo(() => findings.filter((f) => isSubmittable(f, round)), [findings, round]);
  const submitted = useMemo(() => findings.filter((f) => f.submission === 'submitted'), [findings]);
  // 已提交但本轮复核仍存在 → 本次会就同一处追发一条带复核说明的评论
  const followUps = useMemo(
    () => findings.filter((f) => f.triage !== 'dismiss' && needsRecheckFollowUp(f, round)),
    [findings, round],
  );
  const dismissed = useMemo(() => findings.filter((f) => f.triage === 'dismiss'), [findings]);
  const staleIds = useMemo(
    () => new Set(findings.filter((f) => isStaleAnchor(f, diff, round)).map((f) => f.id)),
    [findings, diff, round],
  );
  const inlineCount = pending.filter(hasAnchor).length;
  // 降级 / 无锚点的条目走 review body 的「整体意见」,与草稿正文一起构成摘要
  const summaryCount = pending.filter((f) => !hasAnchor(f)).length;
  const keptCount = findings.filter((f) => f.triage !== 'dismiss').length;
  const staleList = useMemo(() => findings.filter((f) => staleIds.has(f.id)), [findings, staleIds]);
  const reAnchorableCount = staleList.filter((f) => nearestLiveLine(f.file, f.line, diff) != null).length;

  // 派生上报而非在 submit() 里逐条路径手动置位:那样每加一条 return 就漏一次解冻
  useEffect(() => onBusyChange?.(sub === 'submitting'), [sub, onBusyChange]);

  // 进屏即在后台核对一次 PR 最新状态:失效锚点应在提交被拒之前就摆到用户面前。
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (checkedOnce.current || inlineCount === 0) return;
    checkedOnce.current = true;
    void syncLatest();
  }, [inlineCount, syncLatest]);

  // suggestion diff 的「原行」文本:按 file+新侧行号从最新 diff 取,取不到则只渲染增行。
  const originalLineOf = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const file of diff)
      for (const hunk of file.hunks)
        for (const l of hunk.lines) if (l.newLine != null) byKey.set(`${file.path}:${l.newLine}`, l.text);
    return (f: Finding) => byKey.get(`${f.file}:${f.line}`);
  }, [diff]);

  /**
   * 提交在途:后端已按调用那一刻的 findings / event / body 组好 payload 并在发了,
   * 此后任何改动都进不了这一份,只会让屏上的锚点、正文、表态与 GitHub 上的实际结果对不上。
   * 三个写锚点的原语与 triage 一起在此拦掉,批量入口走它们、无需各自再挡一遍。
   */
  const busy = sub === 'submitting';

  const degradeToSummary = (f: Finding) => {
    if (busy) return;
    void window.duetlens.review.setFindingAnchor(reviewId, f.id, 0);
  };
  /** 撤销降级:行号在降级时留着没清,原样传回即恢复为行评论。 */
  const restoreAnchor = (f: Finding) => {
    if (busy || f.line <= 0) return;
    void window.duetlens.review.setFindingAnchor(reviewId, f.id, f.line);
  };
  const reAnchor = (f: Finding) => {
    if (busy) return;
    const line = nearestLiveLine(f.file, f.line, diff);
    if (line != null) void window.duetlens.review.setFindingAnchor(reviewId, f.id, line);
  };
  const reAnchorAll = () => staleList.forEach(reAnchor);
  const degradeAllStale = () => staleList.forEach(degradeToSummary);
  /** 兜底:把待提交的行评论全部并入摘要 —— 没有 inline 锚点的 review 不可能再被 422 拒。 */
  const degradeAllInline = () => pending.filter(hasAnchor).forEach(degradeToSummary);

  const toggleKeep = (f: Finding) => {
    if (busy) return;
    // 已提交即锁定;唯一例外是欠一条复核追评的,用户仍可决定这条追评发不发
    if (f.submission === 'submitted' && !needsRecheckFollowUp(f, round)) return;
    void window.duetlens.review.setTriage(reviewId, f.id, f.triage === 'dismiss' ? 'open' : 'dismiss');
  };

  // 按钮可用性走后端同一套判定(手填正文一并传进去,与实际提交内容一致)
  const blocked = useMemo(
    () => submitBlocker(buildPrReviewPayload(review, pending, event, body)),
    [review, pending, event, body],
  );

  const submit = async () => {
    if (blocked || busy) return;
    setSub('submitting');
    setSentEvent(event);
    const res = await window.duetlens.review.submit(reviewId, { event, body });
    setResult(res);
    setSub(res.status);
    // 被 422 拒说明本地依据的 diff 已过期 —— 现拉最新的重判,把「是哪条」指出来。
    if (res.status !== 'invalid') return;
    const latest = await syncLatest();
    // 记下拒稿当下定位到几条:后续用户处理完 staleIds 会归零,banner 不能因此改口说「没定位到」。
    setRejectStale(latest ? findings.filter((f) => isStaleAnchor(f, latest, round)).length : null);
  };

  // 锚点判定依据了哪份 diff、结论如何 —— 用户据此知道红框可不可信。
  const freshNote = (() => {
    if (fresh.state === 'checking') return { ic: '⟳', txt: '正在核对 PR 最新状态…' };
    if (fresh.state === 'snapshot') return { ic: '·', txt: '行锚点按审核时的 diff 快照预判。' };
    if (fresh.state === 'error')
      return {
        ic: '⚠',
        txt: `未能读取 PR 最新状态(${fresh.message}) —— 锚点仍按审核时的 diff 快照预判,可能不准。`,
      };
    const head = fresh.headSha ? ` · head ${shortSha(fresh.headSha)}` : '';
    if (staleIds.size > 0)
      return {
        ic: '⛔',
        txt: `${fresh.headMoved ? '审核后 PR 又有新提交' : '已核对 PR 最新状态'}${head} —— ${staleIds.size} 条行锚点不在最新改动上(红框),照此提交会被 422 整份拒。`,
      };
    return { ic: '✓', txt: `已核对 PR 最新状态${head} · ${inlineCount} 条行锚点均有效。` };
  })();

  const btnLabel = (() => {
    const parts: string[] = [];
    if (inlineCount > 0) parts.push(`${inlineCount} 行评论`);
    if (summaryCount > 0) parts.push(`摘要(含 ${summaryCount} 条)`);
    else if (body.trim()) parts.push('摘要');
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
        {tabs ?? (
          <span className="crumb">
            Review · <b>提交 findings</b>
          </span>
        )}
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
            <div className="incbar">
              ↻ 上次已提交 {submitted.length} 条 · 已锁定,不重发
              {followUps.length > 0 && (
                <b>；其中 {followUps.length} 条本轮复核仍存在,将就同一处追发一条复核说明</b>
              )}
            </div>
          )}

          {inlineCount > 0 && (
            <div
              className={
                'freshbar' +
                (staleIds.size > 0 ? ' bad' : fresh.state === 'error' ? ' warn' : '') +
                (fresh.state === 'checking' ? ' busy' : '')
              }
            >
              <div className="fb-line">
                <span className="fb-ic">{freshNote.ic}</span>
                <span className="fb-txt">{freshNote.txt}</span>
                <button
                  className="fb-act"
                  onClick={() => void syncLatest()}
                  disabled={fresh.state === 'checking'}
                >
                  ↻ 重新拉取
                </button>
              </div>
              {staleIds.size > 0 && fresh.state !== 'checking' && (
                <div className="fb-fix">
                  {reAnchorableCount > 0 && (
                    <span onClick={reAnchorAll}>全部改锚到最近改动行({reAnchorableCount})</span>
                  )}
                  <span onClick={degradeAllStale}>全部降级为摘要评论({staleIds.size})</span>
                </div>
              )}
            </div>
          )}

          {findings.length === 0 && (
            <div className="c-empty">
              没有 finding —— 仍可只提交一次表态:填写 Review 意见后 Comment / Request changes,或直接 Approve。
            </div>
          )}

          {findings.map((f) => {
            const isSubmitted = f.submission === 'submitted';
            const isDismissed = f.triage === 'dismiss';
            // 已提交但本轮复核仍存在 → 不按锁定态处理,本次要就同一处追发一条复核评论
            const canFollowUp = needsRecheckFollowUp(f, round);
            const locked = isSubmitted && !canFollowUp;
            // GitHub 422 不告知是哪条锚点失效 → 本地据最新 diff 预判并逐条标红。
            const isStale = staleIds.has(f.id);
            // 卡片按实际提交的内容预览:有本轮复核说明就只发它,首轮 suggestion 随首轮正文一起作废
            const narrative = findingNarrative(f, round);
            const suggestion = findingSuggestion(f, round);
            const canReAnchor = isStale && nearestLiveLine(f.file, f.line, diff) != null;
            const cls =
              // 前缀不能省:裸 .finding 会漏到审核屏的内联卡与批注 composer(它们也带 .finding)
              'sub-fnd' +
              (locked ? ' locked' : isDismissed ? ' dismissed' : ' kept') +
              (isStale ? ' risky' : '');
            return (
              <div key={f.id} className={cls}>
                <span
                  className={'chk' + (!isDismissed ? ' on' : '')}
                  onClick={() => toggleKeep(f)}
                  title={locked ? '已提交锁定' : isDismissed ? '恢复' : '剔除'}
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
                      📍 <b>{f.file}</b>
                      {f.line > 0 ? `:${f.line}` : ''}
                    </span>
                    {f.anchorDropped && !isDismissed && (
                      <span className="f-degraded">
                        并入摘要
                        {!locked && f.line > 0 && (
                          <button onClick={() => restoreAnchor(f)}>改回行评论</button>
                        )}
                      </span>
                    )}
                    <span className={'origin' + (f.origin === 'agent' ? ' agent' : ' human')}>
                      <span className="d" />
                      {f.origin === 'agent' ? 'agent' : '你 · ' + (f.origin === 'promoted' ? '由 discussion 提升' : '手动新增')}
                    </span>
                  </div>
                  {!isDismissed && narrative && <div className="f-body">{renderMarkdown(narrative)}</div>}
                  {!isDismissed && suggestion && (
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
                        {suggestion.split('\n').map((l, i) => (
                          <div className="fsd-row add" key={i}>
                            <span className="fsd-gut">＋</span>
                            <span className="fsd-code">{l || ' '}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {isSubmitted && (
                    <div className={'f-status ' + (canFollowUp ? 'followup' : 'done')}>
                      {(canFollowUp
                        ? '↻ 上一轮已提交 · 本轮复核仍存在,将追发一条复核评论 · '
                        : '已提交 · ') +
                        (hasAnchor(f) ? 'inline ' : '摘要内 ') +
                        findingAnchorText(f)}
                    </div>
                  )}
                  {isStale && !isDismissed && !locked && (
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
                {isDismissed && !locked && (
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
                {result.submittedCount > 0
                  ? `${result.submittedCount} 行评论 + 摘要`
                  : EVENT_META[sentEvent ?? event].label}{' '}
                ·{' '}
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
                {fresh.state === 'checking' ? (
                  '正在重新拉取 PR 最新状态,定位是哪条行锚点失效…'
                ) : rejectStale === null ? (
                  `无法读取 PR 最新状态${fresh.state === 'error' ? `(${fresh.message})` : ''}。请确认 gh 已登录、PR 未关闭,再 ↻ 重新拉取以定位失效锚点。`
                ) : rejectStale === 0 ? (
                  '已按 PR 最新状态重判,但本地未能定位到失效锚点 —— 评论可能落在 diff 之外的文件或行上。把行评论并入摘要即可安全重提。'
                ) : (
                  `已按 PR 最新状态定位到 ${rejectStale} 条失效锚点(左侧红框)${fresh.state === 'synced' && fresh.headMoved ? ',审核后 PR 又有新提交' : ''}。` +
                  (staleIds.size > 0
                    ? `尚余 ${staleIds.size} 条待处理(改锚点 / 降级为摘要 / 剔除),处理完整份重提。`
                    : '已全部处理,可整份重提。')
                )}
                {/* 定位不到是哪条(拉取失败 / 锚在 diff 之外)时给出必定可提交的退路 */}
                {fresh.state !== 'checking' && !rejectStale && inlineCount > 0 && (
                  <div className="bfix">
                    <span onClick={degradeAllInline}>把 {inlineCount} 条行评论全部降级为摘要</span>
                    <span onClick={() => void syncLatest()}>↻ 重新拉取 PR 状态</span>
                  </div>
                )}
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
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="可选 · 你写给作者的话(agent 的总结不会发出去)"
              rows={5}
              disabled={busy}
            />

            <div className="field-lbl mt">提交类型</div>
            {/* 正文与表态同样已随 payload 发出:在途改它们只会让屏上写的与 GitHub 上的对不上 */}
            <div className={'events' + (busy ? ' frozen' : '')}>
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
                  className={'submit' + (sub === 'failed' || sub === 'invalid' ? ' retry' : '')}
                  onClick={submit}
                  disabled={blocked !== null}
                >
                  {sub === 'failed'
                    ? '↻ 重试提交'
                    : blocked
                      ? '需要填写 Review 意见'
                      : sub === 'invalid'
                        ? `↻ 重新${btnLabel}`
                        : btnLabel}
                </button>
                {!blocked && (sub === 'invalid' || staleIds.size > 0) && (
                  /* 失效锚点会让整份 review 被拒,是阻断条件而非脚注 —— 单独标记以拿到警示样式 */
                  <div className={'foot-note' + (staleIds.size > 0 ? ' blocking' : '')}>
                    {staleIds.size > 0
                      ? `⛔ ${staleIds.size} 条锚点不在最新改动上,整份会被 422 拒 —— 先处理红框`
                      : fresh.state === 'synced'
                        ? '✓ 按 PR 最新状态已无失效锚点,可整份重提'
                        : '处理失效锚点后可整份重提'}
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
