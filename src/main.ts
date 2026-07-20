import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from '@backend/ipc';

// MAIN_WINDOW_VITE_DEV_SERVER_URL / MAIN_WINDOW_VITE_NAME 由 plugin-vite 注入,
// 类型见 forge.env.d.ts 引用的 @electron-forge/plugin-vite/forge-vite-env

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
