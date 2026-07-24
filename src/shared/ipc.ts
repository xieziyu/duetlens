/**
 * IPC 契约:main(Node 后端)与 renderer(React)之间的唯一通道定义。
 * preload 经 contextBridge 暴露 `window.duetlens`,renderer 只依赖这里的类型。
 */
import type {
  CodexModelInfo,
  Discussion,
  Finding,
  Message,
  ReasoningEffort,
  Review,
  ReviewIntensity,
  ReviewRound,
  ReviewUiState,
  SourceKind,
  Triage,
  UiSettings,
} from './domain';
import type { DiffFile } from './diff';
import type { AgentEvent } from './agent-events';
import type { GhReviewEvent } from './github-review';
import type { PromptSaveInput, ReviewPromptView } from './prompt';
import type { EnvCheckOptions, EnvironmentReport } from './environment';
import type {
  GitButlerStatus,
  LocalBranchList,
  PrPreview,
  PrSummary,
  RepoRemoteInfo,
} from './source-discovery';

// ---- 请求/响应(ipcRenderer.invoke ↔ ipcMain.handle)----
export const IpcChannels = {
  appGetInfo: 'app:get-info',
  appCheckEnvironment: 'app:check-environment',
  reviewList: 'review:list',
  reviewListRecent: 'review:list-recent',
  reviewGet: 'review:get',
  reviewFindings: 'review:findings',
  reviewDiff: 'review:diff',
  reviewFileContent: 'review:file-content',
  reviewStart: 'review:start',
  reviewRerun: 'review:rerun',
  reviewRounds: 'review:rounds',
  reviewResume: 'review:resume',
  reviewRelease: 'review:release',
  reviewDelete: 'review:delete',
  reviewDiscussions: 'review:discussions',
  reviewMessages: 'review:messages',
  reviewAddDiscussion: 'review:add-discussion',
  reviewSendMessage: 'review:send-message',
  reviewClearDiscussion: 'review:clear-discussion',
  reviewSetTriage: 'review:set-triage',
  reviewSetFindingAnchor: 'review:set-finding-anchor',
  reviewAddFinding: 'review:add-finding',
  reviewPromoteDiscussion: 'review:promote-discussion',
  reviewUpdateFinding: 'review:update-finding',
  reviewUpdateSummary: 'review:update-summary',
  reviewSubmit: 'review:submit',
  reviewOpenInBrowser: 'review:open-in-browser',
  reviewGetUiState: 'review:get-ui-state',
  reviewSaveUiState: 'review:save-ui-state',
  uiGetSettings: 'ui:get-settings',
  uiSaveSettings: 'ui:save-settings',
  agentListModels: 'agent:list-models',
  sourceCheckGhAuth: 'source:check-gh-auth',
  sourcePreviewPr: 'source:preview-pr',
  sourceListOpenPrs: 'source:list-open-prs',
  sourceGetRepoRemote: 'source:get-repo-remote',
  sourceInferLocalRepo: 'source:infer-local-repo',
  sourceListLocalBranches: 'source:list-local-branches',
  sourceDetectGitButler: 'source:detect-gitbutler',
  promptGet: 'prompt:get',
  promptSave: 'prompt:save',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickFile: 'dialog:pick-file',
  dialogSaveTextFile: 'dialog:save-text-file',
} as const;

/** 发起一次真实审核的目标(对应 backend ReviewTarget;repoPath 对 github-pr 可省)。 */
export interface ReviewStartInput {
  source: SourceKind;
  /** github-pr: PR url / owner/repo#123 / 号;local-branch: 分支名(空=当前 HEAD) */
  ref: string;
  repoPath?: string;
  /** local-branch diff 基线;缺省自动探测默认分支 */
  baseRef?: string;
  /** codex 模型(空=账号默认) */
  model?: string;
  /** reasoning effort(缺省 codex medium) */
  reasoningEffort?: ReasoningEffort;
  /** 审核强度(缺省 standard) */
  intensity?: ReviewIntensity;
  /** 用户给 agent 的附加上下文,随首轮机审注入(可选) */
  context?: string;
}

