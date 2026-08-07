/**
 * 把保留且未提交的 findings 组装成一次 GitHub PR review 的请求体(原子提交)。
 * 纯函数:不碰网络,便于单测与「按钮标签=实际提交内容」一致。见 docs/design/findings-submit.md。
 */
import {
  SEVERITY_EMOJI,
  findingAnchorText,
  findingNarrative,
  findingSuggestion,
  hasFreshStatement,
  isStillPresent,
  type Finding,
  type Review,
} from './domain';
import type { DiffFile } from './diff';

/** UI 侧 event 值 → GitHub `POST .../reviews` 的 event 枚举。 */
export const GH_REVIEW_EVENTS = ['comment', 'request_changes', 'approve'] as const;
export type GhReviewEvent = (typeof GH_REVIEW_EVENTS)[number];

export const GH_EVENT_API: Record<GhReviewEvent, 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'> = {
  comment: 'COMMENT',
  request_changes: 'REQUEST_CHANGES',
  approve: 'APPROVE',
};

/** 一条 inline 行评论(锚在新增侧 RIGHT,行号取 finding 的新侧行)。 */
export interface PrReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface PrReviewPayload {
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  body: string;
  comments: PrReviewComment[];
  /**
   * 补缩进所依据的那份 diff 属于哪个 head sha。给了就钉成 `commit_id` ——
   * 否则提交层会再独立读一次 head,两次读之间的推送会让「按 A 的行补的缩进」提交到 B。
   * 缺省(没用上 diff / 拉不到)时仍由提交层读实时 head。
   */
  commitId?: string;
}

/** finding 是否作为 inline 行评论提交:有新侧行号,且没被提交屏降级为摘要条目。 */
export const hasAnchor = (f: Finding): boolean =>
  Boolean(f.file) && f.line > 0 && !f.anchorDropped;

/**
 * review body 里这批条目的小标题。写给 PR 作者看,不用「锚点 / 降级」这类 app 内部词;
 * 也不叫「整体意见」—— 上面那段 reviewer 手填的才是,而这里混着有 file:line 的具体条目。
 */
export const SUMMARY_HEADING = '### 其他意见(未落在改动行上)';

/** 严重度圆点 + 加粗的「[severity · category] 标题」,inline 条目与摘要条目共用。 */
function headline(f: Finding): string {
  const cat = f.category ? ` · ${f.category}` : '';
  return `${SEVERITY_EMOJI[f.severity]} **[${f.severity}${cat}] ${f.title}**`;
}

/** 追评要自报身份,否则 author 看到的是同一处冒出第二条评论,像重复上报。 */
function followUpLead(f: Finding, currentRound: number): string {
  return needsRecheckFollowUp(f, currentRound)
    ? `> ↻ 第 ${currentRound} 轮复核追评 · 同一处此前已提过`
    : '';
}

/**
 * 按 file + 新侧行号索引 diff 的行原文。suggestion 要据锚定行补齐缩进(见 alignSuggestion),
 * 提交、导出与两处预览都要问同一个来源,否则屏上看到的补丁和发出去的不是一份。
 */
export function anchorLineIndex(diff: DiffFile[]): (f: Finding) => string | undefined {
  const byKey = new Map<string, string>();
  for (const file of diff)
    for (const hunk of file.hunks)
      for (const l of hunk.lines) if (l.newLine != null) byKey.set(`${file.path}:${l.newLine}`, l.text);
  return (f) => byKey.get(`${f.file}:${f.line}`);
}

/** 一条 finding → inline 评论正文:标题 + 正文 + 可选 suggestion 块。 */
function commentBody(f: Finding, currentRound: number, anchorLine?: string): string {
  const parts = [followUpLead(f, currentRound), headline(f), findingNarrative(f, currentRound)];
  let body = parts.filter(Boolean).join('\n\n');
  const suggestion = findingSuggestion(f, currentRound, anchorLine);
  if (suggestion) body += '\n\n```suggestion\n' + suggestion + '\n```';
  return body;
}

/** 多行正文并进列表项:每行缩进两格,否则第二段起会掉出该项,看不出正文属于哪条 finding。 */
const indentContinuation = (s: string): string =>
  s
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : ''))
    .join('\n');

/**
 * 组装请求体。findings 应为「保留且未提交」的待提交集(由调用方过滤)。
 * 有锚点 → inline;无锚点(整体/架构类)→ 并入 review body。
 *
 * body 是 reviewer 在提交屏手填的意见,**不取 review.summaryBody** ——
 * agent 的总结只呈现给 reviewer 自己,发给 PR 作者的话得由人自己写下。
 *
 * diff 只用来给 suggestion 补齐锚定行的缩进;缺省(取不到 diff)时补丁原样发出。
 * headSha 是这份 diff 所属的 commit —— 与 diff 同源才有意义,别单独传。
 */
