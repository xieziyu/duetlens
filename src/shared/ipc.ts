/**
 * IPC 契约:main(Node 后端)与 renderer(React)之间的唯一通道定义。
 * preload 经 contextBridge 暴露 `window.duetlens`,renderer 只依赖这里的类型。
 * 后续真实命令(review query / triage / discussion 等)在此扩展。
 */

export const IpcChannels = {
  appGetInfo: 'app:get-info',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
}

/** contextBridge 暴露到 renderer 的 API 形状。 */
export interface DuetlensApi {
  getAppInfo(): Promise<AppInfo>;
}
