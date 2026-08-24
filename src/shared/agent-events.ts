/** codex 的 token 计量。占用率只能用 used/total;cumulative 是累计消耗,可远超窗口。 */
export interface TokenUsage {
  /** 当前上下文占用:最近一次请求的 totalTokens 扣掉 reasoning(见 codex-agent 的换算注释) */
  used: number;
  /** 整个 thread 的累计消耗(codex tokenUsage.total.totalTokens) */
  cumulative: number;
  /** 模型**有效**上下文窗口(codex 已按 effective 比例折算过);未上报时为空 */
  total?: number;
}

/**
 * 失败归因。provider 中立(codex 的 codexErrorInfo 映射到这里),因为 UI 的处置建议
 * 按「用户能做什么」分档,而不是按某家 agent 的错误码分档。
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
  /** 未登录或凭证失效 —— 需要重新 codex login */
  'unauthorized',
  /** 请求被拒(参数/策略)—— 重试无用 */
  'bad-request',
  /** 只读沙箱注入没落地(见 SANDBOX_NOT_APPLIED_CODE)—— 换模型没用,要升 codex */
  'sandbox-not-applied',
  /** 本机 codex 与这版对齐的协议对不上(见 CODEX_PROTOCOL_ERROR)—— 重试必然复现 */
  'codex-version-mismatch',
  /** codex 没把工具调用交给自建 MCP —— findings 回不来,再跑也是空手,见 MCP_UNDELIVERED_CODE */
  'mcp-undelivered',
  'other',
] as const;
export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

/**
 * agent 跑一条命令时**实际在做什么**。codex 已按管道逐段解析好(`commandActions`),
 * 我们只做收窄 —— 自己解析 shell 是另一个泥潭,且解析错就是往界面上报假动作。
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
 * 归一后的 agent 领域事件(codex turn/item/* 映射到这里)。
 * 放 shared:backend 产生、renderer 消费,经 IPC 透传。
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
       * **codex 没把这次调用交给 server** 时的原因。工具自己回的业务拒绝不在此列 ——
       * 那种 agent 看得到原文、改对了会重来,不是故障;这里只装它重试也到不了的那半。
       */
      undelivered?: string;
      durationMs?: number;
    }
  /**
   * agent 跑的 shell 命令(只读沙箱下就是 rg / sed / cat 这一类取证动作)。
   * 与 `tool-call` 分开是因为二者的可读单位不同:工具调用问的是「哪个工具、什么参数」,
   * 命令问的是「它在读哪个文件、在搜什么」—— 后者只有 {@link CommandAction} 答得上来。
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
  // 上下文压缩由 codex auto-compact 触发,我们只观测(compaction 只摘要 codex 历史,
  // 不碰我们 DB 里的锚点/finding;不主动 thread/compact/start)。
  | { kind: 'compaction'; phase: 'started' | 'completed' }
  // 反向审批的统一观测面:受信工具 elicitation 自动 accept 为 expected;其余一律拒绝且 expected=false。
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
  | { kind: 'turn-failed'; turnId: string; error: string; errorKind: AgentErrorKind }
  // agent 自己还会重试的中途失败:一轮可能这样静默耗掉几十秒,不外发的话进度条是纯黑盒。
  | { kind: 'turn-retrying'; turnId: string; error: string; errorKind: AgentErrorKind }
  | { kind: 'error'; error: string };
