/**
 * codex app-server 协议的最小子集(手写,对齐 `generate-ts` 导出;
 * 对齐到哪个版本见 shared/codex.ts 的 `CODEX_TARGET_VERSION`)。
 * 只覆盖 Duetlens spike/骨架用到的方法与事件;全量类型可用
 *   `codex app-server generate-ts --out <DIR>`(见 npm script `codex:gen-types`)
 * 重导比对。协议标 experimental,升级 codex 后应重新导出回归。
 */
import type { AgentErrorKind } from '@shared/agent-events';

// ---- 枚举(与 v2/SandboxMode、v2/AskForApproval 一致)----
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

// ---- initialize ----
export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
}

// ---- thread/start ----
export interface ThreadStartParams {
  cwd?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  /** 透传 config.toml 形状的覆盖;MCP 注入放这里:{ mcp_servers: { duetlens: { url } } } */
  config?: Record<string, unknown>;
  baseInstructions?: string;
  model?: string;
  ephemeral?: boolean;
}

/**
 * thread/start 与 thread/resume 都会**回显本次生效的策略**(形状与请求不同:请求送
 * `sandbox: 'read-only'` 这个 SandboxMode,应答回的是 SandboxPolicy 结构体)。
 * 这几个字段是只读注入能否被证实的唯一途径,见 {@link SANDBOX_NOT_APPLIED_CODE}。
 */
export interface EffectiveThreadPolicy {
  approvalPolicy?: string;
  sandbox?: { type?: string; [k: string]: unknown } | null;
}

export interface ThreadStartResponse extends EffectiveThreadPolicy {
  thread: { id: string; sessionId: string; cliVersion?: string; [k: string]: unknown };
  model: string;
  cwd: string;
  [k: string]: unknown;
}

// ---- thread/resume(按 threadId 从磁盘续接已存在的会话;可选项与 start 同构)----
export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  /** 覆盖持久化模型;缺省 codex 复用 thread 落库的 model/effort */
  model?: string;
}

export interface ThreadResumeResponse extends EffectiveThreadPolicy {
  thread: { id: string; cliVersion?: string; [k: string]: unknown };
  model: string;
  cwd: string;
  [k: string]: unknown;
}

// ---- model/list(列举账号可用模型;initialize 后即可调,复用本机登录,不烧 token)----
export interface ModelListParams {
  cursor?: string | null;
  includeHidden?: boolean | null;
  limit?: number | null;
}

/** 只取 Duetlens 用得到的字段;codex 侧字段更多(见 generate-ts 的 Model)。 */
export interface CodexModel {
  /** 传给 thread/start 的模型标识 */
  model: string;
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor?: string | null;
}

// ---- turn/start ----
export type UserInput = { type: 'text'; text: string; text_elements?: unknown[] };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  clientUserMessageId?: string;
}

export interface TurnStartResponse {
  turn: { id: string; status: string; [k: string]: unknown };
}

// ---- turn/interrupt ----

/**
 * 打断是**针对某一个 turn** 的:`turnId` 必填,少了会在参数反序列化阶段就被
 * `-32600 Invalid request` 顶回来,根本走不到打断逻辑。
 */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * turn 失败的载荷:`turn/completed`(status=failed)与 `error` 通知共用同一形状。
 * `codexErrorInfo` 是 codex 对失败的归因,取值可能是裸字符串,也可能是带 httpStatusCode
 * 的单键对象 —— 归一见 {@link codexErrorKind}。
 */
export interface CodexTurnError {
  message: string;
  codexErrorInfo?: string | Record<string, unknown> | null;
  additionalDetails?: string | null;
}

