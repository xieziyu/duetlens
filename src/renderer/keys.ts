import type { KeyboardEvent } from 'react';

/**
 * 输入法组合期的按键不是确认/取消的意图:候选窗里 Enter 是选词、Esc 是撤候选,派发出来的
 * keydown 与"提交""放弃编辑"长得一模一样。凡是靠**裸** Enter / Esc 触发动作的 handler
 * 都要先让位(带 ⌘/Ctrl 的组合键不会被输入法吃掉,不受影响)。
 *
 * keyCode 229 是兜底:个别输入法不置 isComposing,但组合期一律报 229。
 */
export function imeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
