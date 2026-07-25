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

/** 严重度圆点:GitHub 评论与导出报告共用一套配色,便于两处产物对照。 */
export const SEVERITY_EMOJI: Record<Severity, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🔵',
};

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

/** 用户裁决:open 保留纳入提交/导出,dismiss 剔除 */
export const TRIAGES = ['open', 'dismiss'] as const;
export type Triage = (typeof TRIAGES)[number];

/** 提交状态 */
export const SUBMISSIONS = ['unsubmitted', 'submitted'] as const;
export type Submission = (typeof SUBMISSIONS)[number];

/**
 * 复审轮次里 agent 对上一轮 finding 的判定。
 * 只在「表态轮次 === review 当前轮次」时代表本轮结论(见 Finding.lastSeenRound)。
 *
 * `wont_fix` 不可省:作者在 PR 上回一句「这是调试脚本,可忽略」时,代码确实原样未变 ——
 * 只有 fixed/still_present 两格的话,agent 只能答 still_present,于是同一条意见每轮都重报一遍。
 */
export const FINDING_RESOLUTIONS = ['fixed', 'still_present', 'wont_fix'] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

/** 一轮机审的生命周期;失败轮次保留在历史里,不回滚轮次号。 */
export const ROUND_STATUSES = ['scanning', 'done', 'failed'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

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

/**
 * 审核强度:审核方法论的深浅,与 reasoningEffort(模型自身推理深度)正交。
 * - standard:单轮扫描,直接上报。
 * - adversarial:注入证伪立场 + 扫描后追加一轮自检(补漏、给存疑结论降级),更准但 token 成倍。
 * 只读约束不变;不写盘、不执行代码。
 */
export const REVIEW_INTENSITIES = ['standard', 'adversarial'] as const;
export type ReviewIntensity = (typeof REVIEW_INTENSITIES)[number];
export const DEFAULT_REVIEW_INTENSITY: ReviewIntensity = 'standard';

/** 强度档位的显示名与代价提示;发起表单、重跑面板、设置页共用一份,避免文案漂移。 */
export const INTENSITY_LABELS: Record<ReviewIntensity, string> = {
  standard: '标准',
  adversarial: '对抗',
};
export const INTENSITY_HINTS: Record<ReviewIntensity, string> = {
  standard: '单轮扫描,直接上报 · 最快、最省 token',
  adversarial: 'agent 以证伪立场构造反例,扫描后再自检一轮 · 更准,但 token 成倍、更慢',
};

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

/** resolve_finding:复审轮次里对上一轮 finding 表态「已修复 / 仍存在」 */
export const resolveFindingSchema = z.object({
  findingId: z.string().min(1),
  status: z.enum(FINDING_RESOLUTIONS),
  note: z.string().optional(),
});
export type ResolveFindingInput = z.infer<typeof resolveFindingSchema>;

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
  /** 审核强度(标准 / 对抗);续接会话与重跑复用同一档 */
  intensity: ReviewIntensity;
  title: string | null;
  status: ReviewStatus;
  /** codex 生成、用户可编辑的总结正文(提交屏 review body 来源) */
  summaryBody: string | null;
  /** 已跑到第几轮机审(首轮=1;每次重跑 +1) */
  currentRound: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 一轮机审的元信息(首轮与每次重跑各一条)。
 * 每轮独立开一个 codex thread —— 上一轮的上下文靠结构化注入带过来,而非复用会话记忆,
 * 避免新旧 diff 的行号在同一上下文里互相污染。
 */
export interface ReviewRound {
  reviewId: string;
  round: number;
  /** 该轮的 codex 会话 id */
  codexThreadId: string | null;
  /** 开跑时被审代码的 head;与上一轮比对即知代码有无变化 */
  headSha: string | null;
  status: RoundStatus;
  /** 用户在重跑面板填的附加说明 */
  note: string | null;
  /** 本轮新报出的 finding 数 */
  newFindings: number;
  /** 本轮被 agent 判定已修复的数 */
  fixedCount: number;
  /** 命中已剔除项、被抑制未落库的重复上报数 */
  suppressedCount: number;
  startedAt: number;
  endedAt: number | null;
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
  /** reviewer 剔除时可选填的理由;复审时注入,让 agent 不再报同类问题 */
  dismissReason: string | null;
  submission: Submission;
  /** 提交后回填的 GitHub 评论链接 */
  submittedUrl: string | null;
  /** 首次被报出的轮次 */
  round: number;
  /** agent 最近一次对它表态或重报的轮次 */
  lastSeenRound: number;
  /** 该次表态的结论;仅当 lastSeenRound === Review.currentRound 时代表本轮判定 */
  resolution: FindingResolution | null;
  resolutionNote: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 复核判定已修复后**自动结案**的条目 —— 与 reviewer 主动剔除(「这不是问题」)语义不同:
 * 它只是"当前代码里已经没有了",同一处再被报出来就是回归,应恢复而非继续抑制。
 * `resolution === 'fixed'` 足以判别:表态只发生在保留中的条目上,一旦表态即自动剔除。
 */
export const isAutoClosedFixed = (f: Finding): boolean =>
  f.triage === 'dismiss' && f.resolution === 'fixed';

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
  /** 发起表单预填的默认来源(入口只分 github-pr / 本地仓库两档,本地档统一存 local-branch) */
  defaultSource: SourceKind;
  /** 本地仓库来源上次用过的仓库路径(发起表单预填) */
  lastRepoPath: string;
  /** findings 右栏的默认分组方式 */
  findingsGrouping: 'severity' | 'file';
  /** 标记「已看」后是否自动折叠该文件的 diff */
  collapseViewedFiles: boolean;
  /** 发起表单预填的模型(空=账号默认) */
  defaultModel: string;
  /** 发起表单预填的 reasoning effort */
  defaultEffort: ReasoningEffort;
  /** 发起表单预填的审核强度 */
  defaultIntensity: ReviewIntensity;
  /** 扫描完成 / 追问回复时是否提示(未聚焦弹原生通知,聚焦弹应用内轻提示) */
  notifyOnComplete: boolean;
  /** codex 可执行文件路径(空=用 PATH 中的 codex) */
  codexPath: string;
  /** gh 可执行文件路径(空=用 PATH 中的 gh) */
  ghPath: string;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  dataMode: 'dark',
  dataTheme: 'duetlens',
  leftWidth: 260,
  rightWidth: 420,
  defaultTab: 'findings',
  defaultDiffView: 'unified',
  defaultSource: 'github-pr',
  lastRepoPath: '',
  findingsGrouping: 'severity',
  collapseViewedFiles: true,
  defaultModel: '',
  defaultEffort: DEFAULT_REASONING_EFFORT,
  defaultIntensity: DEFAULT_REVIEW_INTENSITY,
  notifyOnComplete: true,
  codexPath: '',
  ghPath: '',
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

/** 发起表单模型下拉的一项(codex `model/list` 归一,只留 UI 用得到的字段)。 */
export interface CodexModelInfo {
  /** 传给发起表单 / thread/start 的模型标识 */
  model: string;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}
