/**
 * Duetlens 领域模型:一次 review = 一个 codex thread + 一组 discussion(finding 是特殊 discussion)。
 * 见 docs/design/data-model.md、findings-submit.md。
 * zod schema 用于 MCP ingress 校验(report_finding/update_finding);存储实体用 interface。
 */
import { z } from 'zod';

// ---- 枚举 ----
export const SOURCE_KINDS = ['github-pr', 'local-branch', 'gitbutler-vbranch'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * finding 分类的软规范标签集(源自 better-review 1.0 builtin-rules)。
 * category 仍以自由字符串存储/校验,此集仅作填写建议与筛选归类,便于按类分组。
 */
export const FINDING_CATEGORIES = [
  'Scope',
  'Correctness',
  'Type Safety',
  'Security',
  'Architecture',
  'Performance',
  'Naming',
  'Complexity',
  'Error Handling',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** finding 从何而来:agent 上报 / 用户手动 / 由 user-discussion 提升 */
export const FINDING_ORIGINS = ['agent', 'manual', 'promoted'] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

/** 用户裁决 */
export const TRIAGES = ['open', 'keep', 'dismiss'] as const;
export type Triage = (typeof TRIAGES)[number];

/** 提交状态 */
export const SUBMISSIONS = ['unsubmitted', 'submitted'] as const;
export type Submission = (typeof SUBMISSIONS)[number];

export const DISCUSSION_KINDS = ['finding', 'user'] as const;
export type DiscussionKind = (typeof DISCUSSION_KINDS)[number];

export const MESSAGE_ROLES = ['agent', 'user'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const REVIEW_STATUSES = ['scanning', 'reviewing', 'submitted', 'exported', 'failed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * codex reasoning effort(透传 config.toml 的 model_reasoning_effort)。
 * codex 全集含 none/max/ultra,此处取通用且对审核有意义的子集;medium 为 codex 缺省。
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

// ---- MCP ingress schema(agent 经工具回传的字段;triage/submission 由用户侧决定,不在此)----
export const reportFindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().default(''),
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  suggestion: z.string().optional(),
});
export type ReportFindingInput = z.infer<typeof reportFindingSchema>;

/** update_finding:对话打磨后回写,按 findingId 部分更新可编辑字段 */
export const updateFindingSchema = z.object({
  findingId: z.string().min(1),
  severity: z.enum(SEVERITIES).optional(),
  category: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  suggestion: z.string().nullable().optional(),
});
export type UpdateFindingInput = z.infer<typeof updateFindingSchema>;

// ---- 存储实体 ----
export interface Review {
  id: string;
  source: SourceKind;
  /** PR 链接 / 分支名 / vbranch 标识 */
  sourceRef: string;
  /** 可选本地仓库路径(github source 也可指定,让 agent 读全量代码) */
  repoPath: string | null;
  /** codex 侧会话 id(续接用) */
  codexThreadId: string | null;
  /** 用户指定的 codex 模型(null=账号默认);续接会话时复用 */
  model: string | null;
  /** 用户指定的 reasoning effort(null=codex 缺省 medium) */
  reasoningEffort: ReasoningEffort | null;
  title: string | null;
  status: ReviewStatus;
  /** codex 生成、用户可编辑的总结正文(提交屏 review body 来源) */
  summaryBody: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Discussion {
  id: string;
  reviewId: string;
  kind: DiscussionKind;
  origin: FindingOrigin;
  file: string | null;
  /** 锚点起始行(新侧);范围以 lineEnd 表达 */
  line: number | null;
  lineEnd: number | null;
  createdAt: number;
}

export interface Finding {
  id: string;
  reviewId: string;
  /** finding 也是一条 discussion(kind=finding);持有其 id 以挂 messages */
  discussionId: string;
  origin: FindingOrigin;
  severity: Severity;
  category: string | null;
  title: string;
  body: string;
  file: string;
  line: number;
  suggestion: string | null;
  triage: Triage;
  submission: Submission;
  /** 提交后回填的 GitHub 评论链接 */
  submittedUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  discussionId: string;
  role: MessageRole;
  text: string;
  createdAt: number;
}

// ---- Persisted UI state(见 frontend-components.md 持久化表)----
export interface UiSettings {
  dataMode: 'light' | 'dark';
  dataTheme: 'duetlens' | 'github';
  leftWidth: number;
  rightWidth: number;
  defaultTab: 'discussion' | 'findings' | 'summary';
  defaultDiffView: 'unified' | 'split';
  /** 发起表单预填的模型(空=账号默认) */
  defaultModel: string;
  /** 发起表单预填的 reasoning effort */
  defaultEffort: ReasoningEffort;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  dataMode: 'dark',
  dataTheme: 'duetlens',
  leftWidth: 260,
  rightWidth: 420,
  defaultTab: 'findings',
  defaultDiffView: 'unified',
  defaultModel: '',
  defaultEffort: DEFAULT_REASONING_EFFORT,
};

/** per-review 的进度态(随会话恢复);viewedFiles = 已标记「已看」的文件路径。 */
export interface ReviewUiState {
  viewedFiles: string[];
  lastActiveTab: string | null;
}

export const DEFAULT_REVIEW_UI_STATE: ReviewUiState = {
  viewedFiles: [],
  lastActiveTab: null,
};
