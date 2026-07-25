import { app, BrowserWindow, Notification, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from '@backend/ipc';
import { openDatabase } from '@backend/db/database';
import { ReviewStore } from '@backend/db/review-store';
import { ReviewManager } from '@backend/review/review-manager';
import { createCompletionNotifier } from '@backend/notify/completion-notifier';
import { IpcEvents, type CompletionNotice, type ReviewEvent } from '@shared/ipc';

// 开发态与打包版可能同时开着:各自独立 userData,否则两个进程写同一个 sqlite,
// 且各自的内存态互相看不见对方的写入。DUETLENS_USER_DATA 可显式指向某份数据
// (如直接开使用版的库排查问题),前提是确保只有一个实例在跑。ready 前必须设好。
const userDataOverride = process.env.DUETLENS_USER_DATA;
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
} else if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

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
      preload: path.join(__dirname, '../preload/index.js'),
      // Electron 安全基线(见 docs/architecture.md)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 应用内外链交系统默认浏览器,不开 Electron 子窗口;应用本身是 SPA,不做整页跳转。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    e.preventDefault();
    if (url.startsWith('https://')) void shell.openExternal(url);
  });

  // ELECTRON_RENDERER_URL 由 electron-vite dev 注入
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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
    mainWindow.webContents.send(IpcEvents.notifyOpenReview, {
      reviewId: notice.reviewId,
      discussionId: notice.discussionId,
    });
  });
  n.show();
}

app.whenReady().then(() => {
  const db = openDatabase(path.join(app.getPath('userData'), 'duetlens.db'));
  manager = new ReviewManager(new ReviewStore(db));

  // 过期历史在建窗前清一次:此刻还没有活跃会话,删库不会抽走运行中会话的行。
  manager.pruneExpiredReviews();

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
