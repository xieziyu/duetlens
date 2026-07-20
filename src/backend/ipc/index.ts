import { app, ipcMain } from 'electron';
import process from 'node:process';
import { IpcChannels, type AppInfo } from '@shared/ipc';

/**
 * 注册所有 main 侧 IPC handler。骨架期只有 app:get-info 用于验证桥通;
 * 后续按领域拆子模块(review / findings / discussion / agent)在此汇总注册。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.appGetInfo, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    };
  });
}
