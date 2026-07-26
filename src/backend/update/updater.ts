import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@shared/update';

// electron-updater 是 CJS,具名 import 在 ESM 产物下会拿到 undefined,只能默认导入后解构
// eslint-disable-next-line import/no-named-as-default-member
const { autoUpdater } = electronUpdater;

/** 启动后延迟首查:让窗口先画出来,别和冷启动抢带宽。 */
const FIRST_CHECK_DELAY_MS = 8_000;
/** 常驻期间的复查间隔。 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdaterDeps {
  /** 状态变化推给所有窗口 */
  onStatus: (status: UpdateStatus) => void;
  /** 装更新前拆掉活跃会话(复用退出时那套收尾) */
  cleanup: () => Promise<void>;
}

export interface Updater {
  getStatus(): UpdateStatus;
  check(): void;
  install(): Promise<void>;
  dispose(): void;
}

/**
 * electron-updater 的薄封装。渠道是 electron-builder 在打包时写进 app-update.yml 的
 * GitHub Releases,所以这里不碰 setFeedURL。
 *
 * 默认后台下载 + 退出时安装:用户什么都不做也能升级,设置屏那行只是让他能提前重启。
 * dev 下没有 app-update.yml,直接停在 unsupported,别让 updater 在开发态刷错误。
 */
export function createUpdater({ onStatus, cleanup }: UpdaterDeps): Updater {
  let status: UpdateStatus = { phase: app.isPackaged ? 'idle' : 'unsupported' };
  let timer: NodeJS.Timeout | undefined;

  function set(next: UpdateStatus): void {
    status = next;
    onStatus(next);
  }

  if (!app.isPackaged) {
    return {
      getStatus: () => status,
      check: () => undefined,
      install: async () => undefined,
      dispose: () => undefined,
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ phase: 'current' }));
  autoUpdater.on('update-available', (info) =>
    set({ phase: 'downloading', version: info.version, percent: 0 }),
  );
  autoUpdater.on('download-progress', (p) => {
    // version 只在 update-available 里给,进度事件没有,沿用当前档里的
    const version = status.phase === 'downloading' ? status.version : '';
    set({ phase: 'downloading', version, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => set({ phase: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => set({ phase: 'error', message: err.message }));

  function check(): void {
    // 已经下好了就别再查:再查一轮会把 ready 冲回 checking,用户那颗「立即重启」按钮就没了
    if (status.phase === 'ready' || status.phase === 'downloading') return;
    void autoUpdater.checkForUpdates().catch((e: unknown) => {
      set({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }

  const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
  timer = setInterval(check, RECHECK_INTERVAL_MS);

  return {
    getStatus: () => status,
    check,
    async install() {
      if (status.phase !== 'ready') return;
      // 先拆会话再交给 Squirrel:quitAndInstall 会立刻走退出流程,
      // 那之后 codex 子进程没人管,会成为孤儿活到用户手动 kill。
      await cleanup();
      autoUpdater.quitAndInstall();
    },
    dispose() {
      clearTimeout(first);
      if (timer) clearInterval(timer);
      timer = undefined;
      autoUpdater.removeAllListeners();
    },
  };
}
