# design-sync 笔记(duetlens)

这个仓库**不是**组件库,是 Electron 应用。design-sync 走 `package` shape,但没有 `dist/`、
`package.json` 的 `main` 指向主进程产物。下面几条都是为这个事实绕出来的路,别当成默认流程。

## 打包入口是手写的 barrel

- `cfg.entry` = `.design-sync/ds-entry.tsx`(committed)。**不要**让转换器走 synth-entry:
  它会 `export * from` `srcDir` 下每个 tsx,把 backend / 屏级组件全卷进来。
- barrel 里做三件在别处看不出来的事:
  1. `import '../src/renderer/index.css'` + `App.css` —— 全局样式(tokens、`.wordmark`、`.dl-mark`、
     `.theme-controls`)不由任何组件自己 import,不在这里拉进来,`_ds_bundle.css` 就少一半。
  2. 缺席时才调 `installPreviewApi()`(仓库自己的预览桩)—— `SettingsProvider` 首帧走
     `window.duetlens.ui.getSettings()`,没有 preload 时会炸。真 Electron 里不覆盖真实现。
  3. 导出 `SettingsProvider` 供 `cfg.provider` 用。
- 组件清单靠 `cfg.componentSrcMap` 显式列出(没有 `.d.ts` 树可发现)。加组件要同时改 barrel 和这份 map。

## props 契约全靠 `cfg.dtsPropsFor` 手写

没有 dist `.d.ts`,自动抽取一律退化成 `[key: string]: unknown` —— 对 design agent 等于没有契约。
11 个组件的 props 是从源码抄进 `dtsPropsFor` 的,**领域类型已就地展开**(`LiveCapacity`、`ReviewTab`、
`TabMeta`、`SourceKind`、`ReviewStatus`、`ReviewStartStage`),这样 `.d.ts` 自包含、能独立通过 tsc。
**改了组件 props 或这些领域类型,必须回来同步 `dtsPropsFor`,没有任何机制会提醒你。**

## LogoMark 被排除(`componentSrcMap.LogoMark = null`)

它用 vite 的 `?raw` 读 `build/logo/*.svg`。esbuild 没有 `?raw`,会把该 import 解成 **data URL**,
于是 `#` 变 `%23`:调色板替换(`#4a5261` → `var(--mk-code)`)与 `url(#dl-outside)` 的 id 改写全部落空,
标记渲染成空/坏图。修它需要给 esbuild 加 loader,而 `lib/bundle.mjs` 是契约面不许 fork。
**想把 LogoMark 发出去,只能改组件本身**(例如把 svg 文本挪成 `.ts` 常量,不再依赖 `?raw`)。

## 预览卡的底色要靠 `cfg.cssEntry` 夺回来

卡片模板内联 `<style>body{background:#fff}</style>`,排在样式表之后。duetlens 是 dark-first
(`DEFAULT_UI_SETTINGS.dataMode = 'dark'`),浅色正文落白底上几乎读不出来。
`.design-sync/ds-preview.css` 用 `background-color: var(--bg) !important` 抢回来 —— `!important`
才压得过后置的内联 `<style>`。**这条会随 `styles.css` 闭包进到每张设计稿**,是有意的:
duetlens 的底就是它自己的 `--bg`。

## 两个 overlay 组件要自带「舞台」

`KbdHelp`(`.kbd-overlay` 是 `position:fixed;inset:0`)与 `CompletionToast`(`.toast-wrap` 固定在右下角)
直接放进卡里会以视口为参照跑到卡外。两份 preview 都包了一层 `transform: translateZ(0)` 的容器 ——
带 transform 的祖先会成为 fixed 的包含块。配套的 `cfg.overrides` 是 `cardMode: single`;
`ReviewTabs` 是整幅 tab 条,用 `cardMode: column`。

## 字体:纯系统栈,没有字体要发

`tokens.css` 的 `--sans` / `--mono` 现在是纯系统字体栈(`system-ui` / `ui-monospace`),
仓库里没有 `@font-face`、没有字体文件、`index.html` 也没有字体链接 —— **没有缺失字体**,
`cfg` 不需要 `extraFonts` 也不需要 `runtimeFontPrefixes`。

历史(别再翻旧账):首次同步时 tokens 还声明着 IBM Plex 却从不加载它,当时用
`runtimeFontPrefixes` 抑制了 `[FONT_MISSING]`;`800ff15 chore(theme): drop the unused IBM Plex
font stack (#82)` 之后字体栈被彻底删掉,该配置项随之移除。`mockup/` 里仍有 IBM Plex 引用,
但那个目录已冻结、不参与同步,**不要**据它判断当前字体。

