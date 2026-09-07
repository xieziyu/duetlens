/**
 * 预览入口(仅开发视觉自查用,不进 Electron 打包):
 * 先 stub window.duetlens 注入 fixtures,再挂真实 App,直达审核屏。
 *   npm run preview:ui  → 浏览器开 /preview.html
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsProvider } from '../settings/SettingsProvider';
import { App } from '../App';
import { installPreviewApi } from './fixtures';
import '../index.css';

installPreviewApi();

const container = document.getElementById('root');
if (!container) throw new Error('#root 未找到');

const params = new URLSearchParams(window.location.search);

// ?screen=prompt|onboarding|... 直达某屏自查;缺省进 demo 审核屏
const initialScreen = params.get('screen') as
  | 'entry'
  | 'review'
  | 'submit'
  | 'prompt'
  | 'onboarding'
  | 'history'
  | 'settings'
  | null;

// ?tabs=demo,r1,r2 按序开好几枚 tab(id 见 fixtures 的最近审核列表);缺省只开 demo 一枚
const initialTabs = (params.get('tabs') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ?restore=… 自查冷启动恢复:此时一个 initial* 都不能传 —— 传了就等于「已经有 tab 了」,
// 恢复那条路根本不会跑(见 App 的 restored 起始值)。
const asRestore = params.has('restore');

/**
 * `?scope-menu` 出图用:挂载后替按一下顶栏那枚范围 chip。
 * 弹层是点开的,headless 截图没有手 —— 而它恰恰是这个功能最要看的一屏。
 * 放在预览入口而不是组件里:production 的组件不该认识 URL 上的自查旋钮。
 */
if (params.has('scope-menu')) {
  // 一直点到弹层真的开着为止:范围落位会把三栏(连同这枚 chip)整棵重挂,
  // 落位之前那一下点开的弹层会随之消失 —— 只点一次就常常拍到一屏没有弹层的图
  const click = (tries: number) => {
    if (document.querySelector('.rev-root:not([hidden]) .scope-menu')) return;
    document.querySelector<HTMLButtonElement>('.rev-root:not([hidden]) .scopechip')?.click();
    if (tries > 0) setTimeout(() => click(tries - 1), 120);
  };
  setTimeout(() => click(40), 300);
}

/**
 * `?open=<reviewId>[&open-discussion=<id>]` 自查「通知点开的是哪条」那条路:走的是真通知
 * 订阅(fixtures 的 __fireOpenReview),故 id 给成一条提交范围子行时,验得到 tab 认的是容器、
 * 屏落在那个 commit 上。挂载后再发 —— 订阅是 App 挂载时装的。
 */
const openTarget = params.get('open');
if (openTarget) {
  setTimeout(() => {
    (
      window as unknown as { __fireOpenReview?: (p: { reviewId: string; discussionId?: string }) => void }
    ).__fireOpenReview?.({ reviewId: openTarget, discussionId: params.get('open-discussion') ?? undefined });
  }, 600);
}

createRoot(container).render(
  <StrictMode>
    <SettingsProvider>
      {asRestore ? (
        <App />
      ) : (
        <App
          initialReviewId={initialTabs[0] ?? 'demo'}
          initialScreen={initialScreen ?? undefined}
          initialTabs={initialTabs.length ? initialTabs : undefined}
        />
      )}
    </SettingsProvider>
  </StrictMode>,
);
