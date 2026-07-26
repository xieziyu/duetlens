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

/**
 * 清理卡住也得让退出走完:codex 不理 SIGTERM、MCP 连接不断,都不能把「退出」永远挂在这。
 * 超时就直接 exit —— 那时残留一个子进程,总好过一个退不掉的 app。
 */
const QUIT_CLEANUP_TIMEOUT_MS = 3000;
let quitting = false;

/**
 * 退出前拆掉所有活跃会话,**清完再退**。
 *
 * 默认的退出不等异步清理:`session.dispose()` 里发 SIGTERM 与关 MCP 都是异步的,进程先跑掉的话,
 * 那些 codex 子进程就成了孤儿(POSIX 不因父进程退出而杀子进程),一路活到用户手动 kill。
 * 所以拦下这次退出自己收尾,再 {@link app.exit} —— exit 不会重新触发本事件。
 */
app.on('before-quit', (e) => {
  // 拦下要先于重入判断:清理期间用户再按一次退出,放行的话默认流程当场结束进程,
  // 正好绕过这里的「清完再退」。第一次的收尾跑完(或超时)会统一 exit。
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  const cleanup = manager?.disposeAll() ?? Promise.resolve();
  const deadline = new Promise((r) => setTimeout(r, QUIT_CLEANUP_TIMEOUT_MS));
  void Promise.race([cleanup, deadline])
    .catch(() => undefined) // 拆会话失败也照样退出,别把错误挡在 exit 前面
    .then(() => app.exit(0));
});
