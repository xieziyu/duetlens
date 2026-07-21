import { app, BrowserWindow, Notification } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from '@backend/ipc';
import { openDatabase } from '@backend/db/database';
import { ReviewStore } from '@backend/db/review-store';
import { ReviewManager } from '@backend/review/review-manager';
import { createCompletionNotifier } from '@backend/notify/completion-notifier';
import { IpcEvents, type CompletionNotice, type ReviewEvent } from '@shared/ipc';

// MAIN_WINDOW_VITE_DEV_SERVER_URL / MAIN_WINDOW_VITE_NAME 由 plugin-vite 注入,
// 类型见 forge.env.d.ts 引用的 @electron-forge/plugin-vite/forge-vite-env

let manager: ReviewManager;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d12', // 对齐 tokens 深色 --bg,消除加载白闪
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Electron 安全基线(见 docs/architecture.md)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 未聚焦时弹原生完成通知;点击聚焦窗口并让 renderer 打开该 review。 */
function notifyNative(notice: CompletionNotice): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: notice.title, body: notice.body });
  n.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IpcEvents.notifyOpenReview, { reviewId: notice.reviewId });
  });
  n.show();
}

app.whenReady().then(() => {
  const db = openDatabase(path.join(app.getPath('userData'), 'duetlens.db'));
  manager = new ReviewManager(new ReviewStore(db));

  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  };
  registerIpcHandlers({ manager, broadcast });

  // 长任务完成提示:焦点判定 + 原生通知归 main(独占 BrowserWindow/Notification);
  // review-event 已流经 main,此处再挂一个消费者驱动通知。
  const notifier = createCompletionNotifier({
    isFocused: () => mainWindow?.isFocused() ?? false,
    isEnabled: () => manager.getUiSettings().notifyOnComplete,
    reviewLabel: (id) => {
      const r = manager.getReview(id);
      return r?.title ?? r?.sourceRef ?? id;
    },
    notifyNative,
    notifyInApp: (notice) => broadcast(IpcEvents.notifyInApp, notice),
  });
  manager.on('review-event', (e: ReviewEvent) => notifier(e));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void manager?.disposeAll();
});
