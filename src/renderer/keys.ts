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

/**
 * 平台主修饰键:macOS 只认 ⌘,其余平台只认 Ctrl。
 *
 * 不能沿用 `metaKey || ctrlKey` 那种两边都收的写法:macOS 的文本控件把 Ctrl+A / E / F / K 一类
 * 当行内编辑键(Ctrl+E = 移到行尾),两边都收就会在 composer、finding 编辑框里把它们抢走。
 * 设置屏显示的 `AppInfo.platform` 走 IPC 异步取,喂不了同步的键盘判据,所以这里读 UA。
 */
const IS_MAC = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);

export function primaryModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * 重跑快捷键 ⌘E(Windows / Linux 为 Ctrl+E)。审核屏与提交/导出屏共用这一份判据。
 *
 * 不用 R 这个助记:`⌘R` / `⌘⇧R` 归应用菜单的 Reload / Force Reload,按下去整屏重载。
 * 也不带 ⌥ —— Windows / Linux 的 AltGr 就是以 ctrl+alt 上报的,国际布局下用 AltGr 打字会撞上;
 * 排除 alt 比事后查 getModifierState('AltGraph') 更彻底,顺带躲开 macOS 上 ⌥ 作为字符合成键的那一面。
 */
export function isRerunKey(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): boolean {
  return primaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e';
}

/**
 * review tab 前后切:⌃⇥ / ⌃⇧⇥,返回 +1 / -1,不是这个组合则 null。
 *
 * 关 tab 的 ⌘W **不在这里** —— 菜单加速键先于渲染层拿到按键,它由主进程的菜单项回推
 * (见 backend/menu/app-menu.ts 与 App 的订阅)。
 *
 * 用 ⌃⇥ 而不是屏内那套 ⌘ 组合:**⌘1/2/3 已经归右栏三 tab**,再拿 ⌘ 数字键切 review tab
 * 就是同一组键在两层导航上打架。⌃⇥ 是跨平台的 tab 惯例,两边都不必分支。
 * 排除 ⌘ 与 ⌥:带别的修饰键的组合是另一个意图,不该被这里顺手吃掉。
 */
export function tabStepKey(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): number | null {
  if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.shiftKey ? -1 : 1;
}
