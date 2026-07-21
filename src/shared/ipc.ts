/**
 * IPC 契约:main(Node 后端)与 renderer(React)之间的唯一通道定义。
 * preload 经 contextBridge 暴露 `window.duetlens`,renderer 只依赖这里的类型。
 */
import type {
  Discussion,
  Finding,
  Message,
  Review,
  ReviewUiState,
  SourceKind,
  Triage,
  UiSettings,
} from './domain';
import type { DiffFile } from './diff';
import type { AgentEvent } from './agent-events';

// ---- 请求/响应(ipcRenderer.invoke ↔ ipcMain.handle)----
export const IpcChannels = {
  appGetInfo: 'app:get-info',
  reviewList: 'review:list',
  reviewGet: 'review:get',
  reviewFindings: 'review:findings',
  reviewDiff: 'review:diff',
  reviewStart: 'review:start',
  reviewStartDemo: 'review:start-demo',
  reviewResume: 'review:resume',
  reviewRelease: 'review:release',
  reviewDiscussions: 'review:discussions',
  reviewMessages: 'review:messages',
  reviewAddDiscussion: 'review:add-discussion',
  reviewSendMessage: 'review:send-message',
  reviewSetTriage: 'review:set-triage',
  reviewUpdateFinding: 'review:update-finding',
  reviewUpdateSummary: 'review:update-summary',
  reviewGetUiState: 'review:get-ui-state',
  reviewSaveUiState: 'review:save-ui-state',
  uiGetSettings: 'ui:get-settings',
  uiSaveSettings: 'ui:save-settings',
  dialogPickDirectory: 'dialog:pick-directory',
} as const;

/** 发起一次真实审核的目标(对应 backend ReviewTarget;repoPath 对 github-pr 可省)。 */
export interface ReviewStartInput {
  source: SourceKind;
  /** github-pr: PR url / owner/repo#123 / 号;local-branch: 分支名(空=当前 HEAD) */
  ref: string;
  repoPath?: string;
  /** local-branch diff 基线;缺省自动探测默认分支 */
  baseRef?: string;
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

/** 后端 → renderer 单向推送(webContents.send) */
export const IpcEvents = {
  reviewEvent: 'review:event',
} as const;

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
  | { reviewId: string; type: 'finding'; payload: Finding }
  | { reviewId: string; type: 'message'; payload: Message }
  | { reviewId: string; type: 'discussion'; payload: Discussion }
  | { reviewId: string; type: 'review'; payload: Review }
  | { reviewId: string; type: 'status'; payload: Review['status'] }
  | { reviewId: string; type: 'agent'; payload: AgentEvent };

/** contextBridge 暴露到 renderer 的 API 形状。 */
export interface DuetlensApi {
  getAppInfo(): Promise<AppInfo>;
  review: {
    list(): Promise<Review[]>;
    get(id: string): Promise<Review | null>;
    findings(reviewId: string): Promise<Finding[]>;
    /** 本次改动的结构化 diff(DiffPane 渲染);未缓存返回空数组。 */
    diff(reviewId: string): Promise<DiffFile[]>;
    discussions(reviewId: string): Promise<Discussion[]>;
    messages(discussionId: string): Promise<Message[]>;
    /** 对真实 target 发起审核;立即返回 review,首轮扫描后台跑、findings 经事件流入。 */
    start(input: ReviewStartInput): Promise<Review>;
    /** 起一个内置 fixture 的演示审核;立即返回 review,findings 经事件流入。 */
    startDemo(): Promise<Review>;
    /** 续接一个非活跃 review(app 重启后按 codexThreadId 恢复会话),之后可追问。 */
    resume(reviewId: string): Promise<Review>;
    /** 释放某 review 的活跃会话(codex 子进程 + MCP);下次追问自动续接。 */
    release(reviewId: string): Promise<void>;
    /** 新建用户发起、锚定代码位置的 discussion。 */
    addDiscussion(reviewId: string, anchor: DiscussionAnchor): Promise<Discussion>;
    /** 就某条 discussion 向 agent 追问;返回 agent 回复(无文本时返回用户消息)。 */
    sendMessage(reviewId: string, discussionId: string, text: string): Promise<Message>;
    /** 用户裁决某条 finding(保留/剔除/复位);落库后经事件流回推更新。 */
    setTriage(reviewId: string, findingId: string, triage: Triage): Promise<Finding>;
    /** 用户就地编辑 finding 可编辑字段(与 codex update_finding 同一落库路径)。 */
    updateFinding(reviewId: string, input: FindingEditInput): Promise<Finding>;
    /** 编辑审核总结正文(提交屏 review body 来源);落库后返回并经 `review` 事件回推。 */
    updateSummary(reviewId: string, body: string): Promise<Review>;
    /** 读某 review 的 per-review UI 进度态(已看文件等);无记录返回默认空态。 */
    getUiState(reviewId: string): Promise<ReviewUiState>;
    /** 写某 review 的 per-review UI 进度态(前端去抖调用)。 */
    saveUiState(reviewId: string, state: ReviewUiState): Promise<void>;
    /** 订阅领域事件;返回取消订阅函数。 */
    onEvent(handler: (e: ReviewEvent) => void): () => void;
  };
  ui: {
    getSettings(): Promise<UiSettings>;
    saveSettings(settings: UiSettings): Promise<void>;
  };
  dialog: {
    /** 打开系统目录选择器,返回所选绝对路径(取消返回 null)。 */
    pickDirectory(): Promise<string | null>;
  };
}
