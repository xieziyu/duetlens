/**
 * 自动更新的状态机。main 侧 electron-updater 的事件收敛成这几档,renderer 只认这里。
 *
 * 更新默认后台下好、退出时静默装上(autoInstallOnAppQuit),所以 UI 只有一处:
 * 设置屏「关于」的一行 —— 用户不去看也照样能升级,去看则能提前手动重启。
 */
export type UpdateStatus =
  /** 打包外(dev)或渠道不可用 —— 不做检查,UI 隐藏整行 */
  | { phase: 'unsupported' }
  /** 尚未检查过 */
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** 已是最新 */
  | { phase: 'current' }
  | { phase: 'downloading'; version: string; percent: number }
  /** 已下好,重启即生效 */
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };
