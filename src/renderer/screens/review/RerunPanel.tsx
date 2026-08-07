import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { ReviewStartStage } from '@shared/ipc';
import { imeComposing } from '../../keys';
import { LensScanArt, LENS_ART_ROWS } from '../../components/LensScanArt';
import { StartSteps, newStartId, stepIndex, type StartStep } from '../../components/StartProgress';
import { LaunchError } from './LaunchError';

/**
 * 重跑确认面板:开跑前把「这一轮会带上什么」摊开讲清楚,再让用户加一句本轮说明。
 *
 * 这里只统计本地已有的数据(findings / 轮次)。最新 diff 与 PR 评论是开跑那一刻才拉的 ——
 * 提前拉一次既慢又会与真正开跑时的结果不一致,所以文案只说明"将拉取",不给假数字。
 *
 * 开跑后原地转等待画面:大 PR 光是拉 diff、读 PR 评论就要十几秒,期间面板不可关闭;
 * 失败则退回表单并就地报错,已填的说明与强度原样留着。
 */

/** 重跑的阶段表(与后端 launchRound 的 onStage 一一对应)。 */
function rerunSteps(isGithub: boolean): StartStep[] {
  return [
    {
      stage: 'resolve',
      label: '收束上一轮会话 · 读取最新元信息',
      slow: '正在释放上一轮的 codex 会话并解析最新 HEAD',
    },
    {
      stage: 'diff',
      label: '拉取最新改动的 diff',
      slow: '改动量大时 diff 要下载十几秒,这是正常的',
    },
    {
      stage: 'record',
      label: isGithub ? '比对变更 · 汇总上轮结论与 PR 评论' : '比对变更 · 汇总上轮结论',
      slow: isGithub ? '正在读取 PR 描述、评论与 thread 状态' : '正在比对与上一轮之间的改动',
    },
    {
      stage: 'agent',
      label: '装配审核规则 · 开新的 agent 会话',
      slow: '正在拉起 codex 会话',
    },
  ];
}

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
  onRun: (input: { note: string; intensity: ReviewIntensity; startId: string }) => Promise<void>;
}): React.JSX.Element {
  const reviewIntensity = review?.intensity ?? 'standard';
  const [note, setNote] = useState('');
  const [intensity, setIntensity] = useState<ReviewIntensity>(reviewIntensity);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<ReviewStartStage>('resolve');
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // 阶段推进只认当前这次开跑的 id,失败重来后旧的一路事件不会再往面板里灌
  const startIdRef = useRef<string | null>(null);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  useEffect(
    () =>
      window.duetlens.review.onStartProgress((p) => {
        if (p.startId === startIdRef.current) setStage(p.stage);
      }),
    [],
  );

  const open = findings.filter((f) => f.triage !== 'dismiss');
  // 复核已修复而自动结案的单列一档:它跟「你判定这不是问题」不是一回事,抑制口径也不同
  const closedFixed = findings.filter(isAutoClosedFixed);
  const dismissed = findings.filter((f) => f.triage === 'dismiss' && !isAutoClosedFixed(f));
  const withReason = dismissed.filter((f) => f.dismissReason?.trim()).length;
  const submitted = open.filter((f) => f.submission === 'submitted').length;
  const nextRound = (review?.currentRound ?? 1) + 1;
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  const isGithub = review?.source === 'github-pr';

  const steps = useMemo(() => rerunSteps(isGithub), [isGithub]);

  const run = async () => {
    const startId = newStartId();
    startIdRef.current = startId;
    setRunning(true);
    setStage('resolve');
    setError(null);
    try {
      await onRun({ note: note.trim(), intensity, startId });
      onClose();
    } catch (e) {
      startIdRef.current = null;
      setError((e as Error).message);
      setRunning(false);
    }
  };

  return (
    <div className="rerun-scrim" onClick={() => !running && onClose()} role="presentation">
      <div
        className="rerun-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (imeComposing(e)) return;
          // 开跑后没有可取消的动作:Esc 与 ⌘↵ 都吞掉,别让人半路把等待画面关了
          if (running) return;
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
        }}
        role="dialog"
        aria-busy={running}
        aria-label={`发起第 ${nextRound} 轮复审`}
      >
        <header className="rp-head">
          <span className="rp-round">第 {nextRound} 轮</span>
          <h2>再跑一轮机审</h2>
          {last?.endedAt && <span className="rp-since">上一轮 {relTime(last.endedAt)}</span>}
        </header>

        {running ? (
          <div className="rp-run">
            <LensScanArt
              className="rp-art"
              lit={Math.min(LENS_ART_ROWS, stepIndex(steps, stage) + 1)}
            />
            <StartSteps
              steps={steps}
              stage={stage}
              hint="启动后本轮机审在后台跑,不用守着这个面板"
            />
          </div>
        ) : (
          <>
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
            <button className="rp-cancel" onClick={onClose}>
              取消
            </button>
            <button className="rp-go" onClick={() => void run()}>
              ↻ 开始第 {nextRound} 轮
            </button>
          </footer>
          </>
        )}
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
