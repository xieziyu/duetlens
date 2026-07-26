import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 把 package.json 的 version 注入成 `__APP_VERSION__`,供 src/shared/version.ts 取用。
 * root 由调用方传自己的 `__dirname` —— vite 打包配置时本模块的 `__dirname` 不可靠。
 */
export function appVersionDefine(root: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.resolve(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  return { __APP_VERSION__: JSON.stringify(pkg.version) };
}
