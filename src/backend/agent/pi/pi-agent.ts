import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentErrorKind } from '@shared/agent-events';
import type { AgentModelInfo } from '@shared/domain';
import { PI_TOOLSET_NOT_READ_ONLY_CODE } from '@shared/ipc';
import { MCP_SERVER_NAME } from '@shared/mcp-contract';
import type {
  AgentEvent,
  ConversationHandle,
  ConversationalAgent,
  ResumeConversationOptions,
  StartConversationOptions,
} from '../conversational-agent';
import { PI_ENDPOINT_ENV, PI_TOKEN_ENV } from './duetlens-extension';
import { openPiBridge, type PiBridge, type PiHandshake } from './pi-bridge';
import { PiRpc, type PiMessage } from './pi-rpc';

/** extension 文件名;打包后在 Resources/pi/ 下(见 electron-builder.yml 的 extraResources)。 */
export const PI_EXTENSION_FILE = 'duetlens-extension.ts';

/**
 * extension 的实际路径。pi 在自己的 Node 进程里读它,**读不了 asar** —— 故打包后走
 * extraResources 落成散文件,开发期直接指源文件。
 */
export function piExtensionPath(env: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return env.packaged
    ? path.join(env.resourcesPath, 'pi', PI_EXTENSION_FILE)
    : path.join(env.appPath, 'src/backend/agent/pi', PI_EXTENSION_FILE);
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** abort 要等会话真正空闲才应答,比普通命令慢得多 */
const ABORT_TIMEOUT_MS = 60_000;

/**
 * 生效工具集里**白名单之外**的工具。只读判据是白名单而不是写工具黑名单:
 * 黑名单只挡得住叫得出名字的那几个,一个没见过的工具(新版内置、别处注册的)照样放行。
 * 拿不到工具集的情形不经过这里 —— 那在握手处就判死了。
 */
export function unexpectedPiTools(active: readonly string[], allowed: readonly string[]): string[] {
  return active.filter((t) => !allowed.includes(t));
}

/**
 * pi 的错误原文 → 领域档。pi 给的是 provider 的英文原句,不是错误码,只能按特征认;
 * 认不出就是 `other`,不硬猜。顺序即优先级:凭证与额度排在泛化的 4xx/5xx 之前。
 */
export function piErrorKind(text: string | undefined): AgentErrorKind {
  const t = text ?? '';
  if (/\b401\b|unauthori[sz]ed|authentication|api[ _-]?key|credential|not logged in/i.test(t))
    return 'unauthorized';
  if (/\b429\b|rate[ _-]?limit|quota|usage limit|credit balance/i.test(t)) return 'usage-limit';
  if (/context (length|window)|too many tokens|prompt is too long|maximum context/i.test(t))
    return 'context-exceeded';
  if (/\b5\d\d\b|overload|unavailable|internal server error/i.test(t)) return 'server-overloaded';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(t))
    return 'connection';
  if (/\b400\b|\b404\b|bad request|invalid_request|not found/i.test(t)) return 'bad-request';
  return 'other';
}

/** 零 token 探测的结果:pi 按自己的凭证能用哪些模型、缺省是哪个。 */
export interface PiProbe {
  models: AgentModelInfo[];
  /** pi 设置里的缺省模型(`provider/id`);没配时为空 */
  defaultModel: string | null;
}