/** 发起一轮重跑的入参。 */
export interface RerunInput {
  /** reviewer 对本轮的额外说明(如「重点看并发那块」),随复审指令注入 */
  note?: string;
  /** 本轮起调整审核强度;缺省沿用 review 现有档。给出即持久化为 review 新档,后续轮次/续接沿用 */
  intensity?: ReviewIntensity;
}

/** 交给系统默认浏览器打开的结果;失败原因回前端做提示,不抛异常。 */
export interface OpenExternalResult {
  ok: boolean;
  url?: string;
  message?: string;
}

/** 入口「最近的审核」列表项:review 附带 finding/discussion/已提交计数(展示用)。 */
export interface RecentReview extends Review {
  findingCount: number;
  /** 用户发起的 discussion 数(不含 finding 承载的 discussion) */
  discussionCount: number;
  submittedCount: number;
}

/** 用户就地编辑一条 finding 的可编辑字段(缺省字段不改;suggestion 传 null 清空)。 */
export interface FindingEditInput {
  findingId: string;
  severity?: Finding['severity'];
  category?: string | null;
  title?: string;
  body?: string;
  suggestion?: string | null;
}

/** 用户发起 discussion 的锚点。 */
export interface DiscussionAnchor {
  file: string;
  line: number;
  lineEnd?: number | null;
}

/** 用户手动新增一条 finding(origin=manual;锚点由 diff 框选/行内选定,字段就地填写)。 */
export interface AddFindingInput {
  file: string;
  line: number;
  severity: Finding['severity'];
  category?: string | null;
  title: string;
  body?: string;
  suggestion?: string | null;
}

/** 提交一次 GitHub PR review 的入参(summaryBody 传入即先落库为 review body)。 */
export interface SubmitReviewInput {
  event: GhReviewEvent;
  summaryBody?: string;
}

/** 提交结果:PR review 原子提交,故只有整体成功 / 行锚点失效(422)/ 整体失败。 */
export type SubmitReviewResult =
  | { status: 'success'; url: string; submittedCount: number }
  | { status: 'invalid'; message: string }
  | { status: 'failed'; message: string };

/** 后端 → renderer 单向推送(webContents.send) */
export const IpcEvents = {
  reviewEvent: 'review:event',
  /** 原生通知点击后主进程回推:打开该 review */
  notifyOpenReview: 'notify:open-review',
  /** 窗口聚焦时的应用内轻提示(不弹原生通知) */
  notifyInApp: 'notify:in-app',
} as const;

/** 长任务完成提示的载荷(扫描完成 / 追问回复);原生通知与应用内提示共用。 */
export interface CompletionNotice {
  reviewId: string;
  kind: 'scan-done' | 'reply';
  title: string;
  body: string;
  /** 追问回复所属的 discussion;点击通知时用于定位到具体线程(scan-done 无) */
  discussionId?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
}

/** 一次 review 生命周期里推给 renderer 的领域事件。 */
export type ReviewEvent =
  | { reviewId: string; type: 'round'; payload: ReviewRound }
  | { reviewId: string; type: 'finding'; payload: Finding }
  | { reviewId: string; type: 'message'; payload: Message }
  | { reviewId: string; type: 'messages-cleared'; discussionId: string }
  | { reviewId: string; type: 'discussion'; payload: Discussion }
  | { reviewId: string; type: 'review'; payload: Review }
  | { reviewId: string; type: 'status'; payload: Review['status'] }
  | { reviewId: string; type: 'agent'; payload: AgentEvent };