/** `error` 通知:codex 自己还会重试时 willRetry=true,之后才会有终局的 turn/completed。 */
export interface CodexErrorNotification {
  error: CodexTurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

/** codexErrorInfo → 我们的中立归因;未知一律 'other',不臆造分类。 */
export function codexErrorKind(info: CodexTurnError['codexErrorInfo']): AgentErrorKind {
  const tag = typeof info === 'string' ? info : info ? Object.keys(info)[0] : '';
  switch (tag) {
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return 'usage-limit';
    case 'contextWindowExceeded':
      return 'context-exceeded';
    case 'serverOverloaded':
    case 'internalServerError':
    case 'responseTooManyFailedAttempts':
      return 'server-overloaded';
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return 'connection';
    case 'unauthorized':
      return 'unauthorized';
    case 'badRequest':
    case 'cyberPolicy':
      return 'bad-request';
    default:
      return 'other';
  }
}

// ---- 反向请求:MCP 工具调用前的 elicitation(必须应答否则 turn 卡死)----
export interface McpServerElicitationRequestParams {
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'form' | 'openai/form' | 'url';
  message?: string;
  _meta?: unknown;
  [k: string]: unknown;
}

export type McpServerElicitationAction = 'accept' | 'decline' | 'cancel';

export interface McpServerElicitationRequestResponse {
  action: McpServerElicitationAction;
  content: unknown | null;
  _meta: unknown | null;
}

// ---- 方法 / 事件名(字符串常量,避免拼写漂移)----
export const CodexMethod = {
  initialize: 'initialize',
  modelList: 'model/list',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  turnSteer: 'turn/steer',
  compactStart: 'thread/compact/start',
} as const;

/** server→client 反向请求(需应答) */
export const CodexServerRequest = {
  mcpElicitation: 'mcpServer/elicitation/request',
  /** legacy 命名;v2 turn 走的是 commandExecutionApproval,两套都还在表里,故都要认 */
  execCommandApproval: 'execCommandApproval',
  applyPatchApproval: 'applyPatchApproval',
  commandExecutionApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
} as const;

/**
 * 拒绝一次审批要按**该方法自己的应答类型**说,不同族的说法不一样,没有通用的 `denied`:
 * - legacy(exec/applyPatch)是 `ReviewDecision`,拒绝是对象变体 `{ denied: { rejection } }`;
 * - v2(commandExecution/fileChange)是各自的 decision 枚举,拒绝一律是 `'decline'`;
 * - permissions 的应答里**根本没有 decision 字段**(要回一份授权档),表达不了拒绝 —— 只能回错误。
 */
export const DECLINE_BY_METHOD: Readonly<Record<string, unknown>> = {
  [CodexServerRequest.execCommandApproval]: { decision: { denied: { rejection: '只读审核会话' } } },
  [CodexServerRequest.applyPatchApproval]: { decision: { denied: { rejection: '只读审核会话' } } },
  [CodexServerRequest.commandExecutionApproval]: { decision: 'decline' },
  [CodexServerRequest.fileChangeApproval]: { decision: 'decline' },
};

/** server→client 单向通知(流事件) */
export const CodexNotification = {
  error: 'error',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  mcpToolCallProgress: 'item/mcpToolCall/progress',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  /** 推理摘要的流式文本。协议有,但实测在我们的会话里从不到货 —— 判据见 spike:reasoning。 */
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
  mcpServerStartupStatus: 'mcpServer/startupStatus/updated',
} as const;

/** item/started · item/completed 携带的 ThreadItem 的 type 判别(只列用到的支)。 */
export const CodexItemType = {
  mcpToolCall: 'mcpToolCall',
  /** shell 命令。只读会话里全是取证动作,是「agent 在读哪个文件」的主要来源。 */
  commandExecution: 'commandExecution',
  webSearch: 'webSearch',
  /** auto-compact 完成/开始经此 item 观测(deprecated `thread/compacted` 通知不再用)。 */
  contextCompaction: 'contextCompaction',
} as const;

/**
 * codex 对一条命令的 best-effort 解析:一条 shell 行经管道可拆成多段,故是数组。
 * 我们不自己解析命令 —— 解析错就是往界面上报假动作。
 */
export type CodexCommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path?: string | null }
  | { type: 'search'; command: string; query?: string | null; path?: string | null }
  | { type: 'unknown'; command: string };

export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  status: string;
  commandActions?: CodexCommandAction[];
  durationMs?: number | null;
}

export interface WebSearchThreadItem {
  type: 'webSearch';
  id: string;
  query: string;
}

/**
 * item/started · item/completed 携带的 ThreadItem 里,MCP 工具调用这一支的形状。
 * codex 0.144.1 无独立 item/mcpToolCall 方法,工具调用经 item 生命周期通知观测。
 */
export interface McpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status: string;
  arguments?: unknown;
  durationMs?: number | null;
}
