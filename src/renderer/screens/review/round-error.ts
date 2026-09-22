import type { AgentErrorKind } from '@shared/agent-events';
import { CODEX_TARGET_VERSION, isCodexProtocolError } from '@shared/codex';
import type { AgentKind } from '@shared/domain';
import { FOLLOWUP_REPLY_FAILED_CODE, PI_TOOLSET_NOT_READ_ONLY_CODE, SANDBOX_NOT_APPLIED_CODE } from '@shared/ipc';

/**
 * 失败归因 → 用户能读懂的结论与处置。原文一律另行原样呈现 ——
 * 这里只负责"这是什么、你能做什么",不改写、不吞掉证据。
 */
export interface RoundErrorCopy {
  /** 一句话结论 */
  title: string;
  /** 下一步建议;没有可给的建议时为空串 */
  advice: string;
  /** 重试是否有意义(决定「重试本轮」是主按钮还是次按钮) */
  retryable: boolean;
}

/**
 * codex 版本相关的两条结论。轮次失败(按 errorKind 分档)与开跑前失败(按特征串认)
 * 是两条渲染路径,但同一件事只该有一份措辞 —— 故在此定义一次,两张表都引它。
 */
const SANDBOX_BREACH = {
  title: 'codex 没有按只读沙箱起会话,已中止',
  advice: `本机 codex 与这版 Duetlens 对不上,注入的只读策略没有生效 —— 继续跑等于让审核 agent 在未知策略下动你的仓库,所以直接停了。这版对齐的是 codex ${CODEX_TARGET_VERSION},升级后再跑。`,
};
const VERSION_MISMATCH = {
  title: '本机 codex 版本与这版 Duetlens 对不上',
  advice: `这版对齐的是 codex ${CODEX_TARGET_VERSION}。在终端跑 codex --version 看看本机是哪个版本,升到相近版本再试。`,
};

const TOOLSET_BREACH = {
  title: 'pi 的工具集不是只读的,已中止',
  advice:
    'pi 没有沙箱,只读全靠只给它读类工具;这次它报回的工具集里混进了别的工具,' +
    '继续跑等于让审核 agent 带着写能力动你的仓库,所以直接停了。多为 pi 版本变了内置工具,升级 Duetlens 或回退 pi 再试。',
};

/** 按 codex 的处置写的底表;别家处置不同的档在 {@link AGENT_COPY} 里覆盖。 */
const COPY: Record<AgentErrorKind, RoundErrorCopy> = {
  'usage-limit': {
    title: 'codex 账号用量已达上限',
    advice: '等额度重置,或在设置里换一个更省的模型 / 更低的 reasoning effort 再跑。',
    retryable: false,
  },
  'context-exceeded': {
    title: '本轮上下文超出模型窗口',
    advice: '改动太大或历史太长 —— 换上下文窗口更大的模型,或把这次审核拆成更小的范围。',
    retryable: false,
  },
  'server-overloaded': {
    title: '模型服务暂时不可用',
    advice: '上游过载或正在抖动,agent 已自行重试过若干次仍未成功。稍等片刻再重试本轮即可。',
    retryable: true,
  },
  connection: {
    title: '与模型服务的连接中断',
    advice: '检查网络与代理(codex 走 HTTPS / WebSocket),恢复后重试本轮。',
    retryable: true,
  },
  unauthorized: {
    title: 'codex 登录态已失效',
    advice: '在终端跑一次 codex login 重新登录,再重试本轮。',
    retryable: false,
  },
  'bad-request': {
    title: '请求被模型服务拒绝',
    advice: '多为模型名不可用或内容触发策略拦截。换个模型再试;仍失败请看下方原文。',
    retryable: false,
  },
  'agent-not-installed': {
    title: '找不到 codex 可执行文件',
    advice: '在 PATH 里没有找到 codex。用 brew install codex 装上,或在设置 ▸ codex 里指定它的路径,再重试本轮。',
    retryable: false,
  },
  'sandbox-not-applied': { ...SANDBOX_BREACH, retryable: false },
  'codex-version-mismatch': { ...VERSION_MISMATCH, retryable: false },
  'mcp-undelivered': {
    title: 'codex 没把工具调用交给 Duetlens,已中止',
    advice:
      'agent 上报 findings 的通道断在 codex 那一侧 —— 它自己就把调用拒了,一条都没到货。' +
      '再跑也是空手,而且「0 findings」和「真的没问题」在界面上长得一样,所以直接停了。' +
      `多为本机 codex 与这版 Duetlens 的审批策略对不上;这版对齐的是 codex ${CODEX_TARGET_VERSION}。`,
    retryable: false,
  },
  'toolset-not-read-only': { ...TOOLSET_BREACH, retryable: false },
  other: {
    title: '这一轮机审没能跑完',
    advice: '',
    retryable: true,
  },
};

