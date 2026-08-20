/**
 * 确定性验证时长/相对时间格式化的边界(不碰 codex、不开库)。
 * 断言单位跨越处的进位、两级单位截断,以及相对时间的档位切换。
 *   运行:npm run spike:duration
 */
import { strict as assert } from 'node:assert';
import { DURATION_UNITS, formatDuration, formatRelative, formatSpan } from '../src/shared/duration';

const log = (m: string) => process.stdout.write(`[duration] ${m}\n`);

const { SECOND, MINUTE, HOUR, DAY } = DURATION_UNITS;

assert.equal(formatDuration(12 * SECOND), '12s');
assert.equal(formatDuration(3 * MINUTE + 20 * SECOND), '3m 20s');
assert.equal(formatDuration(HOUR + 2 * MINUTE), '1h 02m');
assert.equal(formatDuration(59 * SECOND + 900), '1m 00s', '进位到分钟后秒位补零');
log('formatDuration 边界通过');

assert.equal(formatSpan(1_000, 1_000 + 90 * SECOND), '1m 30s');
log('formatSpan 通过');

const now = 1_700_000_000_000;
assert.equal(formatRelative(now - 30 * SECOND, now), '刚刚');
assert.equal(formatRelative(now - 5 * MINUTE, now), '5 分钟前');
assert.equal(formatRelative(now - 3 * HOUR, now), '3 小时前');
assert.equal(formatRelative(now - 2 * DAY, now), '2 天前');
log('formatRelative 档位通过');

log('全部通过');
