# 设计系统:tokens 与组件清单

> 返回 [文档索引](../README.md)
>
> 状态:tokens 与组件清单当初从稳定的 mockup 抽出,现已落地为 `src/renderer/theme/tokens.css`。可视化清单 `mockup/design-system.html` 属**已冻结的历史存档**(见 [ui.md](ui.md#mockup历史存档已冻结))。

配色 tokens 收成**单一来源**,重复出现的组件登记成清单。

## Tokens 单一来源:`src/renderer/theme/tokens.css`

所有配色变量集中在 `src/renderer/theme/tokens.css`(经 `src/renderer/index.css` 引入),由**两个正交轴**驱动(勿在各处内联复制)。`mockup/tokens.css` 是冻结时的一份历史副本,**不要改那个**:

- `data-mode` = `light | dark` —— 明暗**品牌外壳**(chrome:bg / surface / border / text / brand / 阴影 / 辉光)。
- `data-theme` = `duetlens | github` —— **配色主题**,成套:语法 token(`--k/--fn/--s/--n/--c/--ty/--mac`)+ diff(`--add/--del` 及 bg/gutter)+ severity(`--sev-high/med/low`)+ 代码高亮。主题跟随 `data-mode` 自动切子模式(GitHub → Dark/Light),四种组合。

CHROME 与 THEME 变量分离、互不耦合;**新增主题只补一组 THEME 变量**(如 One Dark)。共享 primitives(`--mono` / `--sans` / `--r`)也在 tokens.css;屏幕特有的布局变量(如 `--left-w` / `--right-w`)留在各屏自己的 CSS。

### Token 分组

| 组 | 变量 | 说明 |
| --- | --- | --- |
| Chrome | `--bg` `--surface(-2/-3)` `--border(-soft)` `--text(-dim/-faint)` `--hover` `--sel` `--shadow` `--glow1/2` | 明暗外壳,随 `data-mode` |
| Brand · 双声道 | `--agent` `--agent-2/-soft/-line` `--accent-solid` `--on-solid` `--human` `--human-soft/-line` `--on-accent` | agent=天蓝、human=琥珀;实心 CTA 用 `--accent-solid` + 白字 |
| Severity | `--sev-high/-med/-low` | 随 `data-theme` |
| Diff | `--add` `--del` 及 `-bg` / `-gutter` · `--code-hl` | 随 `data-theme` |
| Syntax | `--code-text` `--k` `--fn` `--s` `--n` `--c` `--ty` `--mac` | 随 `data-theme` |

## 品牌标记

标记的含义是**镜片压在一页代码上**:镜外密排细行是上下文,镜内被放大的三行分别是灰(上下文)、天蓝(agent)、琥珀(human),配色沿用 tokens 的 `--agent` / `--human`。

手写 SVG 是单一来源,按渲染尺寸分三档美术,`build/logo/` 下:

| 文件 | 用于 | 差别 |
| --- | --- | --- |
| `mark.svg` | ≥128px | 完整:镜外密排代码 + 镜内三行 |
| `mark-small.svg` | 32–64px | 去掉镜外细行(3.4pt 的行到这个尺寸会糊成噪点) |
| `mark-tiny.svg` | 16px | 再去掉内圈与灰行,只留镜圈 + agent/human 两行 |

`build/icon.icns` 与 `build/icon.png` 是产物,由 `npm run icons:gen` 从上面三个 SVG 生成(套 macOS Big Sur 的 824/1024 底板栅格),已提交进仓库——打包机因此不需要 `rsvg-convert`,只有改图时才要装(`brew install librsvg`)。改完 SVG 记得重跑该命令。

`electron-builder.yml` 显式指向 `build/icon.icns`,不让 electron-builder 从单张 png 自动缩——那样会丢掉分档美术。

### 界面内的标记:`<LogoMark size>`

界面里不另画一份几何,`components/LogoMark.tsx` 直接 `?raw` 读上面三个 SVG,只做两件事:把固定色板换成 `.dl-mark` 上的 `--mk-*` 变量(于是跟随明暗/配色),把 `defs` 的 id 按实例改写(多处同时挂载时 clip 不串)。改配色改 `App.css` 的 `.dl-mark`,改几何改 `build/logo/*.svg`(记得重跑 `icons:gen`)。

分档阈值按 CSS px 折半(屏上是 2x 矢量渲染):≥64 用完整档,>20 用 small,其余 tiny。落位:

| 位置 | 尺寸 | 搭配 |
| --- | --- | --- |
| 通用顶栏 / onboarding 顶栏 | 20 | `.brand` 里紧挨 wordmark |
| review 顶栏 | 20 | 这条栏替掉了通用顶栏,同一枚 `.brand` + 分隔线要补在来源 chip 之前 |
| entry hero | 64 | wordmark 之上 |
| onboarding hero | 72 | wordmark 之上 |

## 可视化清单:`mockup/design-system.html`

自包含的 style guide,链接 `tokens.css`,右上角可实时切换 `data-mode × data-theme` 四种组合。含:色板(从 tokens 自动渲染并显示 resolved 值)、字阶(IBM Plex Sans + Mono,去手写体)、radius / elevation、以及组件样例(buttons / chips·tags·status / segmented·tabs / inputs / cards 四态 / popover / 文件树行 / gutter 锚点)。

## 组件清单

以 `diff-review.html` 为准,组件 → 用途 → 关键 class → 状态:

| 组件 | 用途 | 关键 class | 状态 |
| --- | --- | --- | --- |
| Nav rail | 全局导航:入口/当前审核/历史/规则 ▸ 明暗/设置 | `.rail .rail-btn` | on / hover |
| Top bar | 来源 chip(含 ⧉ 外链)/ 标题 / 提交 CTA | `.topbar .pr-chip .submit-cta` | github / 本地 |
| Status bar | agent 运行态(codex · 模型 · effort)· ctx/token | `.statusbar .sb-status .sb-item .sb-agent` | scan / reviewing / failed |
| File header | 文件名 / 路径两行 + 计量 + 已看/折叠 | `.file-header .fh-name .fh-path .fh-meta .fh-btn` | viewed / collapsed |
| File tree | 改动文件 + finding 徽标 + Viewed | `.tree .file .badge .vtick` | active / viewed |
| Diff | unified / split 代码 + 展开未改动 | `.code.unified .code.split .expander` | unified / split / collapsed |
| Inline card | 内联 finding / discussion | `.card.agent .card.human` | view / edit / submitted / dismissed |
| Finding editor | 就地编辑 sev/cat/标题/正文/suggestion | `.c-edit .fe-sev .fe-input .fe-textarea` | editing |
| Selection popover | 框选发起 discussion / 记为 finding | `.sel-pop .sp-disc .sp-finding` | show |
| off-diff 区 | 非改动行锚点的 finding 集合 | `.offdiff .odf` | open |
| Right tabs | Discussion / Findings / Summary | `.tabs .tab .findings-panel .summary-panel` | active |
| Findings list | 运行时 triage 列表 | `.frow .triage .fg-head` | kept / dismissed / submitted |
| Summary | 结论卡 + 统计 + 可编辑正文 | `.sum-verdict .sum-stats .sb-editor` | view / editing |
| Composer | 追问活跃 discussion + @file | `.composer .file-menu` | — |
| Scan progress bar | 机审进度:整幅横条 + 展开的竖排时间线 | `.scanbar .sb-step .timeline .tl` | done / active / pending |

## 收敛 TODO(实现项)

- `diff-review.html`、`entry.html`、`design-system.html` **均已改用 `tokens.css`**,不再内联配色变量;各页只留屏幕特有覆盖(如 diff-review 的 `--left-w/--right-w`、entry 的 `--r:10px` 圆角与更深阴影)。
- 组件样式目前分散在各 mockup 内联;实现阶段按本清单抽成组件层(React 前端),tokens.css 直接复用。组件树分解见 [frontend-components](frontend-components.md)。
- Viewed / 栏宽等 UI 状态的持久化(按用户 / review):分层、粒度与 schema 见 [frontend-components](frontend-components.md)「UI 状态持久化」。