interface PiModel {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
  baseUrl?: string;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 问 pi 能用哪些模型:起一次性 rpc 进程、`get_state` + `get_available_models` 后即关。
 * 不起会话、不发 prompt,故不烧 token。`get_available_models` 只列**配好凭证**的 provider
 * (`--list-models` 列的是全量 catalog,不能拿来判就绪),所以列表非空即说明至少一家能跑。
 */
export async function probePi(onLog?: (line: string) => void): Promise<PiProbe> {
  const rpc = new PiRpc({
    args: ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve'],
    cwd: os.homedir(),
    env: process.env,
    onLog,
  });
  try {
    const [state, list] = await Promise.all([
      rpc.send('get_state', {}, PROBE_TIMEOUT_MS),
      rpc.send('get_available_models', {}, PROBE_TIMEOUT_MS),
    ]);
    if (!list.success) throw new Error(`pi 列不出模型:${list.error ?? '未知原因'}`);
    const current = (state.data as { model?: PiModel | null } | undefined)?.model;
    const defaultModel = current ? `${current.provider}/${current.id}` : null;
    const raw = ((list.data as { models?: PiModel[] } | undefined)?.models ?? []).filter((m) => m.id && m.provider);
    return {
      defaultModel,
      models: raw.map((m) => {
        const model = `${m.provider}/${m.id}`;
        return {
          model,
          id: model,
          displayName: `${m.name || m.id} (${m.provider})`,
          // 按量计费,单价就是选模型时要看的那条信息
          description: describePiModel(m),
          isDefault: model === defaultModel,
        };
      }),
    };
  } finally {
    rpc.kill();
  }
}

/**
 * 线路要摆出来:同一个模型经不同 endpoint(官方直连 / 第三方中转)实测延迟能差 5–10 倍,
 * 而 Duetlens 判断不了哪家是中转,只能让选模型的人看见它走哪。
 */
function describePiModel(m: PiModel): string {
  const parts = [m.provider];
  const host = endpointHost(m.baseUrl);
  if (host) parts.push(host);
  if (m.contextWindow) parts.push(`${Math.round(m.contextWindow / 1000)}K ctx`);
  if (m.cost?.input != null && m.cost.output != null) parts.push(`$${m.cost.input}/$${m.cost.output} 每百万 token`);
  return parts.join(' · ');
}

function endpointHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

export interface PiAgentOptions {
  /** extension 文件路径,见 {@link piExtensionPath} */
  extensionPath: string;
  /** 会话存放目录;缺省用 pi 自己的(按 cwd 分目录) */
  sessionDir?: string;
  onLog?: (line: string) => void;
}

/** 一个 Duetlens turn 的在途状态。pi 自己的 turn 只是其中一段,见 ConversationalAgent。 */
interface TurnState {
  id: string;
  /** 见过本轮的 agent_start。在那之前到的 agent_settled 是启动时的,不属于任何一轮 */
  started: boolean;
  sawText: boolean;
  toolCalls: number;
  interrupted: boolean;
  last?: { stopReason?: string; errorMessage?: string };
}

/**
 * ConversationalAgent 的 pi 实现:`pi --mode rpc` 子进程 + extension 桥。
 *
 * 与 codex 那条的差异都是 pi 的协议形状逼出来的,各自就地说明:
 * turn id 自己编号(pi 只有会话级 abort)、只读靠工具白名单并以握手证实、
 * 失败要从终局消息与「空跑」结构性地派生(pi 没有失败事件)、用量要问(pi 不推送)。
 */
export class PiAgent extends EventEmitter implements ConversationalAgent {
  private rpc?: PiRpc;
  private bridge?: PiBridge;
  private promptDir?: string;
  private turn?: TurnState;
  private seq = 0;
  private disposed = false;
  private polling = false;
  /** toolCallId → 起跑时刻与参数;tool_execution_end 不带 args,收尾时要从这里取 */
  private readonly calls = new Map<string, { at: number; args: Record<string, unknown> }>();

  constructor(private readonly opts: PiAgentOptions) {
    super();
  }

  startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    return this.launch(opts, randomUUID(), false);
  }

  resumeConversation(opts: ResumeConversationOptions): Promise<ConversationHandle> {
    return this.launch(opts, opts.conversationId, true);
  }

