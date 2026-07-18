# UI 方向

> 返回 [文档索引](../README.md)
>
> 状态:方向已定,细化待补(后续可拆出线框/交互/组件分册)。

- 整体重新设计。
- **diff review 是主场**——用户交互最多的界面。
- 倾向 **三栏 + 内联 discussion** 布局:文件树 / diff 主区(可在任意行框选发起 discussion、内联展开 finding 与对话)/ 右侧会话或 finding 详情。
- 交互重心从 1.0 的"看 finding"转为"**在 diff 上对话**"。1.0 的 `files-changed/*` 组件可作为设计语言的雏形。
- **diff 折叠/展开**(沿用 1.0):默认折叠 hunk 之间及上下的未改动代码,以折叠条(`↕ 展开 N 行 · 行号区间`)标示;点击逐段展开,直至看到完整文件内容。整文件也可折叠(file-header 的 chevron)。

## 视觉标识:duet 双声道

用**两套色语言**贯穿全局区分说话方:**agent(codex)= 靛蓝**,**human(你)= 琥珀**。作用于代码行 gutter 锚点、finding/discussion 卡片、消息头像、文件树徽标。这是 Duetlens 的记忆点,也让"谁发起的"一眼可辨。

字体:wordmark 用 Instrument Serif(人文衬线,点"对话"),工具体 IBM Plex Sans / Plex Mono(工程感),避开通用 AI 味。

## 主题:两个正交轴

明暗模式与配色主题是**两个独立开关**,可任意组合:

- **明暗模式** `data-mode` = `light` / `dark` —— Duetlens 品牌**外壳(chrome)**的明暗。**必须做双模式**(不能只深色)。
- **配色主题** `data-theme` = `duetlens` / `github` / …(后续 One Dark 等)—— **一整套 code-review 表面配色**,不止语法。理由:开发者对配色有既有偏好(不少人惯用 GitHub),不应绑死在品牌色上。

**配色主题是"成套"的,不只有语法 token**,它打包所有该随主题走的可调配色部件:

- 语法 token(`--k/--fn/--s/--n/--c/--ty/--mac`)+ 代码正文色(`--code-text`)
- diff 增删的前景/背景/gutter(`--add/--del/--add-bg/--del-bg/--add-gutter/--del-gutter`)
- severity 徽标色(`--sev-high/--sev-med/--sev-low`)——与该主题的 diff 红/警告色协调
- 代码内引用/搜索高亮(`--code-hl`)
- (后续:折叠标记、blame 底色等新可调部件都归入配色主题变量)

实现要点:

- 全走 CSS 变量,`:root[data-mode][data-theme]` 组合覆盖;**CHROME 变量与 THEME 变量分离、互不耦合**。新增配色主题只需补一组 THEME 变量,不动外壳。
- **配色主题跟随明暗自动切子模式**:选 `github` 时,深色壳→GitHub Dark、浅色壳→GitHub Light,由 `[data-mode][data-theme]` 组合选择器实现(用户不单独锁定 Dark/Light 子模式)。
- **duet 双声道 accent(agent 靛蓝 / human 琥珀)属于 chrome、跨配色主题恒定**,是品牌标识;仅随明暗取不同深浅(浅色下加深以保证对比度)。
- mockup `mockup/diff-review.html` 已实装四组合(dark/light × Duetlens/GitHub),顶栏可实时切换,可作实现基线。

## 已有 mockup

- `mockup/diff-review.html` —— 核心屏:三栏 + 内联 discussion + 两轴配色切换。
- `mockup/submit-to-github.html` —— findings 筛选与提交到 GitHub 的流程屏(见 [findings-submit](findings-submit.md))。

> 迭代界面时按偏好用 HTML mockup 对齐(而非 ASCII 预览)。后续细化(线框、状态机、组件清单、空态/加载态)在本目录新增分册,并在 [文档索引](../README.md) 登记。
