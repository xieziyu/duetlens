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
| Chrome | `--bg` `--surface(-2/-3)` `--card` `--border(-soft)` `--text(-dim/-faint/-deco)` `--hover` `--sel` `--shadow` `--glow1/2` | 明暗外壳,随 `data-mode` |
| Brand · 双声道 | `--agent` `--agent-2/-soft/-line` `--accent-solid` `--on-solid` `--human` `--human-soft/-line` `--on-accent` | agent=天蓝、human=琥珀;实心 CTA 用 `--accent-solid` + 白字 |
| Severity | `--sev-high/-med/-low` | 随 `data-theme` |
| Diff | `--add` `--del` 及 `-bg` / `-gutter` · `--code-hl` | 随 `data-theme` |
| Syntax | `--code-text` `--k` `--fn` `--s` `--n` `--c` `--ty` `--mac` | 随 `data-theme` |

### 表面阶梯:`--bg` → `--surface` → `--card`

`--bg` 是最"远"的画布(外壳缝隙、中栏代码井),`--surface` 抬起成面板(三栏、rail、顶栏),`--card` 是卡片与列表行 —— **`--card` 永远是三者里更亮的那个**。浅色曾把这条阶梯写反(`--bg:#fff` 最亮、`--surface` 更暗),卡片于是陷进面板里,三栏糊成一片。

深色下 `--card` 与 `--surface` **同值**:深底上一根 `--border` 就够读出抬起 —— 但边线得真的看得见。`--border` 曾只有 1.24:1,抬起这件事其实没被传达,卡片与三栏边界一起糊;现在拉到 1.60:1。浅色近白面上边线会糊,只能靠填充差,`--card` 才拉到纯白。组件因此一律写 `--card`,不必分模式判断。`--surface-2/-3` 表示卡片**内部**的凹陷(引用块 / 输入框 / chip),两个模式都朝远离 `--card` 的方向走。

### 文字阶梯:最低的一档**文字**仍必须能读

| token | 归它的表达 | 底线 |
| --- | --- | --- |
| `--text` | 标题、正文主体 | —— |
| `--text-dim` | 次要内容、元信息、**未选中但可点的分段项** | —— |
| `--text-faint` | 提示、说明、剔除理由、小标签、状态栏 | **≥ 4.5:1** |
| `--text-deco` | 只给非文字与明确失效态:分隔点、spinner 轨道、行号、已剔除项的删除线标题 | 低于 4.5 是有意的 |

判断"是不是失效态"看**它还能不能点**:已剔除的 finding 不再进 review 产物,归 `--text-deco`;而**已看的文件行仍可点、仍要按文件名认出来再打开**,文件名必须留在 `--text-faint`,已看只由删除线 + 绿勾 + 淡掉的行数表达。

`--text-faint` 与 `--text-deco` 曾是同一个值,于是**所有提示文案被装饰的亮度按住**:深色 2.86–3.45:1、浅色 3.25–3.94:1,review 屏一屏 96 处文字不达标。改文案颜色前先分清这处是"要读的"还是"装饰",别把两档重新合上。

两条容易复发的推论:

- **未选中 ≠ 失效。** 分段选择器(`.choice` / `.tab` / `.view-seg` / `.hist-filter` / `.srcseg` / `.int-seg`)的未选中项走 `--text-dim`;用 `--text-faint` 会让二选一长得像单个按钮。真正 disabled 才配 `--text-deco` + `opacity`。
- **阻断性提示不是脚注。** 解释主 CTA 为什么点不动、或"整份会被 422 拒"这类前置条件,至少 `--text-dim` + 警示标记;submit 的失效锚点用 `.foot-note.blocking` 走 `--sev-high` 描边块。

### 语义色当填充时前景要跟着翻

`--sev-high/-med/-low` 是**给文字调的**:深色下它们是浅色调,浅色下才是深色调。所以拿 `--sev-*` 做实心填充时,前景必须用随模式翻转的 `--on-accent`(深色近黑 / 浅色纯白),不能用 `--on-solid` 白字 —— 后者只配 `--accent-solid` 那种两模式都深的底。轮次失败的「重试本轮」和 submit 的「重试提交」都踩过:白字压浅红只有 2.66:1。

反过来,实心按钮**内部**的小垫子(计数徽章、⌘ 提示)要往**深**走 —— `rgba(0,0,0,.22)` 而不是半透明白。白垫会把 `--accent-solid` 冲淡成更亮的蓝,压在上面的白字于是比按钮标签本身还难读(`.cta-badge` 曾是 2.98:1,比标签低 1.1)。深垫同时对上了 `--surface-2/-3` 那套"内部凹陷"的语义。

推论:**给主按钮定底色时要留余量**,不能刚好卡在 4.5 —— 按钮上任何半透明层都会把实际对比度再拉下去。`--accent-solid` 深色现在是 4.92:1。

同理,实心按钮的 hover **不能用 `filter: brightness()` 提亮**:filter 作用于整个元素,白字已经到顶只有底会变亮,对比度必然下降(深色 4.92 → 4.32,hover 时重新不达标)。统一走 `--accent-solid-hover`(压深 12%,两模式各按自己的 `--accent-solid` 现推),压深只会让对比度更好。语义色按钮同理,见 `.submit.retry:hover`。

> 换掉 filter 时注意:`filter` 与 `background` 不冲突,所以原来一条 `.x:hover{filter}` 能盖住所有变体;改成 `background` 后,**同权重但更靠后**的变体规则(`.submit.ghost` / `.submit.retry` / `.btn-copy.done`)会把 hover 的 background 压掉,必须各补一条 hover,否则那些变体会静默失去反馈。

### 选中态的浅色底会吃掉一档对比度

`--agent-soft` / `--human-soft` 把选中项的底抬亮后,`--text-faint` 在上面会掉到 4.2–4.3:1。凡是"选中项里还有一行说明文字"的地方(`.pr-layer.on .path`、`.event.on .ed`),给选中态单独提到 `--text-dim` —— 选中本来就该更显眼,顺带把这档补回来。

### 四条语义轴不共用色相

界面上同时有四套含义在用颜色,必须各自独占,否则一个颜色有多个意思:

| 轴 | 归它的表达 |
| --- | --- |
| Severity | `--sev-high/-med/-low` 三个色相;chip 的底色与边线由 `.sev` 规则从本档 `--sev-*` 现推 |
| 双声道 | agent 蓝 / human 琥珀,只落在卡片左脊与署名 |
| 轮次状态 | 全中性(`--text`/`--text-dim`/`--text-faint` + `--surface-2`),靠字重排序;只有「已修复」用绿 |
| Diff | `--add`/`--del`,只做行底色与 gutter,不做 chip 填充 |

曾经的耦合:`.sev-high` 借 `--del-bg`、`.sev-medium` 借 `--human-soft`、`.sev-low` 借 `--agent-soft`,`.round-tag.still` 又是红、`.new` 与 `.wontfix` 又都是蓝 —— 没有一个颜色只有一个意思。加 severity 档位或轮次状态时,先确认新值不落进别的轴。

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
