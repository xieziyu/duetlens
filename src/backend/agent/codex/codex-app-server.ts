import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveTool } from '../../config/tool-paths';
import { JsonRpcConnection } from './jsonrpc';
import { isApprovalPolicyUnsupported } from '@shared/codex';
import {
  CLIENT_CAPABILITIES,
  CodexMethod,
  CodexServerRequest,
  DECLINE_BY_METHOD,
  LEGACY_READ_ONLY_APPROVAL,
  READ_ONLY_APPROVAL,
  type AskForApproval,
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
  /** 协商下来的审批策略;认过一次就不再重试(策略随连接,不随 thread) */
  private approvalPolicy?: AskForApproval;

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

  /**
   * 握手。**一条连接只握一次**(再来一次是 `-32600 Already initialized`),所以这里没有
   * 「先试后退」的余地 —— 能力声明只能一次发对。发的是 {@link CLIENT_CAPABILITIES},
   * 不认识它的旧版 codex 会把整个字段当未知字段丢掉,不必按版本分叉。
   */
  async initialize(clientInfo: InitializeParams['clientInfo']): Promise<unknown> {
    return this.rpcOrThrow().request(CodexMethod.initialize, {
      clientInfo,
      capabilities: CLIENT_CAPABILITIES,
    });
  }

  async listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.rpcOrThrow().request<ModelListResponse>(CodexMethod.modelList, params);
  }

  /**
   * 把「只读且静默」翻成本机 codex 认的那种说法:先要 {@link READ_ONLY_APPROVAL}(granular),
   * 被拒再退 {@link LEGACY_READ_ONLY_APPROVAL}。`start` 会被调一次或两次,收到策略后自己发
   * thread/start 或 thread/resume。
   *
   * 为什么退得起:握手不能重来(一条连接只 initialize 一次),但 thread/start 被拒时并没有
   * 建出 thread,原地换个说法重发既安全也不烧 token。
   *
   * **退的条件是拒绝的形状像「策略不认」**(判据与其宽窄的取舍见 `isApprovalPolicyUnsupported`
   * —— 它有意认下所有 serde 形状拒绝,不止点名 granular 的那句)。不放宽成「任何错误都退」:
   * 真退错了,拿到的会是最难查的那种失败 —— 会话建得起来、turn 跑得完、一条 finding 都回不来。
   * 退不动时抛第二次的错 —— 那次用的是最保守的说法,更接近真因。
   *
   * 退回后**并非无人看管**:若那个版本上 `'never'` 恰好连 MCP 调用一并拒了,ReviewSession
   * 对未送达调用的兜底会把这一轮判死(见 `MCP_UNDELIVERED_CODE`),不会静默变成 0 findings。
   */
  async withReadOnlyApproval<T>(start: (approvalPolicy: AskForApproval) => Promise<T>): Promise<T> {
    if (this.approvalPolicy) return start(this.approvalPolicy);
    try {
      const res = await start(READ_ONLY_APPROVAL);
      this.approvalPolicy = READ_ONLY_APPROVAL;
      return res;
    } catch (e) {
      const message = (e as Error).message;
      if (!isApprovalPolicyUnsupported(message)) throw e;
      this.opts.onLog?.(
        `codex 不认 granular 审批策略(${message}),退回 ${LEGACY_READ_ONLY_APPROVAL}`,
      );
      const res = await start(LEGACY_READ_ONLY_APPROVAL);
      this.approvalPolicy = LEGACY_READ_ONLY_APPROVAL;
      return res;
    }
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
