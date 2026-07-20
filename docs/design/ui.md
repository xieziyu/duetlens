# UI 方向

> 返回 [文档索引](../README.md)
>
> 状态:方向已定 + 主入口/review 三 tab/扫描态/栏宽/空态错误态/finding 就地编辑器已落地(见「屏与状态」);Summary 编辑态待补。

- 整体重新设计。
- **diff review 是主场**——用户交互最多的界面。
- 倾向 **三栏 + 内联 discussion** 布局:文件树 / diff 主区(可在任意行框选发起 discussion、内联展开 finding 与对话)/ 右侧会话或 finding 详情。
- 交互重心从 1.0 的"看 finding"转为"**在 diff 上对话**"。1.0 的 `files-changed/*` 组件可作为设计语言的雏形。
- **diff 折叠/展开**(沿用 1.0):默认折叠 hunk 之间及上下的未改动代码,以折叠条(`↕ 展开 N 行 · 行号区间`)标示;点击逐段展开,直至看到完整文件内容。整文件也可折叠(file-header 的 chevron)。

## 视觉标识:duet 双声道

用**两套色语言**贯穿全局区分说话方:**agent(codex)= 天蓝**(对齐 better-review brand,oklch hue 245;深 `.72` / 浅 `.52`),**human(你)= 琥珀**。作用于代码行 gutter 锚点、finding/discussion 卡片、消息头像、文件树徽标。这是 Duetlens 的记忆点,也让"谁发起的"一眼可辨。实心按钮用深一档 `--accent-solid` + 白字(蓝底黑字已否决)。

字体:全站 **IBM Plex Sans + IBM Plex Mono**(工程感,去手写体/衬线,避开通用 AI 味);wordmark 为 mono 小写 `duetlens_`(含闪烁光标),结构标签用 mono。

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

## 屏与状态(2026-07-19 落地,以 mockup 为准)

除核心 diff review 外,本轮定下主入口与 review 内的运行时视图。每屏的锚点决策如下,实现时以 mockup 细节为准。

### 主入口 / launcher(`mockup/entry.html`)

- **全屏落地屏**(非命令面板),app 无活动会话时进入。一屏三块:wordmark hero → 发起审核卡片 → 最近的审核(会话历史)。
- **发起审核卡片**:顶部来源 segmented **GitHub PR / 本地分支 / GitButler** 切换输入区;下方是共享的「附加上下文 + 单一「开始审核」CTA」。三源的列表项**点击=选中**(不各自起审),由底部唯一 CTA 发起。
- **GitHub 为主路径**:大输入框粘贴 PR 链接 / `owner/repo#123`,**粘贴即解析**出精简预览卡(标题 + 作者 + diffstat)。下方「或从最近 open PR 中选择」浏览列表。
- **可选本地仓库路径**(仅 GitHub source):填了让 agent 读全量代码,留空则临时 checkout。
- **可选附加上下文**:折叠 textarea,随首轮机审注入 codex,全程可见,不改 read-only sandbox。入口要显眼(整行带图标控件,非纯文字链接)。
- **会话历史**直接进首页(不单独开页):source badge + 标题 + findings/discussion 摘要 + 状态(审核中 / 已提交 / 已完成),点行恢复;右上留「全部历史 →」入口。

### 首轮机审衔接态(review 右栏初始态)

- 机审耗时长,**不能用打断心智的 overlay**;「开始审核」直接切到 review 屏,进度在**右栏内联**展示。
- 右栏显示纵向 **timeline**(拉 diff → 注入 per-thread MCP → 通读 N/M files → 就绪)+ **实时流入的 findings 卡**(可点跳 diff);左侧 diff 全程可读,扫描期可点 finding / 框选提问,无需等待机审结束。
- 扫描结束自动切回 Discussion / Findings tab。(mockup 顶栏有 `扫描中 / 已完成` demo 开关。)

### review 右栏三 tab

