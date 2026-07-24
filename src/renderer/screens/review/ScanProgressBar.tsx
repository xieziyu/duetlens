import { Fragment, useState } from 'react';
import { deriveScanSteps, activeScanStepLabel, type ScanStep } from './scan-progress';


export interface ScanProgressBarProps {
  findingCount: number;
  diffReady: boolean;
  sessionReady: boolean;
  /** 复审轮次;首轮为 1 */
  currentRound: number;
  model: string | null;
}

/**
 * 机审进度条:横跨三栏置于主体之上,扫描期间无论停在哪一栏 / 哪个 tab 都能感知进度。
 * 横版是简况(横排 stepper + 当前阶段 + 实时 findings 计数);点开就地向下展开同一份
 * 阶段的竖排时间线,不劫持右栏 tab —— 时间线是全局运行态,不属于 Findings。
 */
export function ScanProgressBar({
  findingCount,
  diffReady,
  sessionReady,
  currentRound,
  model,
}: ScanProgressBarProps) {
  const [open, setOpen] = useState(false);
  const steps = deriveScanSteps({ findingCount, diffReady, sessionReady });
  const roundLabel = currentRound > 1 ? `第 ${currentRound} 轮机审` : '首轮机审';

  return (
    <div className={`scanbar${open ? ' open' : ''}`}>
      <button
        className="sb-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起时间线' : `展开完整时间线 · 当前:${activeScanStepLabel(steps)}`}
      >
        <span className="sb-glyph" />
        <span className="sb-round">{roundLabel}</span>
        <Stepper steps={steps} />
        {findingCount > 0 && <span className="sb-cnt">＋{findingCount} findings</span>}
        <span className="sb-model mono">{model ? `codex · ${model}` : 'codex'}</span>
        <span className="sb-chev">{open ? '▴' : '▾'}</span>
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
          <p className="sb-hint">
            <span className="ic">◆</span> 扫描会跑一会儿 —— 期间可点开任一 finding,或在左侧框选代码直接向
            agent 提问,无需等待机审结束。
          </p>
        </div>
      )}
    </div>
  );
}

/** 横排 stepper:短标签 + 连接段,与竖排时间线共用 done/active/pending 语义 */
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
