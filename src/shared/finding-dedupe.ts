/**
 * 复审轮次的 finding 去重(纯函数,前后端共用、可单测)。
 *
 * 重跑必然会重报大量同样的问题。第一层防线是 prompt(把已有 findings 列给 agent 并要求别重报),
 * 但那是软约束;这里是兜底硬约束:新上报的 finding 若与已有条目实质相同,
 * 命中「已剔除」则抑制不落库,命中「保留中」则视作 agent 表态「仍存在」。
 *
 * 判定刻意保守 —— 宁可漏判成新 finding(用户多看一条),也不要吞掉真正的新问题。
 */

/** 参与匹配的最小形状;Finding 与 MCP 上报的原始结构都满足它。 */
export interface DedupeShape {
  file: string;
  line: number;
  title: string;
}

/** 行号相近的窗口:代码增删几行仍算同一处。 */
const LINE_WINDOW = 12;
/** 同一处代码:标题略有出入也算同一问题。 */
const NEAR_THRESHOLD = 0.5;
/** 隔得远(代码被挪动):要标题高度一致才敢判为同一条。 */
const FAR_THRESHOLD = 0.8;
/**
 * 「同一条被重述」的门槛:比 NEAR_THRESHOLD 严得多 —— 在 isSameFinding 已命中的前提下,
 * 再分一次「这是同一条换了个说法」还是「同一处代码上的另一个问题」。两档同值不同政策,各自可动。
 */
const RESTATE_THRESHOLD = 0.8;

/** 归一化标题:去掉大小写、空白与标点,只留字母数字与 CJK,让「表述微调」不影响比对。 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

/** 相邻二元组集合;单字符串短于 2 时退化为其本身,避免空集。 */
function bigrams(s: string): Set<string> {
  if (s.length < 2) return new Set(s ? [s] : []);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 标题相似度(Dice 系数,0–1)。用 bigram 而非分词:中英混排的 finding 标题没有可靠分词器,
 * bigram 对中文天然接近词粒度,对英文也够用。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const g of bx) if (by.has(g)) shared++;
  return (2 * shared) / (bx.size + by.size);
}

/** 单条比对:同文件 + (近行且标题够像 | 远行但标题几乎一致)。 */
export function isSameFinding(a: DedupeShape, b: DedupeShape): boolean {
  if (a.file !== b.file) return false;
  const sim = titleSimilarity(a.title, b.title);
  const near = Math.abs(a.line - b.line) <= LINE_WINDOW;
  return sim >= (near ? NEAR_THRESHOLD : FAR_THRESHOLD);
}

/**
 * 命中之后的二次分档:这条上报是把同一条**换个说法重述**一遍(true),还是同一处代码上的
 * 另一个问题(false)。给"同一处已有结论、却又被报了一次"的场合定性 —— 前者该纠正原条目,
 * 后者该新建。调用方须已用 isSameFinding 确认是同一处。
 */
export function isRestatedFinding(a: DedupeShape, b: DedupeShape): boolean {
  return titleSimilarity(a.title, b.title) >= RESTATE_THRESHOLD;
}

/**
 * 在已有 findings 里找与候选实质相同的一条;多条命中取标题最像的。
 * 无命中返回 null(= 是个新问题)。
 */
export function findDuplicate<T extends DedupeShape>(candidate: DedupeShape, existing: readonly T[]): T | null {
  let best: T | null = null;
  let bestSim = -1;
  for (const e of existing) {
    if (!isSameFinding(candidate, e)) continue;
    const sim = titleSimilarity(candidate.title, e.title);
    if (sim > bestSim) {
      best = e;
      bestSim = sim;
    }
  }
  return best;
}
