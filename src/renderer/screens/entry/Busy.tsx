import type { ReactNode } from 'react';

/**
 * 入口屏统一的「在途」状态位:转圈 + 一句话。
 *
 * 入口屏一次交互里能同时有好几段等待(解析 PR、探测仓库、列举分支、摸 base 候选、算改动面),
 * 各自画一份的结果是各自都画成了灰色小字 —— **不动、不亮、不占地方的东西等于没画**。
 * 收成一处:走 agent 档配色(这几段都是「系统在替你查」)、带转圈、字号跟得上正文。
 *
 * 降低动效偏好下**放慢而不是停掉** —— 转圈是这里唯一的在途信号,停了就只剩一句静止的话,
 * 与「卡住了」不可分。
 */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="busy">
      <i className="busy-ring" />
      {children}
    </span>
  );
}
