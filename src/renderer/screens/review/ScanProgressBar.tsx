import { Fragment, useEffect, useState } from 'react';
import type { ReviewRound } from '@shared/domain';
import { deriveScanSteps, activeScanStepLabel, type ScanStep } from './scan-progress';
import { describeRoundError } from './round-error';
import { LaunchError } from './LaunchError';

export interface ScanProgressBarProps {
  findingCount: number;
  diffReady: boolean;
  sessionReady: boolean;
  /** 复审轮次;首轮为 1 */
  currentRound: number;
  /** 本轮失败时的轮次记录(含原因);跑得好好的为 null */
  failedRound: ReviewRound | null;
  /** agent 正在自行重试(codex 退避重试期);计数是我们数到的次数,非 codex 上报 */
  retrying: { count: number; error: string } | null;
  /** 重试本轮;抛错即由本条自行提示 */
  onRetry: () => Promise<void>;
  /** 状态栏「查看原因」的定位请求;递增即展开并闪一下。0 表示没请求过 */
  revealNonce: number;
}

/**
 * 机审进度条:横跨三栏置于主体之上,扫描期间无论停在哪一栏 / 哪个 tab 都能感知进度。
 * 横版是简况(横排 stepper + 当前阶段 + 实时 findings 计数);点开就地向下展开同一份
 * 阶段的竖排时间线,不劫持右栏 tab —— 时间线是全局运行态,不属于 Findings。
 *
 * 失败后本条**不卸载**:它是唯一横跨三栏、能承载"断在哪一步、为什么断"的位置。
 * 底部状态栏只放得下一枚状态字,把原因塞那儿等于没有原因。
 */
export function ScanProgressBar({
  findingCount,
  diffReady,
  sessionReady,
  currentRound,
  failedRound,
  retrying,
  onRetry,
  revealNonce,
}: ScanProgressBarProps) {
  const failed = failedRound !== null;
  const [open, setOpen] = useState(failed);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySending, setRetrySending] = useState(false);
  const [flash, setFlash] = useState(false);
  // 失败是必须被看见的:从跑动态翻进失败态时强制展开,别让原因藏在收起的横条里
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);
  // 从状态栏点进来:本条常驻顶部无需滚动,闪一下把视线引过来即可
  useEffect(() => {
    if (!revealNonce) return;
    setOpen(true);
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
  }, [revealNonce]);

  const steps = deriveScanSteps({ findingCount, diffReady, sessionReady, failed });
  const roundLabel = currentRound > 1 ? `第 ${currentRound} 轮机审` : '首轮机审';
  const copy = describeRoundError(failedRound?.errorKind ?? null);

  const retry = async () => {
    setRetrySending(true);
    setRetryError(null);
    try {
      await onRetry();
    } catch (e) {
      setRetryError((e as Error).message);
      setRetrySending(false);
    }
  };

  return (
    <div className={`scanbar${open ? ' open' : ''}${failed ? ' failed' : ''}${flash ? ' flash' : ''}`}>
      <button
        className="sb-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起时间线' : `展开完整时间线 · 当前:${activeScanStepLabel(steps)}`}
      >
        <span className="sb-glyph" />
        <span className="sb-round">
          {roundLabel}
          {failed && ' 失败'}
        </span>
        <Stepper steps={steps} />
        {retrying && (
          <span className="sb-retry" title={retrying.error}>
            连接中断,agent 重试中 · 第 {retrying.count} 次
          </span>
        )}
        {findingCount > 0 && <span className="sb-cnt">＋{findingCount} findings</span>}
        <span className="sb-chev" />
      </button>

      {open && (
        <div className="sb-detail">
          <div className="timeline">
            {steps.map((s, i) => (
              <div key={i} className={`tl ${s.state}`}>
                <span className="dot" />
                <span className="tl-l">{s.label}</span>
                {s.meta && <span className="tl-t">{s.meta}</span>}
              </div>
            ))}
          </div>
          {failedRound ? (
            <div className="sb-err">
              <div className="se-head">
                <span className="ic">✕</span>
                <b>{copy.title}</b>
              </div>
              {copy.advice && <p className="se-advice">{copy.advice}</p>}
              <p className="se-keep">
                本轮没有产出,此前各轮的 findings 与你的处置都还在 —— 重试沿用第 {failedRound.round}{' '}
                轮,不会多算一轮。
              </p>
              {failedRound.errorMessage && (
                <details className="se-raw">
                  <summary>agent 返回的原文</summary>
                  <pre>{failedRound.errorMessage}</pre>
                </details>
              )}
              {retryError && <LaunchError message={retryError} />}
              <div className="se-act">
                <button
                  className={copy.retryable ? 'primary' : ''}
                  onClick={() => void retry()}
                  disabled={retrySending}
                >
                  {retrySending ? '重试中…' : `↻ 重试第 ${failedRound.round} 轮`}
                </button>
              </div>
            </div>
          ) : (
            <p className="sb-hint">
              <span className="ic">◆</span> 扫描会跑一会儿 —— 期间可点开任一 finding,或在左侧框选代码直接向
              agent 提问,无需等待机审结束。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 横排 stepper:短标签 + 连接段,与竖排时间线共用 done/active/pending/failed 语义 */
function Stepper({ steps }: { steps: ScanStep[] }) {
  return (
    <span className="sb-steps">
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={`sb-seg${steps[i - 1].state === 'done' ? ' done' : ''}`} />}
          <span className={`sb-step ${s.state}`}>
            <i className="sb-dot" />
            <span className="sb-lbl">{s.short}</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}
