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
