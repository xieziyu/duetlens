import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { appVersionDefine } from './scripts/app-version-define';

// 同时被 electron.vite.config.ts(打包 renderer)和 vite.preview.config.ts(纯 vite 浏览器预览)使用。
// 必须保持成对象形式:electron.vite.config.ts 用 mergeConfig 合成它,函数式 config 合不进去。
// root 必须显式指向项目根:index.html / preview.html 都在这里,electron-vite 默认的 src/renderer 不适用。
export default defineConfig({
  root: __dirname,
  define: appVersionDefine(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
