/**
 * 把保留且未提交的 findings 组装成一次 GitHub PR review 的请求体(原子提交)。
 * 纯函数:不碰网络,便于单测与「按钮标签=实际提交内容」一致。见 docs/design/findings-submit.md。
 */
import type { Finding, Review } from './domain';
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

/** 一次 PR review 的请求体(commit_id 由提交层补,它需要实时 head sha)。 */
export interface PrReviewPayload {
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  body: string;
  comments: PrReviewComment[];
}

const SEV_LABEL: Record<Finding['severity'], string> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** finding 是否有可作为 inline 锚点的位置(新侧行号 > 0)。当前模型 finding 恒有锚点。 */
export const hasAnchor = (f: Finding): boolean => Boolean(f.file) && f.line > 0;

/** 一条 finding → inline 评论正文:标题 + 正文 + 可选 suggestion 块。 */
function commentBody(f: Finding): string {
  const cat = f.category ? ` · ${f.category}` : '';
  let body = `**${SEV_LABEL[f.severity]}${cat}** — ${f.title}`;
  if (f.body.trim()) body += `\n\n${f.body.trim()}`;
  if (f.suggestion?.trim()) body += '\n\n```suggestion\n' + f.suggestion.trim() + '\n```';
  return body;
}

/**
 * 组装请求体。findings 应为「保留且未提交」的待提交集(由调用方过滤)。
 * 有锚点 → inline;无锚点(整体/架构类)→ 并入 review body。
 */
export function buildPrReviewPayload(
  review: Review,
  findings: Finding[],
  event: GhReviewEvent,
): PrReviewPayload {
  const anchored = findings.filter(hasAnchor);
  const unanchored = findings.filter((f) => !hasAnchor(f));

  const comments: PrReviewComment[] = anchored.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: commentBody(f),
  }));

  const parts: string[] = [];
  if (review.summaryBody?.trim()) parts.push(review.summaryBody.trim());
  if (unanchored.length) {
    const lines = unanchored.map((f) => {
      const cat = f.category ? ` · ${f.category}` : '';
      return `- **${f.title}**（${SEV_LABEL[f.severity]}${cat}）— ${f.body.trim()}`;
    });
    parts.push(`### 整体意见\n\n${lines.join('\n')}`);
  }

  return { event: GH_EVENT_API[event], body: parts.join('\n\n'), comments };
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

/** 待提交集:保留(triage!=dismiss)且未提交。 */
export const isSubmittable = (f: Finding): boolean =>
  f.triage !== 'dismiss' && f.submission !== 'submitted';

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
export function isStaleAnchor(f: Finding, diff: DiffFile[]): boolean {
  return isSubmittable(f) && hasAnchor(f) && !isAnchorLive(f.file, f.line, diff);
}

/** 同文件里离原行最近的可评论新侧行号(改锚点用);无可锚行返回 null。 */
export function nearestLiveLine(file: string, line: number, diff: DiffFile[]): number | null {
  const lines = liveLines(file, diff);
  if (lines.length === 0) return null;
  return lines.reduce((best, l) => (Math.abs(l - line) < Math.abs(best - line) ? l : best), lines[0]);
}
