import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { IpcEvents } from '@shared/ipc';

/**
 * 应用菜单。**建这份菜单只为一件事:把 ⌘W 从「关窗口」改判成「关当前 review tab」** ——
 * 菜单加速键先于渲染层拿到按键,不接管菜单的话,renderer 上挂多少 keydown 都轮不到。
 * 关窗口挪到 ⌘⇧W,没有 tab 可关时 renderer 自己回落过去(见 App 的 onCloseTab 订阅)。
 *
 * 其余项一律用 role 保持系统默认行为:macOS 的复制粘贴等编辑键**只在菜单里存在**,
 * 自定义菜单一旦漏掉这些 role,输入框里的 ⌘C / ⌘V 就整个失效。
 */
export function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '关闭 tab',
          accelerator: 'CmdOrCtrl+W',
          // 关谁只有 renderer 知道(哪枚活跃、tab 条在不在屏上、有没有没发出去的原文)
          click: (_item, win) => {
            if (win instanceof BrowserWindow) win.webContents.send(IpcEvents.menuCloseTab);
          },
        },
        { role: 'close', label: '关闭窗口', accelerator: 'Shift+CmdOrCtrl+W' },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit', label: '退出' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        // 非 mac 的默认窗口菜单里有一枚 ⌘W 的「关闭」,留着就是两个同键位的菜单项
        ...(isMac ? ([{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
