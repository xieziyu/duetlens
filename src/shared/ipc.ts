/**
 * IPC 契约:main(Node 后端)与 renderer(React)之间的唯一通道定义。
 * preload 经 contextBridge 暴露 `window.duetlens`,renderer 只依赖这里的类型。
 */
import type { Finding, Review, UiSettings } from './domain';
import type { AgentEvent } from './agent-events';

// ---- 请求/响应(ipcRenderer.invoke ↔ ipcMain.handle)----
export const IpcChannels = {
  appGetInfo: 'app:get-info',
  reviewList: 'review:list',
  reviewGet: 'review:get',
  reviewFindings: 'review:findings',
  reviewStartDemo: 'review:start-demo',
  uiGetSettings: 'ui:get-settings',
  uiSaveSettings: 'ui:save-settings',
} as const;

/** 后端 → renderer 单向推送(webContents.send) */
export const IpcEvents = {
  reviewEvent: 'review:event',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
}

/** 一次 review 生命周期里推给 renderer 的领域事件。 */
export type ReviewEvent =
  | { reviewId: string; type: 'finding'; payload: Finding }
  | { reviewId: string; type: 'status'; payload: Review['status'] }
  | { reviewId: string; type: 'agent'; payload: AgentEvent };

/** contextBridge 暴露到 renderer 的 API 形状。 */
export interface DuetlensApi {
  getAppInfo(): Promise<AppInfo>;
  review: {
    list(): Promise<Review[]>;
    get(id: string): Promise<Review | null>;
    findings(reviewId: string): Promise<Finding[]>;
    /** 起一个内置 fixture 的演示审核;立即返回 review,findings 经事件流入。 */
    startDemo(): Promise<Review>;
    /** 订阅领域事件;返回取消订阅函数。 */
    onEvent(handler: (e: ReviewEvent) => void): () => void;
  };
  ui: {
    getSettings(): Promise<UiSettings>;
    saveSettings(settings: UiSettings): Promise<void>;
  };
}