  private async launch(
    opts: StartConversationOptions,
    sessionId: string,
    resume: boolean,
  ): Promise<ConversationHandle> {
    if (this.rpc) throw new Error('这个 PiAgent 已经起过会话');
    try {
      this.bridge = await openPiBridge(opts.mcpUrl, opts.mcpToken);
      const allowed = [...this.bridge.toolNames];
      const rpc = new PiRpc({
        args: this.cliArgs(opts, sessionId, allowed),
        cwd: opts.cwd,
        // 令牌只走环境变量:命令行对同机其他进程可见
        env: { ...process.env, [PI_ENDPOINT_ENV]: this.bridge.url, [PI_TOKEN_ENV]: this.bridge.token },
        onLog: this.opts.onLog,
      });
      this.rpc = rpc;
      rpc.on('event', (e: PiMessage) => this.onEvent(e));
      rpc.on('exit', (_code: number | null, tail: string) => this.onExit(tail));

      this.assertReadOnly(await this.awaitHandshake(rpc, this.bridge), allowed, this.bridge.toolNames);

      const state = await rpc.send('get_state');
      if (!state.success) throw new Error(`pi 的 get_state 失败:${state.error ?? '未知原因'}`);
      const data = (state.data ?? {}) as { model?: PiModel | null; messageCount?: number };
      // --session-id 找不到会话时会**静默新建**一个空的:续接成功、上下文全丢,且没有任何报错
      if (resume && !data.messageCount)
        throw new Error(`pi 在磁盘上找不到会话 ${sessionId}(或它是空的),无法续接`);
      // 带上 provider:同一个 id 可能挂在两家下面(如 openai 与 openai-codex),回填后续接要能原样找回
      const model = data.model ? `${data.model.provider}/${data.model.id}` : undefined;
      return { conversationId: sessionId, model };
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  private cliArgs(opts: StartConversationOptions, sessionId: string, allowed: string[]): string[] {
    const args = [
      '-e',
      this.opts.extensionPath,
      '--session-id',
      sessionId,
      // 只放 Duetlens 自己的工具,pi 的内置 read/grep/find/ls 一个不开:它们接受 `~` 与绝对路径,
      // 且读的是工作区而不是被审的那棵 commit 树(GitButler 下工作区是各 lane 合并后的样子)。
      // Duetlens 的取证工具读的是钉住的树、挡越界路径,两条链路共用同一道边界。
      // --tools 同时过滤 extension 注册的工具,故 Duetlens 的工具也得点名,否则注册了也不生效。
      ...(allowed.length ? ['--tools', allowed.join(',')] : ['--no-tools']),
      // 被审仓库里的 .pi/ 与用户全局的扩展、skill 都与 pi 同权限跑,只读保证管不到它们 —— 一概不加载。
      // 显式的 -e 不受 --no-extensions 影响。
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-approve',
    ];
    if (this.opts.sessionDir) args.push('--session-dir', this.opts.sessionDir);
    if (opts.model) args.push('--model', opts.model);
    if (opts.reasoningEffort && THINKING_LEVELS.has(opts.reasoningEffort))
      args.push('--thinking', opts.reasoningEffort);
    if (opts.baseInstructions) {
      // 追加而不是替换:pi 的默认提示词里有它自己工具的用法说明,替换掉工具就用不好。
      // 走文件而不是命令行:几千字符,且提示词不该出现在进程列表里。
      this.promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duetlens-pi-'));
      const file = path.join(this.promptDir, 'instructions.md');
      fs.writeFileSync(file, opts.baseInstructions, { encoding: 'utf8', mode: 0o600 });
      args.push('--append-system-prompt', file);
    }
    return args;
  }

  /**
   * 等 extension 报回生效工具集。pi 加载 extension 失败会直接退出,诊断只在 stderr ——
   * 故与退出、超时三路赛跑,输的那两路都带上 stderr 原文。
   */
  private awaitHandshake(rpc: PiRpc, bridge: PiBridge): Promise<PiHandshake> {
    return new Promise<PiHandshake>((resolve, reject) => {
      const fail = (why: string, tail = rpc.stderrTail()) => {
        clearTimeout(timer);
        reject(new Error(`pi 没有完成握手:${why}${tail ? `\n${tail}` : ''}`));
      };
      const timer = setTimeout(() => fail('超时'), HANDSHAKE_TIMEOUT_MS);
      // 退出带来的原文要用它自己的:起不来(没装 pi)时原因在 spawn 错误里,stderr 是空的
      rpc.once('exit', (_code: number | null, tail: string) => fail('进程已退出', tail));
      void bridge.handshake.then((h) => {
        clearTimeout(timer);
        resolve(h);
      });
    });
  }

  /**
   * 失败关闭:工具集里有白名单之外的东西就拒绝开工。这是 pi 这侧只读保证的**唯一**证据 ——
   * 与 codex 那条校验沙箱回显不是同一件事,判据与错误码都不共用。
   */
  private assertReadOnly(hs: PiHandshake, allowed: string[], remote: readonly string[]): void {
    const leaked = unexpectedPiTools(hs.activeTools, allowed);
    if (leaked.length > 0)
      throw new Error(
        `${PI_TOOLSET_NOT_READ_ONLY_CODE} pi 的生效工具集里有只读白名单之外的工具:${leaked.join(', ')}`,
      );
    // 这一条不关只读,关回传:缺了它们 findings 回不来,一轮下来是与「真的没问题」无从区分的 0 条
    const missing = remote.filter((t) => !hs.activeTools.includes(t));
    if (missing.length > 0) throw new Error(`Duetlens 的工具没有在 pi 里生效:${missing.join(', ')}`);
  }

  /**
   * 发一个 turn。pi 只有会话级 abort、协议里没有 turn id,故自己编号 ——
   * 会话内 turn 串行,编号足以点名(接口约定见 ConversationalAgent.sendMessage)。
   * 状态要**先于** prompt 挂上:事件可能早于应答到达,那时就得认得出是哪一轮。
   */
  async sendMessage(_conversationId: string, text: string): Promise<string> {
    const rpc = this.requireRpc();
    const id = `pi-turn-${++this.seq}`;
    this.turn = { id, started: false, sawText: false, toolCalls: 0, interrupted: false };
    const res = await rpc.send('prompt', { message: text }).catch((e: Error) => {
      this.turn = undefined;
      throw e;
    });
    if (!res.success) {
      this.turn = undefined;
      throw new Error(`pi 拒绝了这一轮:${res.error ?? '未知原因'}`);
    }
    return id;
  }

  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  /** 只打断点名的那一轮:它已经结束的话,会话级 abort 会误杀紧随其后的下一轮。 */
  async interrupt(_conversationId: string, turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId) return;
    turn.interrupted = true;
    const res = await this.requireRpc().send('abort', {}, ABORT_TIMEOUT_MS);
    if (!res.success) throw new Error(`pi 的 abort 失败:${res.error ?? '未知原因'}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rpc?.kill();
    void this.bridge?.close().catch(() => undefined);
    if (this.promptDir) fs.rmSync(this.promptDir, { recursive: true, force: true });
  }

  private requireRpc(): PiRpc {
    if (!this.rpc || !this.rpc.isAlive()) throw new Error('pi 会话未建立或进程已退出');
    return this.rpc;
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }

  private onEvent(e: PiMessage): void {
    const turn = this.turn;
    switch (e.type) {
      case 'agent_start':
        // 自动重试与排队续跑会再发 agent_start,一个 Duetlens turn 只报一次起跑
        if (turn && !turn.started) {
          turn.started = true;
          this.emitEvent({ kind: 'turn-started', turnId: turn.id });
        }
        break;
      case 'message_update': {
        const ev = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev?.type === 'text_delta' && ev.delta) {
          if (turn) turn.sawText = true;
          this.emitEvent({ kind: 'message-delta', text: ev.delta, turnId: turn?.id });
        }
        break;
      }
      case 'message_end': {
        const m = e.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (turn && m?.role === 'assistant') turn.last = { stopReason: m.stopReason, errorMessage: m.errorMessage };
        break;
      }
      case 'tool_execution_start': {
        const args = (e.args ?? {}) as Record<string, unknown>;
        this.calls.set(String(e.toolCallId), { at: Date.now(), args });
        if (turn) turn.toolCalls++;
        this.emitEvent(this.toolEvent(String(e.toolName), args, 'inProgress'));
        break;
      }
      case 'tool_execution_end': {
        const call = this.calls.get(String(e.toolCallId));
        this.calls.delete(String(e.toolCallId));
        this.emitEvent(
          this.toolEvent(
            String(e.toolName),
            call?.args ?? {},
            e.isError === true ? 'failed' : 'completed',
            call ? Date.now() - call.at : undefined,
          ),
        );
        break;
      }
      case 'turn_end':
        // pi 不推送用量。每段 assistant 响应之后问一次,节奏跟着上下文真正变化的时刻走,不另起定时器
        void this.pollUsage();
        break;
      case 'compaction_start':
        this.emitEvent({ kind: 'compaction', phase: 'started' });
        break;
      case 'compaction_end':
        this.emitEvent({ kind: 'compaction', phase: 'completed' });
        break;
      case 'auto_retry_start': {
        const msg = String(e.errorMessage ?? 'pi 正在重试');
        this.emitEvent({ kind: 'turn-retrying', turnId: turn?.id ?? '', error: msg, errorKind: piErrorKind(msg) });
        break;
      }
      case 'extension_error':
        this.emitEvent({ kind: 'error', error: `pi extension 出错(${String(e.event)}):${String(e.error)}` });
        break;
      // 终局是 agent_settled 而不是 agent_end:后者之后还可能有自动重试与排队续跑
      case 'agent_settled':
        if (turn?.started) this.settle(turn);
        break;
    }
  }

  /**
   * 收一轮。pi 没有失败事件,失败从两处派生:终局消息的 stopReason,
   * 以及「一轮跑完既无正文也无工具调用」—— provider 拒掉请求(如模型名不存在)时
   * 事件序列与正常轮次逐条一致,只有这个结构性特征能认出来。
   */
  private settle(turn: TurnState): void {
    this.turn = undefined;
    const last = turn.last;
    if (last?.stopReason === 'error') {
      const error = last.errorMessage || 'pi 报告本轮出错';
      this.emitEvent({ kind: 'turn-failed', turnId: turn.id, error, errorKind: piErrorKind(error) });
      return;
    }
    // 被打断的一轮以 completed 收尾,与 codex 的 interrupted 同一口径:定性由叫停方做
    if (turn.interrupted || last?.stopReason === 'aborted') {
      this.emitEvent({ kind: 'turn-completed', turnId: turn.id });
      return;
    }
    if (!turn.sawText && turn.toolCalls === 0) {
      const tail = this.rpc?.stderrTail();
      const kind = piErrorKind(tail);
      this.emitEvent({
        kind: 'turn-failed',
        turnId: turn.id,
        error: `这一轮既没有回复也没有工具调用,多半是请求被 provider 拒了(如模型名在 provider 上不存在)${tail ? `\n${tail}` : ''}`,
        errorKind: kind === 'other' ? 'bad-request' : kind,
      });
      return;
    }
    this.emitEvent({ kind: 'turn-completed', turnId: turn.id });
  }

  /** 进程在一轮中途没了:那一轮的终局永远不会来,不就地判死调用方就会一直等。 */
  private onExit(tail: string): void {
    if (this.disposed) return;
    const turn = this.turn;
    this.turn = undefined;
    const error = `pi 进程意外退出${tail ? `:${tail}` : ''}`;
    if (turn) this.emitEvent({ kind: 'turn-failed', turnId: turn.id, error, errorKind: piErrorKind(tail) });
    else this.emitEvent({ kind: 'error', error });
  }

  private async pollUsage(): Promise<void> {
    if (this.polling || !this.rpc?.isAlive()) return;
    this.polling = true;
    try {
      const res = await this.rpc.send('get_session_stats');
      const data = (res.data ?? {}) as {
        tokens?: { total?: number };
        contextUsage?: { tokens?: number | null; contextWindow?: number };
      };
      const used = data.contextUsage?.tokens;
      // 压缩刚结束时 tokens 为 null,要等下一次响应才有真值 —— 这时不报,别让环归零
      if (typeof used !== 'number') return;
      this.emitEvent({
        kind: 'token-usage',
        used,
        cumulative: data.tokens?.total ?? 0,
        total: data.contextUsage?.contextWindow,
      });
    } catch {
      // 用量是展示用的,问不到不影响这一轮
    } finally {
      this.polling = false;
    }
  }

  /** 生效的只有 Duetlens 的工具(见 cliArgs),故 pi 这侧的调用一律是 `tool-call`。 */
  private toolEvent(
    tool: string,
    args: Record<string, unknown>,
    status: string,
    durationMs?: number,
  ): AgentEvent {
    return { kind: 'tool-call', server: MCP_SERVER_NAME, tool, status, args, durationMs };
  }
}
