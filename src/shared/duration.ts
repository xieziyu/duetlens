// 时长与时间的展示格式化:入口卡片、历史列表、导出正文共用一份取整与单位规则。

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** 渲染成 `1h 02m` / `3m 20s` / `12s` —— 只保留两级单位,更细的位数在列表里读不出信息。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** 两个时间戳之间的时长,给「开始/结束」成对存储的场景省一次减法。 */
export function formatSpan(startedAtMs: number, endedAtMs: number): string {
  return formatDuration(endedAtMs - startedAtMs);
}

export const DURATION_UNITS = { SECOND, MINUTE, HOUR } as const;