/**
 * 处置因 agent 而异的那几档。两家的凭证与计费体系不同:codex 走订阅账号、`codex login`;
 * pi 走各 provider 的凭证(订阅登录或 API key),额度看的是 provider 那边。
 * 写成一句中立的话等于两边都没说清,故分叉。
 */
const AGENT_COPY: Partial<Record<AgentKind, Partial<Record<AgentErrorKind, RoundErrorCopy>>>> = {
  pi: {
    'usage-limit': {
      title: 'provider 的额度或速率已达上限',
      advice: '看一下所用 provider 的余额与速率限制,或换一个 provider / 更省的模型再跑。',
      retryable: false,
    },
    connection: {
      title: '与模型服务的连接中断',
      advice: '检查网络与代理(pi 直连各 provider 的 API),恢复后重试本轮。',
      retryable: true,
    },
    'agent-not-installed': {
      title: '找不到 pi 可执行文件',
      advice: '在 PATH 里没有找到 pi。按 pi 的安装文档装上,或在设置 ▸ pi 里指定它的路径,再重试本轮。',
      retryable: false,
    },
    unauthorized: {
      title: 'pi 的 provider 凭证无效',
      advice: '在终端运行 pi,用 /login 重新登录或录入 API key(也可以设对应的环境变量),再重试本轮。',
      retryable: false,
    },
  },
};

export function describeRoundError(kind: AgentErrorKind | null, agent: AgentKind = 'codex'): RoundErrorCopy {
  const k = kind ?? 'other';
  return AGENT_COPY[agent]?.[k] ?? COPY[k] ?? COPY.other;
}

// ---- 开跑前的失败(source / gh / 网络)----
//
// 与上面的 turn 失败是两回事:这一类发生在**一轮还没开跑**时,agent 根本没被叫起来,
// 因而没有归因可落库 —— 只有底层命令的原文。这里按可辨认的特征串给出人话结论,
// 认不出就只给通用结论;原文一律照常呈现,不靠猜来替代证据。

/**
 * 特征 → 结论。顺序即优先级:越具体的排前面。
 * 判据多数是特征串;需要「几个条件同时成立」才作数的(如协议错)给谓词。
 */
