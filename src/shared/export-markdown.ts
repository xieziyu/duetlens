/**
 * 把一次 review 的保留 findings 生成一份 Markdown 报告(任何 source 都可导出;
 * github-pr 下它与「提交到 GitHub」并列,用于存档 / 分享,不替代提交)。
 * 刻意不含 agent 的总结与重点关注文件:那两样是给 reviewer 在 app 里判断用的,
 * 报告是他要发出去的东西,内容该由他自己定。
 * 纯函数:仅依赖入参,便于单测与「预览=复制=保存」内容一致。见 docs/design/findings-submit.md。
 */
import {
  SEVERITY_EMOJI,
  findingAnchorText,
  findingNarrative,
  findingSuggestion,
  type Finding,
  type Review,
  type Severity,
  type SourceKind,
} from './domain';
import type { DiffFile } from './diff';
import { anchorLineIndex, isSubmittable, needsRecheckFollowUp } from './github-review';

export interface ExportOptions {
  /** 含 suggestion 代码块(渲染为 ```suggestion,GitHub 外无一键采纳但保留格式) */
  suggestion: boolean;
  /** 末尾以删除线列出已剔除项 */
  dismissed: boolean;
  group: 'severity' | 'file';
  /**
   * 导出哪些保留项:全部,或只要还没发到 GitHub 的那批(与提交屏的待提交集同口径)。
   * 仅 github-pr 有区别 —— 其余 source 没有提交这一步,两者恒等。
   */
  scope: 'all' | 'pending';
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  suggestion: true,
  dismissed: false,
  group: 'severity',
  scope: 'all',
};

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const SOURCE_LABEL: Record<SourceKind, string> = {
  'github-pr': 'GitHub PR',
  'local-branch': '本地分支',
  'gitbutler-vbranch': 'GitButler 虚拟分支',
};

/** finding 是否保留(triage 非 dismiss);与 diff-review / GitHub submit 同一 triage 语义。 */
export const isKept = (f: Finding): boolean => f.triage !== 'dismiss';

const bySeverity = (a: Finding, b: Finding) => SEV_RANK[a.severity] - SEV_RANK[b.severity];

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 报告文件名:review-<分支/PR slug>.md */
export function exportFileName(review: Review): string {
  // PR 标题常是中文,走 slug 会被清成空串、落成同一个 review-export.md;PR 号才是稳定标识。
  // 三条口径对齐 source 侧的 parsePrRef:完整 URL / owner/repo#123 / 纯号(仓库靠 repoPath 推断)
  if (review.source === 'github-pr') {
    const ref = (review.sourceRef ?? '').trim();
    const num = /(?:#|\/pull\/)(\d+)/.exec(ref)?.[1] ?? /^(\d+)$/.exec(ref)?.[1];
    if (num) return `review-pr-${num}.md`;
  }
  const raw = review.title ?? review.sourceRef ?? review.id;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `review-${slug || 'export'}.md`;
}

/**
 * 提交状态标注。作者是否已经在 PR 上看到过这条,是读报告的人最先要分辨的事;
 * 非 github source 没有提交这一步,不写(否则每条后面挂一个恒为「待提交」的空标)。
 */
function submissionNote(f: Finding, review: Review): string | null {
  if (review.source !== 'github-pr') return null;
  if (needsRecheckFollowUp(f, review.currentRound)) return '↻ 上一轮已提交 · 本轮复核仍存在';
  return f.submission === 'submitted' ? '✓ 已提交' : '待提交';
}

/**
 * 单条 finding 块;heading 为 finding 标题所用的 markdown 级别(分组下降一级)。
 * 与 GitHub 提交同一口径:本轮复核判定仍存在的,正文取复核说明、首轮 suggestion 一并作废。
 */
function findingBlock(
  f: Finding,
  opts: ExportOptions,
  heading: string,
  review: Review,
  anchorLine?: string,
): string {
  const currentRound = review.currentRound;
  const cat = f.category ? ` · ${f.category}` : '';
  let block = `${heading} ${SEVERITY_EMOJI[f.severity]} ${f.severity}${cat} — ${f.title}\n\n`;
  const note = submissionNote(f, review);
  block += `\`${findingAnchorText(f)}\`${note ? ` · ${note}` : ''}\n\n`;
  const narrative = findingNarrative(f, currentRound);
  if (narrative) block += `${narrative}\n\n`;
  const suggestion = findingSuggestion(f, currentRound, anchorLine);
  if (opts.suggestion && suggestion) {
    block += '```suggestion\n' + suggestion + '\n```\n\n';
  }
  return block;
}

/** diff 只用来给 suggestion 补齐锚定行的缩进;缺省时补丁原样导出。 */
export function buildReviewMarkdown(
  review: Review,
  findings: Finding[],
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
  diff: DiffFile[] = [],
): string {
  const anchorLineOf = anchorLineIndex(diff);
  const pendingOnly = opts.scope === 'pending';
  const kept = findings.filter((f) => (pendingOnly ? isSubmittable(f, review.currentRound) : isKept(f)));
  const dropped = findings.filter((f) => !isKept(f));
  const title = review.title ?? review.sourceRef ?? review.id;

  let md = `# Review — ${title}\n\n`;
  md += `> Duetlens · ${SOURCE_LABEL[review.source]} · \`${review.sourceRef}\` · ${isoDate(review.createdAt)}\n\n`;

  md += `## Findings（${pendingOnly ? '待提交' : '保留'} ${kept.length}）\n\n`;
  if (kept.length === 0) {
    md += pendingOnly ? '_没有待提交的 finding。_\n\n' : '_没有保留任何 finding。_\n\n';
  } else if (opts.group === 'file') {
    const byFile = new Map<string, Finding[]>();
    for (const f of [...kept].sort(bySeverity)) {
      const list = byFile.get(f.file);
      if (list) list.push(f);
      else byFile.set(f.file, [f]);
    }
    for (const [file, list] of byFile) {
      md += `### ${file}\n\n`;
      for (const f of list) md += findingBlock(f, opts, '####', review, anchorLineOf(f));
    }
  } else {
    for (const f of [...kept].sort(bySeverity))
      md += findingBlock(f, opts, '###', review, anchorLineOf(f));
  }

  if (opts.dismissed && dropped.length) {
    md += `## 已剔除（${dropped.length}）\n\n`;
    for (const f of dropped) {
      const cat = f.category ? ` · ${f.category}` : '';
      md += `- ~~${f.title}~~（${f.severity}${cat} · ${findingAnchorText(f)}）\n`;
    }
    md += '\n';
  }

  return md.trim() + '\n';
}
