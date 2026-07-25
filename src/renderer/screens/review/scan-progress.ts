/**
 * 机审进度的阶段派生(纯函数)—— 常驻横条与其展开的竖排时间线共用同一份,
 * 避免两处对"跑到哪一步"的判断漂移。
 *
 * 阶段态只由现有信号派生(diff 预取 / 会话就绪 / findings 数),不臆造后端没有的粒度。
 */
export type ScanStepState = 'done' | 'active' | 'pending' | 'failed';

export interface ScanStep {
  label: string;
  /** 横条上的短标签;竖排展开用完整 label */
  short: string;
  state: ScanStepState;
  meta?: string;
}

export interface ScanSignals {
  findingCount: number;
  /** diff 已预取落库(渲染期通常已就绪) */
  diffReady: boolean;
  /** codex 会话已起、turn 在跑(有 token 用量 / 工具调用 / 已产出 finding) */
  sessionReady: boolean;
  /** 本轮已失败;停在断点那一步,而不是把进度抹掉 —— "断在哪"本身就是诊断信息 */
  failed?: boolean;
}

export function deriveScanSteps({ findingCount, diffReady, sessionReady, failed }: ScanSignals): ScanStep[] {
  const steps: ScanStep[] = [
    { label: '拉取 diff 与源码树', short: '拉取 diff', state: diffReady ? 'done' : 'active' },
    {
      label: '注入 per-thread MCP · 建立会话',
      short: '建立会话',
      state: sessionReady ? 'done' : diffReady ? 'active' : 'pending',
    },
    {
      label: '通读改动,上报 findings',
      short: '通读改动',
      state: sessionReady ? 'active' : 'pending',
      meta: `${findingCount} findings`,
    },
    { label: '就绪 · 可自由追问 / 框选提问', short: '就绪', state: 'pending' },
  ];
  if (!failed) return steps;
  const broke = steps.findIndex((s) => s.state === 'active');
  // 已跑到"就绪"前一步却还是失败(如自检轮挂了):把最后一步标失败,不能整条都显示未开始
  const at = broke < 0 ? steps.length - 1 : broke;
  return steps.map((s, i) => (i === at ? { ...s, state: 'failed' } : s));
}

/** 当前正在进行(或断在)的阶段标签(给紧凑视图用);全部完成则回落到最后一步。 */
export function activeScanStepLabel(steps: ScanStep[]): string {
  const active = steps.find((s) => s.state === 'active' || s.state === 'failed');
  return (active ?? steps[steps.length - 1]).label;
}
