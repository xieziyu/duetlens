import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsProvider } from './settings/SettingsProvider';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 未找到');

// 桥缺失只有两种成因:preload 没起来,或有人拿浏览器直开了这个 Electron 入口。
// 直接挂 App 的话会在渲染里逐层抛错,现场只剩白屏加一串 React 错误日志,看不出成因。
if (!window.duetlens) {
  const hint = '缺少 window.duetlens(Electron preload 注入的桥)。浏览器视觉自查请用 npm run preview:ui 并打开 /preview.html;index.html 只能在 Electron 里加载。';
  console.error(`[duetlens] ${hint}`);
  container.textContent = hint;
  container.setAttribute(
    'style',
    'max-width:44rem;margin:14vh auto;padding:0 1.5rem;font:14px/1.8 ui-sans-serif,system-ui,sans-serif',
  );
} else {
  createRoot(container).render(
    <StrictMode>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </StrictMode>,
  );
}
