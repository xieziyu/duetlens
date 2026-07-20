import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, IpcEvents, type DuetlensApi, type ReviewEvent } from '@shared/ipc';
import type { UiSettings } from '@shared/domain';

// 唯一暴露给 renderer 的桥;沿 contextIsolation 边界只透出白名单方法。
const api: DuetlensApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appGetInfo),
  review: {
    list: () => ipcRenderer.invoke(IpcChannels.reviewList),
    get: (id) => ipcRenderer.invoke(IpcChannels.reviewGet, id),
    findings: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewFindings, reviewId),
    startDemo: () => ipcRenderer.invoke(IpcChannels.reviewStartDemo),
    onEvent: (handler: (e: ReviewEvent) => void) => {
      const listener = (_e: IpcRendererEvent, payload: ReviewEvent) => handler(payload);
      ipcRenderer.on(IpcEvents.reviewEvent, listener);
      return () => ipcRenderer.off(IpcEvents.reviewEvent, listener);
    },
  },
  ui: {
    getSettings: () => ipcRenderer.invoke(IpcChannels.uiGetSettings),
    saveSettings: (settings: UiSettings) => ipcRenderer.invoke(IpcChannels.uiSaveSettings, settings),
  },
};

contextBridge.exposeInMainWorld('duetlens', api);