- **Discussion**:当前锚点的对话线程(追问 codex / 框选发起),含 composer。
- **Findings**:运行时 triage 列表 —— 按严重度分组(可切按文件)+ tally;每行 sev·category / 标题 / `file:line` / origin(◆ agent vs ● 你·提升) / `◇ suggestion` 标记 / triage:保留(天蓝左条)· 剔除(虚线 + 删除线 + 恢复) / submitted passive(绿左条,锁定不可改);底部「＋ 手动新增 finding」。点行跳 diff / 开 discussion。
- **Summary**:codex 审核总结 —— 结论卡(codex 建议的 review event,标注「仅建议 · 最终 event 在提交时确认」)+ 统计条(high/med/low + 保留/已提交/讨论)+ **可编辑的 codex 生成正文**(即提交屏 review body 的来源)+ 关注主题(按 category 聚合,点击筛 findings)+ 覆盖度行 + 「提交 review →」直达 [findings-submit](findings-submit.md)。

### finding 就地编辑器(`mockup/diff-review.html` 内联 finding 卡)

编辑发生在 finding 的**锚点处**——diff 主区的内联 finding 卡,而非另开面板;Findings tab 点行即跳到此处编辑。同一张卡有 view / edit / dismissed 三态切换:

- **触发**:卡片 action 区 `✎ 编辑`,或悬停卡片按 `e`(沿用 1.0)。
- **可编辑字段**:severity(high/med/low segmented)· category(mono 输入)· 标题 · 说明(textarea)· suggestion(开关控制是否附带;开启后为 mono 代码 textarea,提交时渲染为 GitHub suggestion 块)。
- **保存/取消**:`保存`(`⌘↵`)写回卡片视图并同步 Findings tab / dismissed 摘要;`取消`(`Esc`)丢弃。编辑仅改本地 finding,与 codex 经 MCP `update_finding` 的回写互不冲突。
- **submitted(已提交)· 只读**:绿左条 + `✓ 已提交 · #NNN` 徽标,无 action、内容锁定;footer 提示需在 GitHub 更新或撤回后重提。
- **dismissed(剔除)· diff 内呈现**:整卡折叠为虚线细条(`✕ 已剔除 · 标题`,删除线)+ `↩ 恢复`,不占视觉重量但可召回。

### 布局与栏宽

- 三栏:文件树 / diff(主区,`minmax(0,1fr)` 自适应)/ 会话栏。
- **左右栏可拖动调宽**:两条分隔线拖拽,带 min/max 约束(文件树 180–420 / 会话栏 300–560),双击复位;由 CSS var `--left-w` / `--right-w` 驱动。**栏宽应按用户持久化**(实现项)。

### 空态 / 错误态(entry,`mockup/entry.html` 顶栏「预览态」可切)

- **首次无历史**:会话历史区显示引导空态(还没有审核记录 + 如何开始),隐藏计数与「全部历史」。
- **gh 未登录**:GitHub 面板替换为提示卡 —— 说明 Duetlens 依赖 `gh` CLI + `gh auth login` 命令 + 「已登录,重试 / 安装」,并提示**本地分支 / GitButler 来源无需 gh**;此时 CTA 禁用。
- **PR 解析失败**:输入框标红 + 预览卡转错误态(不存在 / 无权限,附格式提示);CTA 禁用。
- **仓库路径不匹配**:本地路径的 remote 与 PR 不符 —— **软警告、不阻断**(琥珀提示,继续则忽略本地路径改用临时 checkout),CTA 仍可用。
- 原则:**硬错误(gh 未登录 / PR 解析失败)禁用 CTA;软警告(路径不匹配)放行**。

## 已有 mockup

- `mockup/entry.html` —— 主入口 / launcher:三源发起 + 粘贴解析 + 会话历史。
- `mockup/diff-review.html` —— 核心屏:三栏(可调宽)+ 内联 discussion + 右栏三 tab(Discussion/Findings/Summary)+ 首轮机审扫描态 + finding 就地编辑器(view/edit/submitted/dismissed 四态)+ 两轴配色切换。
- `mockup/submit-to-github.html` —— findings 筛选与提交到 GitHub 的流程屏(见 [findings-submit](findings-submit.md))。

> 迭代界面时按偏好用 HTML mockup 对齐(而非 ASCII 预览)。后续细化(线框、状态机、组件清单、Summary 编辑态)在本目录新增分册,并在 [文档索引](../README.md) 登记。
