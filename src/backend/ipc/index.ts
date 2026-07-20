import { app, ipcMain } from 'electron';
import process from 'node:process';
import { IpcChannels, IpcEvents, type AppInfo, type ReviewEvent } from '@shared/ipc';
import type { UiSettings } from '@shared/domain';
import type { ReviewManager } from '../review/ReviewManager';

export interface IpcDeps {
  manager: ReviewManager;
  /** 把领域事件推给所有 renderer(main 提供,通常遍历 BrowserWindow) */
  broadcast: (channel: string, payload: unknown) => void;
}

/** 注册 main 侧全部 IPC handler,并把 ReviewManager 事件转发给 renderer。 */
export function registerIpcHandlers({ manager, broadcast }: IpcDeps): void {
  ipcMain.handle(IpcChannels.appGetInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  ipcMain.handle(IpcChannels.reviewList, () => manager.listReviews());
  ipcMain.handle(IpcChannels.reviewGet, (_e, id: string) => manager.getReview(id));
  ipcMain.handle(IpcChannels.reviewFindings, (_e, reviewId: string) => manager.getFindings(reviewId));
  ipcMain.handle(IpcChannels.reviewStartDemo, () => manager.startDemoReview());

  ipcMain.handle(IpcChannels.uiGetSettings, () => manager.getUiSettings());
  ipcMain.handle(IpcChannels.uiSaveSettings, (_e, settings: UiSettings) => manager.saveUiSettings(settings));

  manager.on('review-event', (e: ReviewEvent) => broadcast(IpcEvents.reviewEvent, e));
}