/** contextBridge 暴露到 renderer 的 API 形状。 */
export interface DuetlensApi {
  getAppInfo(): Promise<AppInfo>;
  /** 首启环境自检(codex / app-server / gh);deep=true 才做 app-server 连通深检。 */
  checkEnvironment(opts?: EnvCheckOptions): Promise<EnvironmentReport>;
  review: {
    list(): Promise<Review[]>;
    /** 入口「最近的审核」:review 附带 finding/discussion/已提交计数。 */
    listRecent(): Promise<RecentReview[]>;
    get(id: string): Promise<Review | null>;
    findings(reviewId: string): Promise<Finding[]>;
    /** 本次改动的结构化 diff(DiffPane 渲染);未缓存返回空数组。 */
    diff(reviewId: string): Promise<DiffFile[]>;
    /** 读被审文件新侧完整内容(供 DiffPane 展开 diff 外上下文);读不到返回 null。 */
    fileContent(reviewId: string, path: string): Promise<string | null>;
    discussions(reviewId: string): Promise<Discussion[]>;
    messages(discussionId: string): Promise<Message[]>;
    /** 对真实 target 发起审核;立即返回 review,首轮扫描后台跑、findings 经事件流入。 */
    start(input: ReviewStartInput): Promise<Review>;
    /**
     * 再跑一轮机审:重拉最新 diff 全量重扫,并带上「上轮 findings + reviewer 处置 + GitHub 评论」。
     * 立即返回新轮次记录,扫描后台跑。上一轮仍在扫描中时抛错。
     */
    rerun(reviewId: string, input?: RerunInput): Promise<ReviewRound>;
    /** 该 review 的轮次履历(首轮 + 每次重跑),用于展示轮次与各轮统计。 */
    rounds(reviewId: string): Promise<ReviewRound[]>;
    /** 续接一个非活跃 review(app 重启后按 codexThreadId 恢复会话),之后可追问。 */
    resume(reviewId: string): Promise<Review>;
    /** 释放某 review 的活跃会话(codex 子进程 + MCP);下次追问自动续接。 */
    release(reviewId: string): Promise<void>;
    /** 删除一次审核(级联清理 findings/discussions/messages 等);历史屏用。 */
    delete(reviewId: string): Promise<void>;
    /** 新建用户发起、锚定代码位置的 discussion。 */
    addDiscussion(reviewId: string, anchor: DiscussionAnchor): Promise<Discussion>;
    /** 就某条 discussion 向 agent 追问;返回 agent 回复(无文本时返回用户消息)。 */
    sendMessage(reviewId: string, discussionId: string, text: string): Promise<Message>;
    /** 清空一条 discussion 的往来消息(finding 卡保留);经 `messages-cleared` 事件回推。 */
    clearDiscussion(reviewId: string, discussionId: string): Promise<void>;
    /**
     * 用户裁决某条 finding(保留/剔除/复位);落库后经事件流回推更新。
     * reason 只在剔除时有意义(可选),会注入下一轮复审让 agent 不再报同类问题;恢复时自动清空。
     */
    setTriage(reviewId: string, findingId: string, triage: Triage, reason?: string | null): Promise<Finding>;
    /** 改一条 finding 的行锚点(提交屏修 422 失效锚点):line>0 改锚,line=0 脱锚(降级为摘要)。 */
    setFindingAnchor(reviewId: string, findingId: string, line: number): Promise<Finding>;
    /** 用户手动新增一条锚定 finding(origin=manual),同 agent finding 的 schema/提交路径。 */
    addFinding(reviewId: string, input: AddFindingInput): Promise<Finding>;
    /** 把一条用户 discussion 提升为 finding(origin=promoted),保留会话历史;返回新 finding。 */
    promoteDiscussion(reviewId: string, discussionId: string): Promise<Finding>;
    /** 用户就地编辑 finding 可编辑字段(与 codex update_finding 同一落库路径)。 */
    updateFinding(reviewId: string, input: FindingEditInput): Promise<Finding>;
    /** 编辑审核总结正文(提交屏 review body 来源);落库后返回并经 `review` 事件回推。 */
    updateSummary(reviewId: string, body: string): Promise<Review>;
    /** 把保留且未提交的 findings 组成一次 GitHub PR review 原子提交(仅 github-pr source)。 */
    submit(reviewId: string, input: SubmitReviewInput): Promise<SubmitReviewResult>;
    /** 用系统默认浏览器打开该 review 的来源页面(目前仅 github-pr 有网页可开)。 */
    openInBrowser(reviewId: string): Promise<OpenExternalResult>;
    /** 读某 review 的 per-review UI 进度态(已看文件等);无记录返回默认空态。 */
    getUiState(reviewId: string): Promise<ReviewUiState>;
    /** 写某 review 的 per-review UI 进度态(前端去抖调用)。 */
    saveUiState(reviewId: string, state: ReviewUiState): Promise<void>;
    /** 订阅领域事件;返回取消订阅函数。 */
    onEvent(handler: (e: ReviewEvent) => void): () => void;
  };
  notifications: {
    /** 原生完成通知被点击 → 打开对应 review(reply 通知带 discussionId,可定位线程);返回取消订阅函数。 */
    onOpenReview(handler: (payload: { reviewId: string; discussionId?: string }) => void): () => void;
    /** 窗口聚焦时的应用内轻提示(扫描完成/追问回复);返回取消订阅函数。 */
    onInApp(handler: (notice: CompletionNotice) => void): () => void;
  };
  ui: {
    getSettings(): Promise<UiSettings>;
    saveSettings(settings: UiSettings): Promise<void>;
  };
  agent: {
    /** 列举账号可用的 codex 模型(供发起表单下拉);未登录/出错时抛错,前端降级为手填。 */
    listModels(): Promise<CodexModelInfo[]>;
  };
  /** 入口发起页的来源发现(三来源的预检/列举);均只读、不进入 review 生命周期。 */
  source: {
    /** 检测 gh CLI 是否已登录(github-pr 来源拉 diff/回写 review 依赖它)。 */
    checkGhAuth(): Promise<boolean>;
    /** 解析单个 PR 预览;ref 缺 owner/repo 时用 repoPath 推断。失败抛错(前端展示解析失败态)。 */
    previewPr(ref: string, repoPath?: string): Promise<PrPreview>;
    /** 列举某仓库最近的 open PR(nwo 或本地仓库路径二选一)。 */
    listOpenPrs(opts: { nwo?: string; repoPath?: string }): Promise<PrSummary[]>;
    /** 读某本地目录的 remote 归属(nameWithOwner);用于 PR 本地路径 remote-匹配校验。 */
    getRepoRemote(repoPath: string): Promise<RepoRemoteInfo>;
    /** 由 PR 的 owner/repo 反推本机已 clone 的仓库路径;找不到返回 null。 */
    inferLocalRepo(nwo: string): Promise<string | null>;
    /** 列举本地分支(相对 base 领先若干 commit)+ base 候选。 */
    listLocalBranches(repoPath: string, baseRef?: string): Promise<LocalBranchList>;
    /** 探测目录是否 GitButler workspace 并列举其虚拟分支。 */
    detectGitButler(repoPath: string): Promise<GitButlerStatus>;
  };
  prompt: {
    /** 读三层审核规则(project 需仓库 cwd,缺省则只有 global+builtin)。 */
    get(cwd?: string): Promise<ReviewPromptView>;
    /** 整层重写某可编辑层,回读并返回合并后的最新视图。 */
    save(input: PromptSaveInput): Promise<ReviewPromptView>;
  };
  dialog: {
    /** 打开系统目录选择器,返回所选绝对路径(取消返回 null)。 */
    pickDirectory(): Promise<string | null>;
    /** 打开系统文件选择器(选可执行文件,如 codex / gh),返回绝对路径(取消返回 null)。 */
    pickFile(): Promise<string | null>;
    /** 经系统保存对话框把文本写入本地文件(如 Markdown 报告);返回落盘路径,取消返回 null。 */
    saveTextFile(defaultName: string, content: string): Promise<string | null>;
  };
}