## `tokens/` 目录是空的,不是 bug

`copyTokens` 要求 `cfg.tokensPkg` 是 node_modules 里的包;duetlens 的 tokens 在仓库内,
所以 `tokensGlob` 单用无效(已从 config 移除)。tokens 经 `index.css` 编进 `_ds_bundle.css`,
`styles.css` @import 它 —— **设计稿拿得到全部 73 个 token**,只是 DS 面板没有独立的 token 文件可列。

## 环境

- 全局 `npm config ignore-scripts=true`。装转换器依赖必须 `npm i --ignore-scripts=false ...`,
  否则 esbuild 的二进制不会落地(装完先跑一次 `transform` 验一下)。
- playwright 的 chromium 在 macOS 落在 `~/Library/Caches/ms-playwright/`(不是 `~/.cache/`)。
- 别为 design-sync 跑 `npm run rebuild:*` —— 会弄坏正开着的 app 的 ABI。

## 已知的渲染 warn(核对用)

- 当前一条都没有:最后一次 validate 零 warning、11/11 渲染干净、25 个 cell 全 good。
- `LensScanArt` 的 `Idle`(lit=0)与 `Scanning`(lit=5)差异**真实但细微**(只是行的提亮),
  截图上乍看接近。这不是坏掉,别当成 `variantsIdentical` 去"修"。

## 锚点对「只改了 CSS」是敏感的(已实测,别再怀疑)

`styleShaFor` 里有一行 `hashFile(h, join(OUT, '_ds_bundle.css'), 'bundlecss')` —— 组件 CSS 的内容
**在指纹里**。2026-08-25 做过对照实验:把构建产物整份复制一份、**只**把 `_ds_bundle.css` 里的字体栈
改回 IBM Plex,其余文件一字不动,`styleSha` 立刻从 `ba9c1bca…` 变成 `1453e073…`。
所以 tokens 或任何组件 `.css` 改了,`upload.styling` 一定会翻成 true。

写下这条是因为首次同步时我曾误判它「看不见 CSS 变更」并写进过 NOTES:当时拿**跑到一半时的一次早期构建**
(那会儿 `#82` 还没落地)去和收尾构建比,把「仓库在我自己两次构建之间前进了」错当成哈希漏算。
**别再据此给上传加特判。**教训在下面风险清单第一条。

## Re-sync 风险清单

- **`dtsPropsFor` 会悄悄过期**:它是源码的手抄件。组件 props 改了、领域类型改了,契约不会自动跟。
  每次 re-sync 至少扫一眼 `src/renderer/components/*.tsx` 的签名与 `src/shared/domain.ts` 的枚举。
- **preview 里的 fixture 是硬编码的**,不来自 `preview/fixtures.ts`。真实字段若改名(如 `TabMeta.unread`),
  preview 仍能编译但会渲染错内容。
- **`installPreviewApi()` 与 fixtures.ts 强耦合**:那个文件重构或改导出名,barrel 直接编译失败。
- **`?raw` 一类 vite-only 语法是雷区**:任何组件新引入 `?raw` / `?url` / `?inline`,
  bundle 要么失败要么静默产出坏值。新增组件后先看一眼它的 import。
- 只验证到「无头 chromium 里静态渲染正确」。hover / 拖拽 / 动画中段没有验,
  `LensScanArt` 的扫描动画是连续的,截图相位每次不同。
- **仓库会在同步途中被别人推进,你自己早期的读数因此会过期**。首次同步跑到一半时 `#82`~`#84`
  陆续落地(含删字体那一笔),后续构建静默吃进了新代码。收尾前重新确认一遍:11 个组件的 props 签名、
  `shared/domain.ts` 的枚举、`tokens.css` 的字体与配色 —— 别拿开跑时的读数交付。
  **更要紧的是别拿早期构建产物当基线去推断工具链有 bug**:先 `git log` 看仓库动没动,
  再怀疑哈希/差分。上面那条实测就是这么白跑一趟的。
- 本次未同步 `screens/**` 下的领域组件(InlineCard / ProposalCard / DiffPane 等),
  用户明确选的范围就是 `components/` 那一批。要扩范围就是加 barrel 导出 + `componentSrcMap` + `dtsPropsFor`。
