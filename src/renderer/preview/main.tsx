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

createRoot(container).render(
  <StrictMode>
    <SettingsProvider>
      <App initialReviewId="demo" />
    </SettingsProvider>
  </StrictMode>,
);
