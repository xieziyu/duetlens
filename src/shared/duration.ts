// 时长与时间的展示格式化:入口卡片、历史列表、导出正文共用一份取整与单位规则。

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 拆成时/分/秒三段,格式化与相对时间共用同一套取整,避免两处各自四舍五入后对不上。 */
function splitParts(ms: number): { hours: number; minutes: number; seconds: number } {
  const totalSeconds = Math.round(ms / SECOND);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/** 渲染成 `1h 02m` / `3m 20s` / `12s` —— 只保留两级单位,更细的位数在列表里读不出信息。 */
export function formatDuration(ms: number): string {
  const { hours, minutes, seconds } = splitParts(ms);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** 两个时间戳之间的时长,给「开始/结束」成对存储的场景省一次减法。 */
export function formatSpan(startedAtMs: number, endedAtMs: number): string {
  return formatDuration(endedAtMs - startedAtMs);
}

/**
 * 列表里的「上次审核」列用的相对时间。粒度到天为止:再往上人只关心日期,
 * 由调用方自己渲染绝对日期,别在这里塞第二套日期格式。
 */
export function formatRelative(timestampMs: number, nowMs = Date.now()): string {
  const delta = nowMs - timestampMs;
  if (delta < MINUTE) return '刚刚';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  return `${Math.floor(delta / DAY)} 天前`;
}

export const DURATION_UNITS = { SECOND, MINUTE, HOUR, DAY } as const;
