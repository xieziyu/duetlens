import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 同时被 electron.vite.config.ts(打包 renderer)和 preview:ui(纯 vite 浏览器预览)使用。
// root 必须显式指向项目根:index.html / preview.html 都在这里,electron-vite 默认的 src/renderer 不适用。
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
