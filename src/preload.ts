import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type DuetlensApi } from '@shared/ipc';

// 唯一暴露给 renderer 的桥;沿 contextIsolation 边界只透出白名单方法。
const api: DuetlensApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appGetInfo),
};

contextBridge.exposeInMainWorld('duetlens', api);
