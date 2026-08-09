import { defineConfig } from 'vite';
import path from 'node:path';

// 官网(GitHub Pages)。独立于 renderer 那套构建:不进 Electron、不需要 React,
// 但**直接 import 应用的真实 CSS**(tokens / ReviewScreen / submit),
// 这样落地页里的产品截面跟着应用一起改,不会退化成手抄的第二份样式。
export default defineConfig({
  root: path.resolve(__dirname, 'site'),
  // 部署在 https://<user>.github.io/duetlens/ 下,资源必须带仓库名前缀;
  // 换自定义域名时把这里改回 '/'。
  base: '/duetlens/',
  build: {
    outDir: path.resolve(__dirname, 'site/dist'),
    emptyOutDir: true,
  },
});
