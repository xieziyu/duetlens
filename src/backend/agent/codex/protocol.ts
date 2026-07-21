/**
 * codex app-server 协议的最小子集(手写,对齐 codex-cli 0.144.1 `generate-ts` 导出)。
 * 只覆盖 Duetlens spike/骨架用到的方法与事件;全量类型可用
 *   `codex app-server generate-ts --out <DIR>`(见 npm script `codex:gen-types`)
 * 重导比对。协议标 experimental,升级 codex 后应重新导出回归。
 */

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

export interface ThreadStartResponse {
  thread: { id: string; sessionId: string; [k: string]: unknown };
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

export interface ThreadResumeResponse {
  thread: { id: string; [k: string]: unknown };
  model: string;
  cwd: string;
  [k: string]: unknown;
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
  execCommandApproval: 'execCommandApproval',
  applyPatchApproval: 'applyPatchApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
} as const;

/** server→client 单向通知(流事件) */
export const CodexNotification = {
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  mcpToolCallProgress: 'item/mcpToolCall/progress',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  mcpServerStartupStatus: 'mcpServer/startupStatus/updated',
} as const;

/** item/started · item/completed 携带的 ThreadItem 的 type 判别(只列用到的支)。 */
export const CodexItemType = {
  mcpToolCall: 'mcpToolCall',
  /** auto-compact 完成/开始经此 item 观测(deprecated `thread/compacted` 通知不再用)。 */
  contextCompaction: 'contextCompaction',
} as const;

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
}
