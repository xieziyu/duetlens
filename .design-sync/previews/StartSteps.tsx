import { StartSteps } from 'duetlens';

// 与 screens/entry/StartOverlay.tsx 的 STEPS 同一份文案。
const STEPS = [
  { stage: 'resolve' as const, label: '连接来源 · 读取目标元信息', slow: '正在解析仓库与目标引用' },
  { stage: 'diff' as const, label: '拉取本次改动的 diff', slow: '改动量大时 diff 要下载十几秒,这是正常的' },
  { stage: 'record' as const, label: '解析 diff · 建立审核记录', slow: '正在切分文件与 hunk' },
  { stage: 'agent' as const, label: '装配审核规则 · 启动 agent 会话', slow: '正在拉起 codex 会话' },
];

const HINT = '进入后首轮机审继续在后台跑,不用等它结束';

/** 刚起步:停在第一档。 */
export const Resolving = () => <StartSteps steps={STEPS} stage="resolve" hint={HINT} />;

/** 大 PR 最容易卡住的一档 —— 滞留超过 6s 会把等待预期讲出来。 */
export const PullingDiff = () => <StartSteps steps={STEPS} stage="diff" hint={HINT} />;

/** 最后一档:agent 会话拉起中。 */
export const StartingAgent = () => <StartSteps steps={STEPS} stage="agent" hint={HINT} />;
