/**
 * 把一次 review 的保留 findings + 摘要生成一份 Markdown 报告(本地/vbranch source 的终点)。
 * 纯函数:仅依赖入参,便于单测与「预览=复制=保存」内容一致。见 docs/design/findings-submit.md。
 */
import {
  PRIOR_BODY_LABEL,
  SEVERITY_EMOJI,
  recheckNote,
  type Finding,
  type Review,
  type Severity,
  type SourceKind,
} from './domain';

export interface ExportOptions {
  /** 含 codex 审核摘要 */
  summary: boolean;
  /** 含 suggestion 代码块(渲染为 ```suggestion,GitHub 外无一键采纳但保留格式) */
  suggestion: boolean;
  /** 末尾以删除线列出已剔除项 */
  dismissed: boolean;
  group: 'severity' | 'file';
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  summary: true,
  suggestion: true,
  dismissed: false,
  group: 'severity',
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
  const raw = review.title ?? review.sourceRef ?? review.id;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `review-${slug || 'export'}.md`;
}

/**
 * 单条 finding 块;heading 为 finding 标题所用的 markdown 级别(分组下降一级)。
 * 与 GitHub 提交同一口径:本轮复核判定仍存在的,复核说明作正文主体,首轮正文降为背景。
 */
function findingBlock(
  f: Finding,
  opts: ExportOptions,
  heading: string,
  currentRound: number,
): string {
  const cat = f.category ? ` · ${f.category}` : '';
  let block = `${heading} ${SEVERITY_EMOJI[f.severity]} ${f.severity}${cat} — ${f.title}\n\n`;
  block += `\`${f.file}:${f.line}\`\n\n`;
  const note = recheckNote(f, currentRound);
  const prior = f.body.trim();
  if (note) block += `${note}\n\n`;
  if (prior) block += note ? `**${PRIOR_BODY_LABEL}**\n\n${prior}\n\n` : `${prior}\n\n`;
  if (opts.suggestion && f.suggestion?.trim()) {
    block += '```suggestion\n' + f.suggestion.trim() + '\n```\n\n';
  }
  return block;
}

export function buildReviewMarkdown(
  review: Review,
  findings: Finding[],
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const kept = findings.filter(isKept);
  const dropped = findings.filter((f) => !isKept(f));
  const title = review.title ?? review.sourceRef ?? review.id;

  let md = `# Review — ${title}\n\n`;
  md += `> Duetlens · ${SOURCE_LABEL[review.source]} · \`${review.sourceRef}\` · ${isoDate(review.createdAt)}\n\n`;

  if (opts.summary && review.summaryBody?.trim()) {
    md += `## 摘要\n\n${review.summaryBody.trim()}\n\n`;
  }

  md += `## Findings（保留 ${kept.length}）\n\n`;
  if (kept.length === 0) {
    md += '_没有保留任何 finding。_\n\n';
  } else if (opts.group === 'file') {
    const byFile = new Map<string, Finding[]>();
    for (const f of [...kept].sort(bySeverity)) {
      const list = byFile.get(f.file);
      if (list) list.push(f);
      else byFile.set(f.file, [f]);
    }
    for (const [file, list] of byFile) {
      md += `### ${file}\n\n`;
      for (const f of list) md += findingBlock(f, opts, '####', review.currentRound);
    }
  } else {
    for (const f of [...kept].sort(bySeverity)) md += findingBlock(f, opts, '###', review.currentRound);
  }

  if (opts.dismissed && dropped.length) {
    md += `## 已剔除（${dropped.length}）\n\n`;
    for (const f of dropped) {
      const cat = f.category ? ` · ${f.category}` : '';
      md += `- ~~${f.title}~~（${f.severity}${cat} · ${f.file}:${f.line}）\n`;
    }
    md += '\n';
  }

  return md.trim() + '\n';
}
