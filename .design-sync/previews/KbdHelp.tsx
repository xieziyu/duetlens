import { KbdHelp } from 'duetlens';

// .kbd-overlay 是 position:fixed;inset:0 —— 直接放进卡里会以视口为参照跑到卡外。
// 带 transform 的祖先会成为 fixed 的包含块(CSS 规范),于是浮层就落在这一格内。
const stage: React.CSSProperties = {
  position: 'relative',
  transform: 'translateZ(0)',
  width: 860,
  height: 680,
  overflow: 'hidden',
};

/** 快捷键总表的浮层;审核屏与设置屏弹的是同一份(别抄摘录)。 */
export const Default = () => (
  <div style={stage}>
    <KbdHelp onClose={() => {}} />
  </div>
);
