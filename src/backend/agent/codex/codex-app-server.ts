import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveTool } from '../../config/tool-paths';
import { JsonRpcConnection } from './jsonrpc';
import {
  CodexMethod,
  CodexServerRequest,
  DECLINE_BY_METHOD,
  type InitializeParams,
  type McpServerElicitationRequestParams,
  type McpServerElicitationRequestResponse,
  type ModelListParams,
  type ModelListResponse,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResponse,
} from './protocol';

export interface CodexAppServerOptions {
  codexBin?: string;
  cwd?: string;
  /** 覆盖 CODEX_HOME(测试隔离用) */
  codexHome?: string;
  /** 视为受信、其 elicitation 自动 accept 的 MCP server 名(如自建 duetlens) */
  trustedMcpServers?: string[];
  onLog?: (line: string) => void;
}

/**
 * codex `app-server` 的薄封装:管子进程生命周期、JSON-RPC 收发、反向审批。
 * 是 ConversationalAgent 的底座;不让 codex 协议细节渗出到上层。
 *
 * 事件:
 *   'notification' (method, params) — 所有流事件透传
 *   'elicitation'  (params, decision) — 观测到 elicitation 及我们的处置
 *   'error'        (err)
 */
export class CodexAppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcConnection;
  private readonly trusted: Set<string>;

  constructor(private readonly opts: CodexAppServerOptions = {}) {
    super();
    this.trusted = new Set(opts.trustedMcpServers ?? []);
  }

  start(extraEnv?: Record<string, string>): void {
    const bin = this.opts.codexBin ?? resolveTool('codex');
    const env = { ...process.env, ...extraEnv };
    if (this.opts.codexHome) env.CODEX_HOME = this.opts.codexHome;

    this.child = spawn(bin, ['app-server', '--stdio'], {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => this.opts.onLog?.(d.trimEnd()));
    this.child.on('exit', (code) => this.emit('exit', code));
    this.child.on('error', (e) => this.emit('error', e));

    this.rpc = new JsonRpcConnection(this.child.stdin, this.child.stdout, {
      onNotification: (method, params) => this.emit('notification', method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onError: (e) => this.emit('error', e),
    });
  }

  async initialize(clientInfo: InitializeParams['clientInfo']): Promise<unknown> {
    return this.rpcOrThrow().request(CodexMethod.initialize, { clientInfo });
  }

  async listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.rpcOrThrow().request<ModelListResponse>(CodexMethod.modelList, params);
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpcOrThrow().request<ThreadStartResponse>(CodexMethod.threadStart, params);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpcOrThrow().request<ThreadResumeResponse>(CodexMethod.threadResume, params);
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpcOrThrow().request<TurnStartResponse>(CodexMethod.turnStart, params);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<unknown> {
    return this.rpcOrThrow().request(CodexMethod.turnInterrupt, params);
  }

  stop(): void {
    this.rpc?.close();
    this.child?.kill('SIGTERM');
  }

  private rpcOrThrow(): JsonRpcConnection {
    if (!this.rpc) throw new Error('CodexAppServer 未 start()');
    return this.rpc;
  }

  /**
   * 反向请求处理。**架构必需件**:elicitation 不应答则 turn 卡死。
   * - 自建受信 MCP 工具的 elicitation → 自动 accept。
   * - 各类审批 → review-only 应用一律拒绝(只读 sandbox 下本不该出现),并抛给上层观测。
   *
   * 拒绝的说法按方法族取自 {@link DECLINE_BY_METHOD};表里没有的(permissions、
   * 以及将来新增的反向请求)应答形状我们并不知道,**猜一个结构回过去等于回了句听不懂的话** ——
   * 一律回 JSON-RPC 错误,让 codex 明确收到「这边不接」。
   */
  private handleServerRequest(method: string, params: unknown): unknown {
    if (method === CodexServerRequest.mcpElicitation) {
      const p = params as McpServerElicitationRequestParams;
      const trusted = this.trusted.has(p.serverName);
      const decision: McpServerElicitationRequestResponse = trusted
        ? { action: 'accept', content: null, _meta: null }
        : { action: 'decline', content: null, _meta: null };
      this.emit('elicitation', p, decision.action);
      return decision;
    }

    this.emit('unexpected-approval', method, params);
    const decline = DECLINE_BY_METHOD[method];
    if (decline === undefined) throw new Error(`只读审核会话不接受反向请求: ${method}`);
    return decline;
  }
}
