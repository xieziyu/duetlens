// design-sync 的打包入口:把 src/renderer 里的通用件收成一个 DS 导出面。
// 这里只做 re-export 与预览时的环境补齐,组件实现一律以仓库源码为准。
//
// 两处非显然的接线:
//  · 全局样式(tokens / .wordmark / .dl-mark / .theme-controls)住在 index.css 与 App.css,
//    不由任何组件自己 import —— 不在这里拉进来,打出的 _ds_bundle.css 就少了这一半。
//  · useSettings 的两个件(AppRail / ThemeControls)要 SettingsProvider,而它首帧走 IPC 拉偏好。
//    复用仓库自己的预览桩(preview/fixtures.ts)补上 window.duetlens;真 Electron 里 preload
//    已经注入过,故只在缺席时装,不覆盖真实现。
import { installPreviewApi } from '../src/renderer/preview/fixtures';
import '../src/renderer/index.css';
import '../src/renderer/App.css';

declare const window: Window & { duetlens?: unknown };
if (typeof window !== 'undefined' && !window.duetlens) installPreviewApi();

// LogoMark 不在其中:它用 vite 的 `?raw` 读 build/logo/*.svg,
// esbuild 只会把该 import 解成 data URL(#→%23),调色与 url(#id) 改写全部落空 —— 宁可不发,也不发一个画错的标记。
export { SettingsProvider } from '../src/renderer/settings/SettingsProvider';

export { AppRail } from '../src/renderer/components/AppRail';
export { CapacityNotice } from '../src/renderer/components/CapacityNotice';
export { CompletionToast } from '../src/renderer/components/CompletionToast';
export { KbdHelp } from '../src/renderer/components/KbdHelp';
export { LensScanArt } from '../src/renderer/components/LensScanArt';
export { ReviewTabs } from '../src/renderer/components/ReviewTabs';
export { ScreenPlaceholder } from '../src/renderer/components/ScreenPlaceholder';
export { SourceIcon } from '../src/renderer/components/SourceIcon';
export { StartSteps } from '../src/renderer/components/StartProgress';
export { ThemeControls } from '../src/renderer/components/ThemeControls';
export { Wordmark } from '../src/renderer/components/Wordmark';
