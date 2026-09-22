/** token 计量。占用率只能用 used/total;cumulative 是累计消耗,可远超窗口。 */
export interface TokenUsage {
  /** 当前上下文占用 —— 下一次请求要重新带上的那部分;各家的换算见各自实现 */
  used: number;
  /** 整个会话的累计消耗 */
  cumulative: number;
  /** 模型**有效**上下文窗口;未上报时为空 */
  total?: number;
}

/**
 * 失败归因。agent 中立(各家的错误码映射到这里),因为 UI 的处置建议
 * 按「用户能做什么」分档,而不是按某家 agent 的错误码分档。
 *
 * 标了「仅 codex」的几档是那条链路特有的失败模式,别的 agent 没有对应物,
 * 不要为了复用处置文案把别家的失败硬塞进来 —— 判据不同,处置建议就是错的。
 */
export const AGENT_ERROR_KINDS = [
  /** 用量/额度耗尽 —— 换账号或等重置,重试无用 */
  'usage-limit',
  /** 上下文超限 —— 缩小审核范围才有救 */
  'context-exceeded',
  /** 上游过载或 5xx —— 稍后重试通常就好 */
  'server-overloaded',
  /** 连接层失败(握手/流中断)—— 查网络或代理后重试 */
  'connection',
  /** 未登录或凭证失效 —— 按所用 agent 的凭证体系重新登录 */
  'unauthorized',
  /** 请求被拒(参数/策略)—— 重试无用 */
  'bad-request',
  /** 找不到 agent 的可执行文件 —— 装上或在设置里指定路径,重试无用 */
  'agent-not-installed',
  /** 仅 codex:只读沙箱注入没落地(见 SANDBOX_NOT_APPLIED_CODE)—— 换模型没用,要升 codex */
  'sandbox-not-applied',
  /** 仅 codex:本机 codex 与这版对齐的协议对不上(见 CODEX_PROTOCOL_ERROR)—— 重试必然复现 */
  'codex-version-mismatch',
  /** 仅 codex:codex 没把工具调用交给自建 MCP —— findings 回不来,再跑也是空手,见 MCP_UNDELIVERED_CODE */
  'mcp-undelivered',
  /** 仅 pi:生效工具集越出只读白名单(见 PI_TOOLSET_NOT_READ_ONLY_CODE)—— 重试必然复现 */
  'toolset-not-read-only',
  'other',
] as const;
export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

/**
 * agent 取证时**实际在做什么**。只从 agent 给出的结构化描述收窄而来(codex 的
 * `commandActions`)—— 自己解析 shell 是另一个泥潭,且解析错就是往界面上报假动作。
 *
 * 只读会话里 read / search / list 就是全部有意义的动作;其余一律 `other`,
 * 由 UI 退回显示原始命令,而不是硬塞进一个不贴切的档。
 */
export type CommandAction =
  | { type: 'read'; path: string }
  | { type: 'search'; query?: string; path?: string }
  | { type: 'list'; path?: string }
  | { type: 'other' };

/**
 * 归一后的 agent 领域事件(各家协议事件映射到这里)。
 * 放 shared:backend 产生、renderer 消费,经 IPC 透传。
 *
 * 不是每家都产出每个 kind:派生不出的就不发,消费方不能拿「没收到」当判据。
 * turn 的界定见 ConversationalAgent。
 */
export type AgentEvent =
  | { kind: 'turn-started'; turnId: string }
  // turnId 是 agent 可选给的:有就据此把残余 delta 挡在别的 turn 之外(被打断那轮常有补发)
  | { kind: 'message-delta'; text: string; turnId?: string }
  | {
      kind: 'tool-call';
      server: string;
      tool: string;
      status: string;
      args?: unknown;
      /**
       * 仅 codex:**codex 没把这次调用交给 server** 时的原因。工具自己回的业务拒绝不在此列 ——
       * 那种 agent 看得到原文、改对了会重来,不是故障;这里只装它重试也到不了的那半。
       */
      undelivered?: string;
      durationMs?: number;
    }
  /**
   * agent 自带的取证动作(如 codex 只读沙箱里的 rg / sed / cat)。只经 Duetlens 工具取证的 agent
   * 不产出这一档 —— 那些调用本来就以 `tool-call` 出现。
   * 与 `tool-call` 分开是因为二者的可读单位不同:工具调用问的是「哪个工具、什么参数」,
   * 取证问的是「它在读哪个文件、在搜什么」—— 后者只有 {@link CommandAction} 答得上来。
   */
  | {
      kind: 'command';
      command: string;
      status: string;
      actions: CommandAction[];
      durationMs?: number;
    }
  | { kind: 'web-search'; query: string; status: string }
  | ({ kind: 'token-usage' } & TokenUsage)
  // 上下文压缩由 agent 自己的 auto-compact 触发,我们只观测(压缩只摘要 agent 侧历史,
  // 不碰我们 DB 里的锚点/finding;不主动发起)。
  | { kind: 'compaction'; phase: 'started' | 'completed' }
  // 仅 codex:反向审批的统一观测面。受信工具 elicitation 自动 accept 为 expected;其余一律拒绝且
  // expected=false。靠工具集保证只读的 agent 没有审批闸,也就不发这个 kind。
  | {
      kind: 'approval';
      method: string;
      decision: 'accepted' | 'declined' | 'denied';
      expected: boolean;
      /**
       * 这条反向请求把关的是什么。**只有 `policy` 能当沙箱哨兵** —— 它是执行/写入/权限类
       * 审批,只读会话里根本不该出现;`mcp` 是工具侧的 elicitation,被拒只说明我们没批准
       * 那次调用(用户自己配的第三方 MCP server 就会走这条),不能据此断定注入失效。
       */
      gate: 'policy' | 'mcp';
      server?: string;
      message?: string;
    }
  | { kind: 'turn-completed'; turnId: string }
  // 协议没有失败事件的 agent 要由实现按结构性判据派生(如一轮既无正文也无工具调用),
  // 不能让失败以 turn-completed 的面目收场 —— 那在界面上与「真的没问题」无从区分。
  | { kind: 'turn-failed'; turnId: string; error: string; errorKind: AgentErrorKind }
  // agent 自己还会重试的中途失败:一轮可能这样静默耗掉几十秒,不外发的话进度条是纯黑盒。
  | { kind: 'turn-retrying'; turnId: string; error: string; errorKind: AgentErrorKind }
  | { kind: 'error'; error: string };
