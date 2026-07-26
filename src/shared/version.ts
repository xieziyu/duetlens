/**
 * 客户端版本号的唯一来源。发给 app-server / MCP 的 clientInfo 都取这里,发版只改 package.json。
 *
 * 值由三份 vite 配置在构建期 define 注入(main / preload / renderer 各一份,漏一份就会静默回落)。
 * spike 脚本在 tsx 下跑,没有 define,回落到 npm run 暴露的 npm_package_version。
 * main 里展示用的 `app.getVersion()` 读的是同一个 package.json,不是第二份来源。
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string'
    ? __APP_VERSION__
    : (globalThis.process?.env?.npm_package_version ?? '0.0.0-dev');
