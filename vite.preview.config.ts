import { mergeConfig, type Plugin } from 'vite';
import rendererConfig from './vite.renderer.config';

// 只开 origin 的调用方(浏览器预览面板、`open http://localhost:5177`)拿到的会是 Electron 的
// index.html —— 那里没有 preload 注入的 window.duetlens,只剩白屏,所以把 / 送到真正的预览入口。
function previewEntryRedirect(): Plugin {
  return {
    name: 'duetlens-preview-entry-redirect',
    apply: 'serve',
    configureServer(server) {
      // 在 configureServer 里直接 use 会插到 vite 内置中间件之前,先于 html 处理拦下 /
      server.middlewares.use((req, res, next) => {
        const [pathname, query] = (req.url ?? '/').split('?');
        if (pathname !== '/' && pathname !== '/index.html') return next();
        // 302 而非内部 rewrite:让地址栏留下 /preview.html,顺带把 ?screen= 之类带过去
        res.writeHead(302, { Location: `/preview.html${query ? `?${query}` : ''}` });
        res.end();
      });
    },
  };
}

export default mergeConfig(rendererConfig, { plugins: [previewEntryRedirect()] });