const LAUNCH_PATTERNS: {
  match: RegExp | ((raw: string) => boolean);
  title: string;
  advice: string;
}[] = [
  { match: new RegExp(SANDBOX_NOT_APPLIED_CODE), ...SANDBOX_BREACH },
  { match: new RegExp(PI_TOOLSET_NOT_READ_ONLY_CODE), ...TOOLSET_BREACH },
  {
    // 排在通用 ENOENT 之前:否则「没装 pi」会被说成「仓库目录不见了」。设了路径时原文是绝对路径
    match: /spawn \S*\bpi ENOENT/,
    title: '找不到 pi 可执行文件',
    advice: '在 PATH 里没有找到 pi。安装后重跑,或在设置 ▸ pi 里指定它的路径。',
  },
  {
    match: /spawn \S*\bcodex ENOENT/,
    title: '找不到 codex 可执行文件',
    advice: '在 PATH 里没有找到 codex。安装后重跑,或在设置 ▸ codex 里指定它的路径。',
  },
  {
    match: /pi 没有完成握手/,
    title: 'pi 没能拉起审核会话',
    advice: 'pi 在加载 Duetlens 的桥接扩展时就退出了,原因见下方原文。多为 pi 版本与这版 Duetlens 不兼容。',
  },
  {
    match: /pi 在磁盘上找不到会话/,
    title: '这条审核的 pi 会话已经不在了',
    advice: '会话文件可能被清理过。findings 与你的处置都还在;要继续追问,重跑一轮机审即可开新会话。',
  },
  {
    // codex 的 JSON-RPC 参数/方法校验失败。与业务无关,一律是版本对不上 ——
    // 不认出来的话,用户看到的就是一句「Invalid request: missing field ... (code -32600)」。
    match: isCodexProtocolError,
    ...VERSION_MISMATCH,
  },
  {
    // `but diff <branch>` 解析不出该虚拟分支
    match: /No ID found for entity/i,
    title: '这条虚拟分支已不在 GitButler workspace 里',
    advice:
      '多半是它已被合入目标分支或取消应用了。这条 review 仍可阅读、triage 与导出;要再跑一轮机审,需要先把对应分支 apply 回 workspace。',
  },
  {
    match: /unknown revision|not a valid object name|bad revision|ambiguous argument/i,
    title: '仓库里找不到这条分支了',
    advice: '分支可能已被删除或重命名。改动没了就无从重审;findings 与你的处置仍在,可直接导出。',
  },
  {
    match: /not a git repository|no such file or directory|ENOENT/i,
    title: '找不到当初被审的仓库目录',
    advice: '仓库可能被移动或删除了。把它放回原路径后再重跑;在此之前这条 review 只能只读查看。',
  },
  {
    match: /gh auth|not logged in|HTTP 401|authentication/i,
    title: 'GitHub 登录态已失效',
    advice: '在终端跑一次 gh auth login 重新登录,再重跑。',
  },
  {
    match: /Could not resolve to a PullRequest|HTTP 404/i,
    title: '这个 PR 拉不到了',
    advice: 'PR 可能已被删除,或当前账号没有该仓库的权限。',
  },
  {
    match: /Could not resolve host|ETIMEDOUT|ECONNREFUSED|network is unreachable/i,
    title: '网络不通,拉不到最新改动',
    advice: '检查网络与代理后重试。',
  },
  {
    match: /command not found|spawn .* ENOENT/i,
    title: '找不到所需的命令行工具',
    advice: '设置里可以指定 codex / gh 的可执行文件路径(GitButler 的 but 需在 PATH 中)。',
  },
];

export interface LaunchErrorCopy {
  title: string;
  advice: string;
  /** 剥掉 IPC 包装后的原文;始终展示,不因为认出了类型就把证据吞掉 */
  raw: string;
}

/**
 * Electron 的 `ipcRenderer.invoke` 只把 message 带过来,并裹上一层
 * `Error invoking remote method 'x': Error: `。剥掉纯噪声的前缀,剩下的是底层命令原文。
 * 任何要把 IPC 失败原文摆到界面上的地方都该过这里。
 */
export function stripIpcWrapper(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|UnhandledError):\s*/, '')
    .trim();
}

/**
 * @param fallbackTitle 认不出特征时的兜底结论。默认按「开跑失败」措辞;
 *   叫停失败复用的是同一份呈现,但说成「没能开跑」正好把因果说反了。
 */
export function describeLaunchError(message: string, fallbackTitle = '这一轮没能开跑'): LaunchErrorCopy {
  const raw = stripIpcWrapper(message);
  const hit = LAUNCH_PATTERNS.find((p) =>
    typeof p.match === 'function' ? p.match(raw) : p.match.test(raw),
  );
  return {
    title: hit?.title ?? fallbackTitle,
    advice: hit?.advice ?? '',
    raw,
  };
}

// ---- 追问失败 ----

export interface SendFailureCopy {
  /**
   * 问题是否**已经发出去**(落库并上屏,只是没等到回复)。
   * 决定草稿要不要还给用户:已发出还要是把同一句话劝人再说一遍。
   */
  sent: boolean;
  /** 一句话结论 */
  title: string;
  /** 剥掉 IPC 包装与识别串后的原文 */
  raw: string;
}

/** 追问失败的定性;识别串由后端嵌在 message 里(见 shared/ipc 的 FOLLOWUP_REPLY_FAILED_CODE)。 */
export function describeSendFailure(message: string): SendFailureCopy {
  const sent = message.includes(FOLLOWUP_REPLY_FAILED_CODE);
  return {
    sent,
    title: sent ? '已发出,但 agent 没能回复' : '没能发出',
    raw: stripIpcWrapper(message.replace(FOLLOWUP_REPLY_FAILED_CODE, '')),
  };
}
