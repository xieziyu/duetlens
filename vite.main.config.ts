import { defineConfig } from 'vite';
import path from 'node:path';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // 原生模块不可打包(含 .node 二进制),运行时从 node_modules 解析;
      // 打包由 auto-unpack-natives 从 asar 解出。
      external: ['better-sqlite3'],
    },
  },
  resolve: {
    alias: {
      '@backend': path.resolve(__dirname, 'src/backend'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
