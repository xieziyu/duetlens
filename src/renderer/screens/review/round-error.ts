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
