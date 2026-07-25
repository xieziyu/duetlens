import type { AgentErrorKind } from '@shared/agent-events';

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
  other: {
    title: '这一轮机审没能跑完',
    advice: '',
    retryable: true,
  },
};

export function describeRoundError(kind: AgentErrorKind | null): RoundErrorCopy {
  return COPY[kind ?? 'other'] ?? COPY.other;
}

// ---- 开跑前的失败(source / gh / 网络)----
//
// 与上面的 turn 失败是两回事:这一类发生在**一轮还没开跑**时,agent 根本没被叫起来,
// 因而没有归因可落库 —— 只有底层命令的原文。这里按可辨认的特征串给出人话结论,
// 认不出就只给通用结论;原文一律照常呈现,不靠猜来替代证据。

/** 特征串 → 结论。顺序即优先级:越具体的排前面。 */
const LAUNCH_PATTERNS: { match: RegExp; title: string; advice: string }[] = [
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
 */
function stripIpcWrapper(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|UnhandledError):\s*/, '')
    .trim();
}

export function describeLaunchError(message: string): LaunchErrorCopy {
  const raw = stripIpcWrapper(message);
  const hit = LAUNCH_PATTERNS.find((p) => p.match.test(raw));
  return {
    title: hit?.title ?? '这一轮没能开跑',
    advice: hit?.advice ?? '',
    raw,
  };
}
