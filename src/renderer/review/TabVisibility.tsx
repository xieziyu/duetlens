import { createContext, useContext } from 'react';

/**
 * 「这一份 review 视图此刻是不是屏上那一份」。多 tab 之后所有已开 tab **都挂载着**,
 * 只有活跃那枚可见 —— 于是两件事必须按它收口:
 *
 * 1. **全局监听要按 active 决定是否注册**(不是在 handler 里判):window / document 上的
 *    keydown、mousedown、capture 阶段的 scroll,N 个实例都注册的话,⌘F / Esc / ⌘E 会被
 *    后台 tab 一起接走,而它连屏都不在。
 * 2. **隐藏态几何量为 0**:`display:none` 下 `getBoundingClientRect` / `scrollTop` 全是 0,
 *    定位(自算 scrollTop 绕 sticky、`scrollIntoView`)会**静默 no-op**。跨 tab 的定位请求
 *    一律等到可见后再兑现 —— effect 依赖里带上它,翻成 true 的那一帧才做。
 *
 * 缺省 true:没套 provider 的宿主(preview 直挂某屏、单 tab 场景)照常拿到「我就是屏上那份」,
 * 忘了套不会让快捷键整个失灵。
 */
const ActiveTabContext = createContext(true);

export function TabVisibilityProvider({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ActiveTabContext.Provider value={active}>{children}</ActiveTabContext.Provider>;
}

export function useIsActiveTab(): boolean {
  return useContext(ActiveTabContext);
}
