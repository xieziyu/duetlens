import { app, BrowserWindow, Notification, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from '@backend/ipc';
import { openDatabase } from '@backend/db/database';
import { ReviewStore } from '@backend/db/review-store';
import { ReviewManager } from '@backend/review/review-manager';
import { createCompletionNotifier } from '@backend/notify/completion-notifier';
import { hydrateEnv } from '@backend/env/shell-env';
import { createUpdater } from '@backend/update/updater';
import { IpcEvents, type CompletionNotice, type ReviewEvent } from '@shared/ipc';

// 开发态与打包版可能同时开着:各自独立 userData,否则两个进程写同一个 sqlite,
// 且各自的内存态互相看不见对方的写入。DUETLENS_USER_DATA 可显式指向某份数据
// (如直接开使用版的库排查问题)。ready 前必须设好 —— 单实例锁按这个目录加,见下。
const userDataOverride = process.env.DUETLENS_USER_DATA;
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
} else if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// 立刻起 shell 环境探测,与 Electron 自身的启动重叠;whenReady 里 await,基本不额外等。
// 必须在任何 spawn 外部 CLI 之前完成,见 shell-env.ts。
const envReady = hydrateEnv();

let manager: ReviewManager;
let mainWindow: BrowserWindow | null = null;
/** whenReady 里的初始化是否已走完(IPC 已注册、首个窗口已建)。 */
let ready = false;

/**
 * 单实例锁。Electron 按 userData 目录加锁,所以开发态与打包版仍可并存(各自独立目录),
 * 挡的是**同一份库被两个进程同时开着**。
 *
 * 这不只是「窗口别开两个」:冷启动收尾把库里所有 scanning 判成上次退出时的残留
 * (见 ReviewManager.failInterruptedRounds),而两个进程彼此的会话在内存里互不可见 ——
 * 后起的那个会把前一个**正在跑的**那一轮判成中断,两边随后还可能各自重试同一轮。
 * 故必须在开库之前就把这件事定死;userData 已在上面设好,加锁才落在对的目录上。
 */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  // 再次点开时把已经在跑的那个窗口亮到前面,而不是让用户以为没反应
  app.on('second-instance', () => {
    // 初始化还没走完:窗口本来就要建出来,这会儿抢着建等于赶在 IPC 注册之前,拿到的是个空壳
    if (!ready) return;
    // macOS 关掉最后一个窗口后进程还活着(见 window-all-closed),mainWindow 此时是 null ——
    // 直接返回的话,用户再点一次图标仍然什么都不发生,和没加这个处理器一样
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/** `ready-to-show` 迟迟不来(dev server 没起、渲染进程崩)也得把窗口放出来,否则只剩一个看不见的进程。 */
const WINDOW_SHOW_TIMEOUT_MS = 5000;

function createWindow(): void {
  // 主题两轴随查询串交给 renderer:等它自己 IPC 问一遍设置再切,非默认档就先闪一帧默认深色。
  // 库此刻已开(见 whenReady),这里只是多读 ui_settings 一行,没有额外 I/O。
  const { dataMode, dataTheme } = manager.getUiSettings();
  const themeQuery = { mode: dataMode, theme: dataTheme };

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    // 首帧画好再显示。窗口在此之前只有 backgroundColor 一种颜色,而它对不上用户选的档
    // (对得上就得在这儿抄一份 tokens 的色值,那是第二份真相源)。
    show: false,
    backgroundColor: '#0b0d12', // 对齐 tokens 深色 --bg;显示之后只在缩放的重绘间隙露出来
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Electron 安全基线(见 docs/architecture.md)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const showTimer = setTimeout(() => mainWindow?.show(), WINDOW_SHOW_TIMEOUT_MS);
  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimer);
    mainWindow?.show();
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
    const url = new URL(devServerUrl);
    url.search = new URLSearchParams(themeQuery).toString();
    mainWindow.loadURL(url.toString());
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: themeQuery });
  }

  mainWindow.on('closed', () => {
    clearTimeout(showTimer);
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

app.whenReady().then(async () => {
  // quit 与 ready 是两条独立的路,拿不到锁时 ready 仍可能先到 —— 这条路上一步都不能往下走,
  // 尤其不能开库:开了就等于两个进程同时持有同一个 sqlite 连接
  if (!singleInstance) return;
  await envReady;

  const db = openDatabase(path.join(app.getPath('userData'), 'duetlens.db'));
  manager = new ReviewManager(new ReviewStore(db));

  // 过期历史在建窗前清一次:此刻还没有活跃会话,删库不会抽走运行中会话的行。
  manager.pruneExpiredReviews();
  // 同一个时机收上次退出时中断的机审:codex 会话随进程没了,库里那行还停在 scanning,
  // 而 review tab 会跨重启恢复 —— 不收尾就是开屏一个永远转的进度条。
  manager.failInterruptedRounds();

  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  };
  const updater = createUpdater({
    onStatus: (s) => broadcast(IpcEvents.updateStatus, s),
    cleanup: async () => {
      // 置位要在清理之前:cleanup 期间 before-quit 若被触发,得让它放行
      installingUpdate = true;
      await cleanupSessions();
    },
  });
  registerIpcHandlers({ manager, broadcast, updater });

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
  ready = true;

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
let installingUpdate = false;

/**
 * 拆掉所有活跃会话,最多等 {@link QUIT_CLEANUP_TIMEOUT_MS}。
 *
 * `session.dispose()` 里发 SIGTERM 与关 MCP 都是异步的,进程先跑掉的话那些 codex 子进程
 * 就成了孤儿(POSIX 不因父进程退出而杀子进程),一路活到用户手动 kill。
 */
function cleanupSessions(): Promise<unknown> {
  const cleanup = manager?.disposeAll() ?? Promise.resolve();
  const deadline = new Promise((r) => setTimeout(r, QUIT_CLEANUP_TIMEOUT_MS));
  // 拆会话失败也照样往下走,别把错误挡在退出前面
  return Promise.race([cleanup, deadline]).catch(() => undefined);
}

/** 退出前**清完再退**;默认的退出流程不等异步清理,所以拦下这次自己收尾。 */
app.on('before-quit', (e) => {
  // 装更新这条路自己清过了,且必须让退出真的发生 —— 拦下来 Squirrel 就永远等不到进程结束。
  if (installingUpdate) return;
  // 拦下要先于重入判断:清理期间用户再按一次退出,放行的话默认流程当场结束进程,
  // 正好绕过这里的「清完再退」。第一次的收尾跑完(或超时)会统一 exit。
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  // app.exit 不会重新触发本事件
  void cleanupSessions().then(() => app.exit(0));
});
