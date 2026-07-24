import { deriveScanSteps, activeScanStepLabel, type ScanStep } from './scan-progress';

export interface ScanProgressHeaderProps {
  findingCount: number;
  diffReady: boolean;
  sessionReady: boolean;
  /** 复审轮次;首轮为 1 */
  currentRound: number;
  model: string | null;
  /** 点击展开完整时间线(切到 Findings tab)。 */
  onExpand: () => void;
}

/**
 * 常驻机审进度头:置于右栏 tabs 之上,扫描期间在 Findings 以外的 tab 也能感知进度。
 * 是完整时间线(ScanTimeline)的紧凑摘要 —— mini stepper + 当前阶段 + 实时 findings 计数;
 * 点击展开回 Findings 看完整时间线与实时 findings 流。
 */
export function ScanProgressHeader({
  findingCount,
  diffReady,
  sessionReady,
  currentRound,
  model,
  onExpand,
}: ScanProgressHeaderProps) {
  const steps = deriveScanSteps({ findingCount, diffReady, sessionReady });
  const roundLabel = currentRound > 1 ? `第 ${currentRound} 轮机审` : '首轮机审';
  const sub = model ? `codex · ${model}` : 'codex';

  return (
    <button className="scan-head-bar" onClick={onExpand} title="展开完整时间线与实时 findings">
      <span className="shb-glyph" />
      <span className="shb-txt">
        <span className="shb-l">
          {roundLabel} · {activeScanStepLabel(steps)}
          {findingCount > 0 && <span className="shb-cnt">＋{findingCount}</span>}
        </span>
        <span className="shb-s">{sub}</span>
      </span>
      <MiniStepper steps={steps} />
      <span className="shb-chev">▸</span>
    </button>
  );
}

function MiniStepper({ steps }: { steps: ScanStep[] }) {
  return (
    <span className="mstep" aria-hidden>
      {steps.map((s, i) => (
        <span key={i} className="mstep-cell">
          <span className={`mstep-n ${s.state}`} />
          {i < steps.length - 1 && <span className={`mstep-bar ${s.state === 'done' ? 'done' : ''}`} />}
        </span>
      ))}
    </span>
  );
}
