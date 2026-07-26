import { defineConfig } from 'electron-vite';
import { mergeConfig } from 'vite';
import path from 'node:path';
import rendererConfig from './vite.renderer.config';
import { appVersionDefine } from './scripts/app-version-define';

// renderer 的 root 固定在项目根(见 vite.renderer.config.ts),入口沿用根目录的 index.html;
// 三段产物分别落在 out/{main,preload,renderer}, package.json 的 main 指向 out/main/index.js。
export default defineConfig({
  main: {
    define: appVersionDefine(__dirname),
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'src/main.ts') },
      },
    },
    resolve: {
      alias: {
        '@backend': path.resolve(__dirname, 'src/backend'),
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    define: appVersionDefine(__dirname),
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'src/preload.ts') },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: mergeConfig(rendererConfig, {
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'index.html') },
      },
    },
  }),
});
