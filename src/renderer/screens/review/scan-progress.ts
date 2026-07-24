/**
 * 机审进度的阶段派生(纯函数)—— 常驻进度头(ScanProgressHeader)与
 * 完整时间线(ScanTimeline)共用同一份,避免两处对"跑到哪一步"的判断漂移。
 *
 * 阶段态只由现有信号派生(diff 预取 / 会话就绪 / findings 数),不臆造后端没有的粒度。
 */
export type ScanStepState = 'done' | 'active' | 'pending';

export interface ScanStep {
  label: string;
  state: ScanStepState;
  meta?: string;
}

export interface ScanSignals {
  findingCount: number;
  /** diff 已预取落库(渲染期通常已就绪) */
  diffReady: boolean;
  /** codex 会话已起、turn 在跑(有 token 用量 / 工具调用 / 已产出 finding) */
  sessionReady: boolean;
}

export function deriveScanSteps({ findingCount, diffReady, sessionReady }: ScanSignals): ScanStep[] {
  return [
    { label: '拉取 diff 与源码树', state: diffReady ? 'done' : 'active' },
    {
      label: '注入 per-thread MCP · 建立会话',
      state: sessionReady ? 'done' : diffReady ? 'active' : 'pending',
    },
    {
      label: '通读改动,上报 findings',
      state: sessionReady ? 'active' : 'pending',
      meta: `${findingCount} findings`,
    },
    { label: '就绪 · 可自由追问 / 框选提问', state: 'pending' },
  ];
}

/** 当前正在进行的阶段标签(给紧凑视图用);全部完成则回落到最后一步。 */
export function activeScanStepLabel(steps: ScanStep[]): string {
  const active = steps.find((s) => s.state === 'active');
  return (active ?? steps[steps.length - 1]).label;
}
