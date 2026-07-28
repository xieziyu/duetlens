/**
 * Duetlens 领域模型:一次 review = 一个 codex thread + 一组 discussion(finding 是特殊 discussion)。
 * 见 docs/design/data-model.md、findings-submit.md。
 * zod schema 用于 MCP ingress 校验(report_finding/update_finding);存储实体用 interface。
 */
import { z } from 'zod';
import type { AgentErrorKind } from './agent-events';

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
/** stopped = reviewer 中途叫停机审;已上报的 findings 照样作数,与跑完的 done 只差在没跑完。 */
export const ROUND_STATUSES = ['scanning', 'done', 'failed', 'stopped'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const DISCUSSION_KINDS = ['finding', 'user'] as const;
export type DiscussionKind = (typeof DISCUSSION_KINDS)[number];

export const MESSAGE_ROLES = ['agent', 'user'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const REVIEW_STATUSES = ['scanning', 'reviewing', 'completed', 'submitted', 'failed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * 首轮/每轮机审跑完后落到哪个状态 —— 由 source 决定,因为只有 github-pr 还有一步真正的终点动作
 * (提交 review 到 PR),在那之前停在 `reviewing` 是有意义的待办。
 * 本地分支 / vbranch 没有这一步:导出与否、之后还追不追问都不改变「机审已出结论」这件事,
 * 若也停在 `reviewing`,这类 review 永远闭不了环。
 */
export function scanDoneStatus(source: SourceKind): 'reviewing' | 'completed' {
  return source === 'github-pr' ? 'reviewing' : 'completed';
}

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
  // 同 suggestion:null 是「清空」,缺省才是「不改」—— 合成 undefined 就再也清不掉了
  category: z.string().min(1).nullable().optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  suggestion: z.string().nullable().optional(),
});
export type UpdateFindingInput = z.infer<typeof updateFindingSchema>;

/**
 * note 不可省的表态:`still_present` 的说明会原样取代首轮正文发给作者(见 {@link findingNarrative}),
 * `wont_fix` 要摘录作者的原话作剔除理由 —— 两者缺了 note 都会让下游只剩一句没有依据的结论。
 */
export const RESOLUTIONS_REQUIRING_NOTE: readonly FindingResolution[] = ['still_present', 'wont_fix'];

/** dismiss_finding:讨论中 agent 认为该条不成立,给出剔除理由。正文一律不动。 */
export const dismissFindingSchema = z.object({
  findingId: z.string().min(1),
  reason: z.string().min(1),
});
export type DismissFindingInput = z.infer<typeof dismissFindingSchema>;

/** restore_finding:讨论中 agent 论证已剔除的那条其实成立,给出恢复原因。 */
export const restoreFindingSchema = z.object({
  findingId: z.string().min(1),
  reason: z.string().min(1),
});
export type RestoreFindingInput = z.infer<typeof restoreFindingSchema>;

/** resolve_finding:复审轮次里对上一轮 finding 表态「已修复 / 仍存在」 */
export const resolveFindingSchema = z
  .object({
    findingId: z.string().min(1),
    status: z.enum(FINDING_RESOLUTIONS),
    note: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (RESOLUTIONS_REQUIRING_NOTE.includes(v.status) && !v.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: `status=${v.status} 必须给出 note`,
      });
    }
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
  /** 失败原因原文(agent 侧错误);仅 status='failed' 时有值 —— 失败必须留证,否则重启就查无此事 */
  errorMessage: string | null;
  /** 失败归因(见 AGENT_ERROR_KINDS);决定 UI 给什么处置建议 */
  errorKind: AgentErrorKind | null;
  /** 本轮相对上一轮变动的文件;重试同一轮时沿用,不能因失败那次已覆盖 diff 快照就算成"无改动" */
  changedFiles: string[];
  /** 本轮开跑时代码相对上一轮有无变化 */
  codeChanged: boolean;
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
  /** 提交发生在第几轮;判断复核说明是否还欠 author 一条追评(见 needsRecheckFollowUp) */
  submittedRound: number | null;
  /** 首次被报出的轮次 */
  round: number;
  /** agent 最近一次对它表态或重报的轮次 */
  lastSeenRound: number;
  /** 该次表态的结论;仅当 lastSeenRound === Review.currentRound 时代表本轮判定 */
  resolution: FindingResolution | null;
  resolutionNote: string | null;
  /** 这条剔除出自复核自动结案,而非 reviewer 的判断(见 isAutoClosedFixed) */
  autoClosed: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 复核判定已修复后**自动结案**的条目 —— 与 reviewer 主动剔除(「这不是问题」)语义不同:
 * 它只是"当前代码里已经没有了",同一处再被报出来就是回归,应恢复而非继续抑制。
 *
 * 判据是落库的 autoClosed 而非「剔除 + fixed」:后者推不出来源 —— reviewer 先剔除、agent 之后
 * 才判 fixed,或结案后他「↩ 恢复」再重新剔除,都会留下同样的一对值,却是他的判断,不该被推翻。
 */
export const isAutoClosedFixed = (f: Finding): boolean => f.triage === 'dismiss' && f.autoClosed;

/**
 * 本轮复核判定「仍存在」时 agent 给出的说明。它是看过作者的修改尝试之后写的,
 * 比首次报出的正文更新,故提交/导出时**取代**首轮正文作为评论正文。
 * 与 UI 同一口径:只有表态轮次 === 当前轮次才代表本轮结论。
 */
export function recheckNote(f: Finding, currentRound: number): string | null {
  if (f.lastSeenRound !== currentRound || f.resolution !== 'still_present') return null;
  return f.resolutionNote?.trim() || null;
}

/**
 * 提交 / 导出 / 预览三处共用的正文:有本轮复核说明就只发它,否则发首轮正文。
 * 首轮正文写在作者这次改动之前,复核说明一旦存在,它描述的代码已经不在了。
 */
export function findingNarrative(f: Finding, currentRound: number): string {
  return recheckNote(f, currentRound) ?? f.body.trim();
}

/**
 * 同上三处共用的一键补丁:复核说明取代首轮正文时,首轮 suggestion 一并作废。
 * 它与首轮正文同源、同样写在作者这次改动之前,而 `resolve_finding` 没有刷新它的入口 ——
 * 挂到当前锚点上就是一键覆盖作者刚改的代码,比一段对不上的描述更伤。
 */
export function findingSuggestion(f: Finding, currentRound: number): string | null {
  if (recheckNote(f, currentRound) !== null) return null;
  // 首行缩进是补丁的一部分(会被逐字替换进代码),只能削首尾空行与行尾空白,不能 trim
  const s = f.suggestion?.replace(/^[ \t]*\n+/, '').replace(/\s+$/, '') ?? '';
  return s || null;
}

export interface Message {
  id: string;
  discussionId: string;
  role: MessageRole;
  text: string;
  createdAt: number;
}

// ---- 讨论中的回写提案(见 docs/design/discussion-proposals.md)----

/**
 * agent 在讨论里想对 finding 做的一件事。追问轮不直接落库 —— 先记成提案,由 reviewer 一键确认。
 * `create` 是「把这条讨论记成一条 finding」,应用前还没有 finding,故 findingId 为空。
 */
export const PROPOSAL_KINDS = ['update', 'dismiss', 'restore', 'create'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** pending 等确认;applied 已落库(可撤销);skipped 被 reviewer 忽略(可重新应用)。 */
export const PROPOSAL_STATUSES = ['pending', 'applied', 'skipped'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** update 提案要写的字段;缺省即不改,与 {@link UpdateFindingInput} 同口径(null=清空)。 */
export interface ProposalUpdatePatch {
  severity?: Severity;
  category?: string | null;
  title?: string;
  body?: string;
  suggestion?: string | null;
}

/** dismiss / restore 提案的说明。dismiss 的 reason 会成为 dismissReason,注入下一轮复审。 */
export interface ProposalReasonPatch {
  reason: string;
}

export type ProposalPatch = ProposalUpdatePatch | ProposalReasonPatch | ReportFindingInput;

/**
 * 应用前的旧值,供「↩ 撤销」还原。应用那一刻才拍,故 pending 期间为 null。
 *
 * 只拍**该提案真正改动的那几个字段** —— 拍全量的话,撤销会把应用之后 reviewer 自己的编辑
 * 一并回滚掉:提案只降了个 severity,撤销却连带把他重写过的正文换回旧版。
 */
export type ProposalUpdateBefore = ProposalUpdatePatch;

export interface ProposalTriageBefore {
  triage: Triage;
  dismissReason: string | null;
  autoClosed: boolean;
}

export type ProposalBefore = ProposalUpdateBefore | ProposalTriageBefore;

interface ProposalBase {
  id: string;
  reviewId: string;
  /** 提案出自哪条讨论 */
  discussionId: string;
  /** 挂在哪条 agent 消息之后;该 turn 没有回复文本时为 null,就地接在线程末尾 */
  messageId: string | null;
  status: ProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * 提案的判别联合:kind 决定 patch / before 的形状,也决定应用时走哪条落库路径。
 * baseUpdatedAt 是提案那一刻 finding 的 updatedAt —— 与当前值不同即说明这条在提案之后又被改过,
 * 直接套用会盖掉那次改动(UI 据此给「已过期」提醒,但不拦着应用:判断权仍在 reviewer)。
 */
export type FindingProposal =
  | (ProposalBase & {
      kind: 'update';
      findingId: string;
      patch: ProposalUpdatePatch;
      before: ProposalUpdateBefore | null;
      baseUpdatedAt: number;
    })
  | (ProposalBase & {
      kind: 'dismiss';
      findingId: string;
      patch: ProposalReasonPatch;
      before: ProposalTriageBefore | null;
      baseUpdatedAt: number;
    })
  | (ProposalBase & {
      kind: 'restore';
      findingId: string;
      patch: ProposalReasonPatch;
      before: ProposalTriageBefore | null;
      baseUpdatedAt: number;
    })
  | (ProposalBase & {
      kind: 'create';
      /** 应用后回填新建 finding 的 id */
      findingId: string | null;
      patch: ReportFindingInput;
      before: null;
      baseUpdatedAt: null;
    });

/**
 * 这条提案是否已被后来的改动追上(只对 update 有意义 —— 它是唯一会覆盖正文字段的一档)。
 * dismiss/restore 写的是 triage 一格,重复应用不会丢信息,不必拦。
 *
 * `skipped` 与 `pending` 同样要判:忽略过的提案仍给「重新应用」,期间 finding 被编辑过的话,
 * 那一下照样是覆盖。只有 `applied` 不必判 —— 它已经落过库,当前值本就是它写的。
 */
export function isProposalStale(p: FindingProposal, finding: Finding | null): boolean {
  if (p.status === 'applied' || !finding) return false;
  if (p.kind === 'update') return finding.updatedAt !== p.baseUpdatedAt;
  // dismiss 不只是翻一格 triage,它还写理由:这条已被剔除且理由与提案的不同时,套用就是把
  // reviewer 自己写的那句顶掉。判据取「会不会真的替换掉一条不同的理由」而非 updatedAt ——
  // 后者会被任何无关写入推高(改个标题就算),那样等于逢点必警。
  if (p.kind === 'dismiss')
    return finding.triage === 'dismiss' && (finding.dismissReason ?? '') !== p.patch.reason;
  // restore 只把 triage 翻回 open 并清掉理由 —— 那正是「恢复」本来的语义(见 setTriage),不算覆盖
  return false;
}

/**
 * 已应用的提案是否**不再能安全撤销** —— finding 在应用之后又被改动过。
 *
 * 撤销写的是应用前的旧值,只有当前值仍是这条提案写下的那些值时才成立:
 * 提案把 severity 降到 medium、reviewer 随后手动改成 low,再撤销就会把它顶回 high,
 * 而这既不是提案的功劳也不是他要的。判据是逐字段比对而非 updatedAt ——
 * 后者会被任何无关写入(如另一条提案改标题)推高,一律拦下等于永远不给撤销。
 *
 * 与 {@link isProposalStale} 是同一件事的两头:那条管「还没应用的还能不能套上去」,
 * 这条管「已经应用的还能不能收回来」。
 */
export function isProposalUndoBlocked(p: FindingProposal, finding: Finding | null): boolean {
  if (p.status !== 'applied' || p.kind === 'create' || !p.before) return false;
  if (!finding) return true;
  if (p.kind === 'update') {
    return (Object.keys(p.patch) as (keyof ProposalUpdatePatch)[]).some(
      (k) => (finding[k] ?? null) !== (p.patch[k] ?? null),
    );
  }
  if (p.kind === 'dismiss')
    return finding.triage !== 'dismiss' || (finding.dismissReason ?? '') !== p.patch.reason;
  return finding.triage !== 'open';
}

// ---- Persisted UI state(见 docs/design/architecture.md 持久化表)----
export interface UiSettings {
  dataMode: 'light' | 'dark';
  dataTheme: 'duetlens' | 'github' | 'parchment';
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

/**
 * 审核历史保留窗口:最后更新早于此时长的会话在启动时清掉,不看状态(未完成/未提交同样过期)。
 * 放在 shared 是因为历史屏要把这条策略说给用户听 —— 后端清理与前端说明必须是同一个数。
 */
export const REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const REVIEW_RETENTION_DAYS = REVIEW_RETENTION_MS / 86_400_000;

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