export function buildPrReviewPayload(
  review: Review,
  findings: Finding[],
  event: GhReviewEvent,
  body: string,
  diff: DiffFile[] = [],
  headSha: string | null = null,
): PrReviewPayload {
  const anchored = findings.filter(hasAnchor);
  const unanchored = findings.filter((f) => !hasAnchor(f));
  const anchorLineOf = anchorLineIndex(diff);

  const comments: PrReviewComment[] = anchored.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: commentBody(f, review.currentRound, anchorLineOf(f)),
  }));

  const parts: string[] = [];
  if (body.trim()) parts.push(body.trim());
  if (unanchored.length) {
    const lines = unanchored.map((f) => {
      // 锚点必须写进正文:摘要条目脱离了 inline 的位置,少了 file:line 作者无从判断说的是哪儿。
      const block = [
        followUpLead(f, review.currentRound),
        f.file ? `\`${findingAnchorText(f)}\`` : '',
        findingNarrative(f, review.currentRound),
      ]
        .filter(Boolean)
        .join('\n\n');
      const head = `- ${headline(f)}`;
      return block ? `${head}\n\n${indentContinuation(block)}` : head;
    });
    parts.push(`${SUMMARY_HEADING}\n\n${lines.join('\n\n')}`);
  }

  return {
    event: GH_EVENT_API[event],
    body: parts.join('\n\n'),
    comments,
    ...(headSha ? { commitId: headSha } : {}),
  };
}

/**
 * 提交前置校验(前后端共用,保证按钮可用性与后端判定一致)。
 * GitHub 要求 COMMENT / REQUEST_CHANGES 至少带 body 或行评论;APPROVE 可以空手提交。
 * 返回不可提交的原因,可提交返回 null。
 */
export function submitBlocker(payload: PrReviewPayload): string | null {
  if (payload.event === 'APPROVE') return null;
  if (payload.comments.length > 0 || payload.body.trim()) return null;
  return 'Comment / Request changes 需要填写 Review 意见,或至少保留一条 finding。';
}

/**
 * 上一轮已提交、本轮复核判定仍存在且写下了新话 → 还欠 author 一条追评。
 * `submitted` 之所以不再是"发过就完"的终态:作者据首轮评论改过一版、agent 复核后认定没改对,
 * 这条结论只留在本地等于白复核。同轮内不重复(提交时记下轮次),避免一轮里连发两条同样的评论。
 *
 * 「新话」两种落法都算(见 {@link hasFreshStatement}):只认复核说明的话,agent 一改写正文
 * 就把说明清掉,这条追评随即从待提交集里消失 —— 而它欠着的追评并没有还上。
 */
export function needsRecheckFollowUp(f: Finding, currentRound: number): boolean {
  if (f.submission !== 'submitted' || !isStillPresent(f, currentRound)) return false;
  if (!hasFreshStatement(f, currentRound)) return false;
  return (f.submittedRound ?? currentRound) < currentRound;
}

/** 待提交集:保留(triage!=dismiss)且未提交,或已提交但欠一条复核追评。 */
export const isSubmittable = (f: Finding, currentRound: number): boolean =>
  f.triage !== 'dismiss' &&
  (f.submission !== 'submitted' || needsRecheckFollowUp(f, currentRound));

// ---- 行锚点存活预判(本地据最新 diff 判断,GitHub 422 不告知是哪条)----

/** 遍历某文件所有 hunk 里可作为 RIGHT 侧评论的新侧行号(add/context 行)。 */
function liveLines(file: string, diff: DiffFile[]): number[] {
  const df = diff.find((f) => f.path === file);
  if (!df) return [];
  const out: number[] = [];
  for (const h of df.hunks) {
    for (const l of h.lines) {
      if ((l.kind === 'add' || l.kind === 'context') && l.newLine != null) out.push(l.newLine);
    }
  }
  return out;
}

/** (path,line) 是否是最新 diff 里合法的 RIGHT 侧行评论位置。diff 为空时不预判(返回 true 放行)。 */
export function isAnchorLive(file: string, line: number, diff: DiffFile[]): boolean {
  if (!file || line <= 0) return false;
  if (diff.length === 0) return true; // 无 diff 可比对时不误报,交由 GitHub 裁决
  return liveLines(file, diff).includes(line);
}

/** 待提交 + 有锚点 + 锚点不在最新 diff 新增侧 → 会让整份 PR review 被 422 拒。 */
export function isStaleAnchor(f: Finding, diff: DiffFile[], currentRound: number): boolean {
  return isSubmittable(f, currentRound) && hasAnchor(f) && !isAnchorLive(f.file, f.line, diff);
}

/** 同文件里离原行最近的可评论新侧行号(改锚点用);无可锚行返回 null。 */
export function nearestLiveLine(file: string, line: number, diff: DiffFile[]): number | null {
  const lines = liveLines(file, diff);
  if (lines.length === 0) return null;
  return lines.reduce((best, l) => (Math.abs(l - line) < Math.abs(best - line) ? l : best), lines[0]);
}
