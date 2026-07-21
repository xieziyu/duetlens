/**
 * 把保留且未提交的 findings 组装成一次 GitHub PR review 的请求体(原子提交)。
 * 纯函数:不碰网络,便于单测与「按钮标签=实际提交内容」一致。见 docs/design/findings-submit.md。
 */
import type { Finding, Review } from './domain';

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

/** 待提交集:保留(triage!=dismiss)且未提交。 */
export const isSubmittable = (f: Finding): boolean =>
  f.triage !== 'dismiss' && f.submission !== 'submitted';
