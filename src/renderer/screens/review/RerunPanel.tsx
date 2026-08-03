import { useEffect, useRef, useState } from 'react';
import {
  INTENSITY_HINTS,
  INTENSITY_LABELS,
  REVIEW_INTENSITIES,
  isAutoClosedFixed,
  type Finding,
  type Review,
  type ReviewIntensity,
  type ReviewRound,
} from '@shared/domain';
import { imeComposing } from '../../keys';
import { LaunchError } from './LaunchError';

/**
 * 重跑确认面板:开跑前把「这一轮会带上什么」摊开讲清楚,再让用户加一句本轮说明。
 *
 * 这里只统计本地已有的数据(findings / 轮次)。最新 diff 与 PR 评论是开跑那一刻才拉的 ——
 * 提前拉一次既慢又会与真正开跑时的结果不一致,所以文案只说明"将拉取",不给假数字。
 */
export function RerunPanel({
  review,
  findings,
  rounds,
  onClose,
  onRun,
}: {
  review: Review | null;
  findings: Finding[];
  rounds: ReviewRound[];
  onClose: () => void;
  onRun: (input: { note: string; intensity: ReviewIntensity }) => Promise<void>;
}): React.JSX.Element {
  const reviewIntensity = review?.intensity ?? 'standard';
  const [note, setNote] = useState('');
  const [intensity, setIntensity] = useState<ReviewIntensity>(reviewIntensity);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const open = findings.filter((f) => f.triage !== 'dismiss');
  // 复核已修复而自动结案的单列一档:它跟「你判定这不是问题」不是一回事,抑制口径也不同
  const closedFixed = findings.filter(isAutoClosedFixed);
  const dismissed = findings.filter((f) => f.triage === 'dismiss' && !isAutoClosedFixed(f));
  const withReason = dismissed.filter((f) => f.dismissReason?.trim()).length;
  const submitted = open.filter((f) => f.submission === 'submitted').length;
  const nextRound = (review?.currentRound ?? 1) + 1;
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  const isGithub = review?.source === 'github-pr';

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await onRun({ note: note.trim(), intensity });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  };

  return (
    <div className="rerun-scrim" onClick={onClose} role="presentation">
      <div
        className="rerun-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (imeComposing(e)) return;
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) void run();
        }}
        role="dialog"
        aria-label={`发起第 ${nextRound} 轮复审`}
      >
        <header className="rp-head">
          <span className="rp-round">第 {nextRound} 轮</span>
          <h2>再跑一轮机审</h2>
          {last?.endedAt && <span className="rp-since">上一轮 {relTime(last.endedAt)}</span>}
        </header>

        <p className="rp-lede">
          会重新拉取最新改动做<b>全量重审</b>,并开一个干净的 codex 会话 —— 上一轮的结论与你的处置由下列上下文带过去。
        </p>

        <ul className="rp-ctx">
          <li>
            <span className="rp-n">{open.length}</span>
            <span className="rp-l">
              条保留中的 finding <em>逐条要求 agent 判定「已修复 / 仍存在」</em>
              {submitted > 0 && <span className="rp-sub">其中 {submitted} 条已提交到 GitHub</span>}
            </span>
          </li>
          <li>
            <span className="rp-n">{dismissed.length}</span>
            <span className="rp-l">
              条你已剔除的 finding <em>本轮不会再被报出,同类问题也会被抑制</em>
              {dismissed.length > 0 && (
                <span className="rp-sub">
                  {withReason > 0 ? `${withReason} 条附了剔除理由` : '未填理由 — 填了理由抑制会更准'}
                </span>
              )}
            </span>
          </li>
          {closedFixed.length > 0 && (
            <li>
              <span className="rp-n">{closedFixed.length}</span>
              <span className="rp-l">
                条已确认修复、自动结案的 finding <em>不再要求表态</em>
                <span className="rp-sub">若同一个问题回归,会作为新 finding 重新报出</span>
              </span>
            </li>
          )}
          <li>
            <span className="rp-n rp-glyph">↻</span>
            <span className="rp-l">
              最新 diff <em>开跑时拉取,并标出自上一轮以来变动的文件</em>
            </span>
          </li>
          {isGithub && (
            <li>
              <span className="rp-n rp-glyph">◇</span>
              <span className="rp-l">
                PR 上的评论 <em>作者回复、thread 是否 resolved、PR 描述与其他 reviewer 意见</em>
                <span className="rp-sub">作为外部参考材料注入,不作为指令</span>
              </span>
            </li>
          )}
        </ul>

        <div className="rp-int">
          <div className="rp-int-top">
            <span className="rp-int-lbl">本轮强度</span>
            <div className="rp-int-seg">
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
            {intensity !== reviewIntensity && (
              <span className="rp-int-chg">较上轮由「{INTENSITY_LABELS[reviewIntensity]}」调整</span>
            )}
          </div>
          <p className="rp-int-hint">{INTENSITY_HINTS[intensity]}</p>
        </div>

        <label className="rp-note">
          <span>本轮额外说明(可选)</span>
          <textarea
            ref={noteRef}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例:作者说已经修了并发那条,重点复核;顺便看看新加的重试逻辑。"
          />
        </label>

        {error && (
          <div className="rp-error">
            <LaunchError message={error} />
          </div>
        )}

        <footer className="rp-foot">
          <span className="rp-hint mono">⌘↵ 开跑 · Esc 关闭</span>
          <button className="rp-cancel" onClick={onClose} disabled={running}>
            取消
          </button>
          <button className="rp-go" onClick={() => void run()} disabled={running}>
            {running ? '启动中…' : `↻ 开始第 ${nextRound} 轮`}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 粗粒度相对时间;轮次间隔通常以分钟/小时计,不必精确到秒。 */
function relTime(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
