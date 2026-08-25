import { Wordmark } from 'duetlens';

/** 顶栏里的样子:mono 小写 duetlens_,末尾光标闪烁。 */
export const Default = () => <Wordmark />;

/**
 * 放大看清三段配色:duet 取正文色、lens 取 agent 蓝、_ 取 human 琥珀。
 * 用 transform 而不是 font-size —— .wordmark 自己钉死了 15px,父级字号对它无效。
 */
export const Magnified = () => (
  <div style={{ transform: 'scale(3)', transformOrigin: 'left top', width: 'max-content' }}>
    <Wordmark />
  </div>
);
