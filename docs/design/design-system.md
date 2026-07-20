# 设计系统:tokens 与组件清单

> 返回 [文档索引](../README.md)
>
> 状态:从稳定的 mockup 抽出 tokens 与组件清单;canonical tokens 已落地 `mockup/tokens.css`,可视化清单在 `mockup/design-system.html`。

从 [`ui.md`](ui.md) 的屏与状态稳定后,把配色 tokens 抽成**单一来源**,并把重复出现的组件登记成清单,为后续 Tauri 实现铺路。

## Tokens 单一来源:`mockup/tokens.css`

所有配色变量集中在 `mockup/tokens.css`,由**两个正交轴**驱动(勿在各页内联复制):

- `data-mode` = `light | dark` —— 明暗**品牌外壳**(chrome:bg / surface / border / text / brand / 阴影 / 辉光)。
- `data-theme` = `duetlens | github` —— **配色主题**,成套:语法 token(`--k/--fn/--s/--n/--c/--ty/--mac`)+ diff(`--add/--del` 及 bg/gutter)+ severity(`--sev-high/med/low`)+ 代码高亮。主题跟随 `data-mode` 自动切子模式(GitHub → Dark/Light),四种组合。

CHROME 与 THEME 变量分离、互不耦合;**新增主题只补一组 THEME 变量**(如 One Dark)。共享 primitives(`--mono` / `--sans` / `--r`)也在 tokens.css;屏幕特有的布局变量(如 `--left-w` / `--right-w`)留在各页。

### Token 分组

| 组 | 变量 | 说明 |
| --- | --- | --- |
| Chrome | `--bg` `--surface(-2/-3)` `--border(-soft)` `--text(-dim/-faint)` `--hover` `--sel` `--shadow` `--glow1/2` | 明暗外壳,随 `data-mode` |
| Brand · 双声道 | `--agent` `--agent-2/-soft/-line` `--accent-solid` `--on-solid` `--human` `--human-soft/-line` `--on-accent` | agent=天蓝、human=琥珀;实心 CTA 用 `--accent-solid` + 白字 |
| Severity | `--sev-high/-med/-low` | 随 `data-theme` |
| Diff | `--add` `--del` 及 `-bg` / `-gutter` · `--code-hl` | 随 `data-theme` |
| Syntax | `--code-text` `--k` `--fn` `--s` `--n` `--c` `--ty` `--mac` | 随 `data-theme` |

## 可视化清单:`mockup/design-system.html`

自包含的 style guide,链接 `tokens.css`,右上角可实时切换 `data-mode × data-theme` 四种组合。含:色板(从 tokens 自动渲染并显示 resolved 值)、字阶(IBM Plex Sans + Mono,去手写体)、radius / elevation、以及组件样例(buttons / chips·tags·status / segmented·tabs / inputs / cards 四态 / popover / 文件树行 / gutter 锚点)。

## 组件清单

以 `diff-review.html` 为准,组件 → 用途 → 关键 class → 状态:

| 组件 | 用途 | 关键 class | 状态 |
| --- | --- | --- | --- |
| Top bar | 来源 / 模型 / ctx / 提交 CTA / 主题切换 | `.topbar .brand .status .submit-cta` | scan / reviewing |
| File tree | 改动文件 + finding 徽标 + Viewed | `.tree .file .badge .vtick` | active / viewed |
| Diff | unified / split 代码 + 展开未改动 | `.code.unified .code.split .expander` | unified / split / collapsed |
| Inline card | 内联 finding / discussion | `.card.agent .card.human` | view / edit / submitted / dismissed |
| Finding editor | 就地编辑 sev/cat/标题/正文/suggestion | `.c-edit .fe-sev .fe-input .fe-textarea` | editing |
| Selection popover | 框选发起 discussion / 追问 | `.sel-pop .sp-disc .sp-ask` | show |
| off-diff 区 | 非改动行锚点的 finding 集合 | `.offdiff .odf` | open |
| Right tabs | Discussion / Findings / Summary | `.tabs .tab .findings-panel .summary-panel` | active |
| Findings list | 运行时 triage 列表 | `.frow .triage .fg-head` | kept / dismissed / submitted |
| Summary | 结论卡 + 统计 + 可编辑正文 | `.sum-verdict .sum-stats .sb-editor` | view / editing |
| Composer | 追问 + @file + 引用选区 | `.composer .refchip .file-menu` | — |
| Scan timeline | 首轮机审进度 | `.scanview .timeline .tl` | done / active / pending |

## 收敛 TODO(实现项)

- `diff-review.html`、`entry.html`、`design-system.html` **均已改用 `tokens.css`**,不再内联配色变量;各页只留屏幕特有覆盖(如 diff-review 的 `--left-w/--right-w`、entry 的 `--r:10px` 圆角与更深阴影)。
- 组件样式目前分散在各 mockup 内联;实现阶段按本清单抽成组件层(Tauri 前端),tokens.css 直接复用。
- Viewed / 栏宽等 UI 状态的持久化(按用户 / PR)。
