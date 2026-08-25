/**
 * 首轮扫描指令的组装。纯函数、不碰 IO —— 与 rerun-prompt 同一约定,便于 spike 断言
 * "注入了什么"而不必真跑 codex。
 *
 * 只给一份 diff 的话,agent 读不到这个 PR 想解决什么、作者在描述里承诺了什么、
 * 评审区已经争过哪一轮。「审核重点」里的 Scope 一类(body 承诺了、diff 未实现)
 * 没有描述就是空转,所以 github-pr source 把标题 / 描述与 PR 级讨论一并注入。
 *
 * **不带 inline 讨论**:首轮还没有我方 finding 可对照,那些串既挂不上具体条目、又最占篇幅;
 * 它们从第一次复审起注入(见 rerun-prompt)。
 *
 * PR 内容是外部数据,隔离围栏与「任务写在末尾」的约定见 prompt/pr-context.ts。
 */
import type { PrContext } from '@shared/github-context';
import { prContextSection } from './pr-context';

/** 没有任何附加材料时的缺省扫描指令;也是 ReviewSession 直调时的兜底。 */
export const DEFAULT_SCAN_PROMPT = '请审核本次改动,对每个问题调用 report_finding 上报。';

export interface ScanPromptInput {
  /** GitHub 协作上下文;非 github-pr source 或拉取失败(降级为空)时传 null */
  pr: PrContext | null;
  /** 用户在入口填的附加上下文 */
  note?: string | null;
}

/**
 * 组装首轮指令。无 PR 上下文也无附加说明时返回 undefined —— 拼出来与缺省指令一字不差,
 * 留给 session 兜底,免得同一句话有两个出处。
 */
export function buildScanPrompt(input: ScanPromptInput): string | undefined {
  const pr = input.pr ? prContextSection(input.pr) : [];
  const note = input.note?.trim();
  if (!pr.length && !note) return undefined;

  const out = [...pr];
  if (note) out.push('## 用户附加上下文(审核时一并考虑)', note, '');
  out.push('## 本轮任务', DEFAULT_SCAN_PROMPT);
  return out.join('\n');
}
