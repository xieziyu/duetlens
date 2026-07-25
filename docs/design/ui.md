# UI 方向

> 返回 [文档索引](../README.md)
>
> 状态:方向与各屏设计已定(见「屏与状态」);tokens 与组件清单见 [design-system](design-system.md)。落地进度见 [implementation-status](implementation-status.md)。

- 整体重新设计。
- **diff review 是主场**——用户交互最多的界面。
- 倾向 **三栏 + 内联 discussion** 布局:文件树 / diff 主区(可在任意行框选发起 discussion、内联展开 finding 与对话)/ 右侧会话或 finding 详情。
- 交互重心从 1.0 的"看 finding"转为"**在 diff 上对话**"。1.0 的 `files-changed/*` 组件可作为设计语言的雏形。
- **diff 折叠/展开**(沿用 1.0):默认折叠 hunk 之间及上下的未改动代码,以折叠条(`↕ 展开 N 行 · 行号区间`)标示;点击逐段展开,直至看到完整文件内容。整文件也可折叠(file-header 的 chevron)。折叠条不做整行底色——它不是内容,和 file-header/hunk 连成一片会读成又一块数据;改为虚线贯穿、中间浮一颗药丸按钮(`.gap-pill`),上下留白与代码区分开,整行仍可点。

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
- mockup `mockup/diff-review.html` 已实装四组合(dark/light × Duetlens/GitHub):明暗在 rail 底部切,配色由状态栏尾部的 demo 开关切(产品里配色归设置屏)。可作实现基线。

## 屏与状态

除核心 diff review 外,这里定下主入口与 review 内的运行时视图。下列是每屏的**锚点决策**(为什么这么排、哪些约束不能破);**具体视觉与交互以 `src/renderer/` 的实现为准** —— `mockup/` 已冻结,见下「mockup(历史存档)」。

### 主入口 / launcher(`mockup/entry.html`)

- **全屏落地屏**(非命令面板),app 无活动会话时进入。一屏三块:wordmark hero → 发起审核卡片 → 最近的审核(会话历史)。
- **发起审核卡片**:顶部来源 segmented **GitHub PR / 本地仓库** 切换输入区;下方是共享的「附加上下文 + 单一「开始审核」CTA」。各源的列表项**点击=选中**(不各自起审),由底部唯一 CTA 发起。
- **GitHub 为主路径**:大输入框粘贴 PR 链接 / `owner/repo#123`,**粘贴即解析**出精简预览卡(标题 + 作者 + diffstat)。下方「从 open PR 中选择」是**默认折叠**的展开项(选定本地仓库后才出现,展开时才拉列表):粘完整 PR 链接的主路径不该被列表挤走 CTA。
- **可选本地仓库路径**(仅 GitHub source):填了让 agent 读全量代码,留空则临时 checkout。
- **本地仓库只有一个入口,审核方式由仓库自己决定**:普通 git 分支与 GitButler 虚拟分支合成一档 —— 两者的第一步都是选同一个本地仓库,让人先在 segmented 上二选一,等于要求他记住那个仓库此刻是什么状态。选定目录后**一次探测定模式**:`HEAD` 是 `gitbutler/workspace` 且 `but` 可用 → 按虚拟分支审;其余(含 detached HEAD)→ 按普通 git 分支审。判据以 `git symbolic-ref` 为主(不依赖 `but`、毫秒级),`but status` 只作可用性副判据。落库的 SourceKind 仍是 `local-branch` / `gitbutler-vbranch` 两值 —— 一次审核记的是**实际用了哪条 source 实现**,历史 badge 与筛选照旧分得开;收敛的只是「用户怎么选到它」。
- **模式可见且可退**:面板头常驻 `仓库路径 + 切换… + 模式 chip`(⎇ GitButler workspace / git 分支)。workspace 仓库给一条低调的「改按普通 git 分支审核」链接 —— workspace 里仍有正常 ref(比如想复审一个已合并的分支),纯自动会把这条路堵死;`but` 缺失或项目未 setup 时同样落到普通分支视图,并说明原因。
- **仓库记忆**:预填上次发起用过的仓库路径,空态列出最近审核用过的几个仓库直接点选。统一之后选目录成了本地来源的必经第一步,每次重开都从空路径开始最吵。
- **可选附加上下文**:折叠 textarea,随首轮机审注入 codex,全程可见,不改 read-only sandbox。入口要显眼(整行带图标控件,非纯文字链接)。
- **会话历史**直接进首页(不单独开页):source badge + 标题 + findings/discussion 摘要 + 状态(审核中 / 已提交 / 已完成),点行恢复;右上留「全部历史 →」入口。

### 启动等待浮层(点「开始审核」到进屏之间)

- **只盖「进屏之前」这一段**:此时 review 记录还没建、review 屏无从渲染,按钮上一句「启动中…」撑不住大 PR 拉 diff 的几十秒。**这不与下面「机审不用 overlay」冲突** —— 分界线是 review 屏是否已经存在:进屏之后的机审进度一律内联(scanbar),浮层只负责进屏之前。
- **期间禁止其他操作**(这段的中途操作没有意义:改参数不会影响已发出的启动,切屏会把人扔在半途)。故意不给取消:取消要么留下半张记录,要么放任 `gh` 在后台跑完,不如让它跑完再决定。
- **阶段来自后端真实回调**(`review:start-progress`:连接来源 → 拉 diff → 建记录 → 启会话),不是定时器编的假进度;卡住的那一档自己报时,超过 6s 换成「这一步为什么慢」的说明。四档与 review 屏 scanbar 是同一套 done/active/pending 语汇,进屏后接着往下跑。
- **快启动不该看见它**:升起前有静默期,露面后有最短停留 —— 本地分支常几百毫秒返回,闪一下比不闪更吵。
- **失败原地转错误态**(原文 + 返回修改 / 重试),不把人扔回空白表单;浮层还没升起就失败的,仍走卡片内行内报错。
- 画面语汇取自应用图标:**镜片在一叠 diff 代码行上来回扫**,镜片下的行才「看清」(亮色副本按镜片圆裁切);已完成的阶段数 = 已点亮的行数。

### 首轮机审衔接态(review 右栏初始态)

- 机审耗时长,**不能用打断心智的 overlay**;「开始审核」直接切到 review 屏,进度在**右栏内联**展示。
- 右栏显示纵向 **timeline**(拉 diff → 注入 per-thread MCP → 通读 N/M files → 就绪)+ **实时流入的 findings 卡**(可点跳 diff);左侧 diff 全程可读,扫描期可点 finding / 框选提问,无需等待机审结束。
- 扫描结束自动切回 Discussion / Findings tab。(mockup 状态栏尾部有 `扫描中 / 已完成` demo 开关。)

### 运行时 / 异常态(`mockup/review-runtime.html`)

主干只画了 happy path;这些态叠加在 review 屏之上,由后端事件驱动。mockup 状态栏尾部「demo · 运行态」下拉切换演示,状态机见 [ui-states](ui-states.md#运行时--异常态)。呈现分三处**互不打断阅读**的位置:

- **状态栏 status 胶囊**(底部状态栏最左):基线是 review 状态(扫描中天蓝 / 审核中绿 / 失败红,见 `screens/review/StatusBar.tsx`),运行时态在其上覆盖文案与配色 —— 运行中(天蓝 pulse)/ 待审批(琥珀)/ turn 失败 · agent 已断开 · 回传通道故障(红)/ 离线(琥珀)/ 压缩中(天蓝转圈)。
- **全局横幅**(仅连接级异常,置于顶栏下方、rail 之上整幅宽,分级):**阻断级(红)** = agent app-server 断开(自动重连 N/5 + 查看日志)、MCP 回传通道故障(诊断 + 重启通道);**警告级(琥珀)** = 网络离线(重试)。阻断态下主体轻微降饱和,强调需先恢复连接;会话与已上报 findings 已本地保存,重连从断点续接。
- **右栏底部运行区**(随态切内容):
  - **6 中断**:turn 运行中显示流式指示(已读 N 文件 · 用时)+ 红色 **`停止 ⌘.`**(对应 `ConversationalAgent.interrupt`)。
  - **7 审批 / elicitation**:反向审批请求冒出时(自建工具自动 accept 之外,如 `execCommandApproval` / `applyPatchApproval`)显示审批卡 —— 工具名 + 参数摘要(如待执行命令)+ 用途说明 + **拒绝 / 仅这次 / 本会话始终允许**。见 [codex-integration](codex-integration.md) 与 [open-questions](open-questions.md)「审批面收敛」。
  - **5 turn 失败**:错误卡(简述 + 可展开 stream error 详情)+ **重试这一轮 / 编辑后重发**;保留追问与既有对话。
  - **8 压缩**:轻量进度条「正在压缩上下文,保留代码锚点与未决 discussion」;不弹窗。
  - **连接断**(agent-down / mcp-fail / offline):底部禁用追问,提示「连接恢复前追问暂不可用 —— 仍可阅读 diff、triage 已有 findings」。
- **8 上下文可见性**:状态栏 `ctx` **用量环**(环形指示器,参考 Claude Desktop;`--ctx` = 已用比例)接近上限时变琥珀(百分比同步),hover 提示「继续追问将触发自动压缩,压缩后早期讨论原文被摘要替代,**代码锚点保留**」。对应 [open-questions](open-questions.md)「上下文 / token 膨胀」。

### review 右栏三 tab

- **Discussion**:当前锚点的对话线程(追问 codex / 框选发起),含 composer。agent 的每条回答在名字行右端带一枚**一键复制**(hover 该条才显影,复制的是 **markdown 原文**而非渲染后的富文本 —— 贴回编辑器 / PR 评论要的是源码;复制成功短暂回显 `✓ 已复制`,剪贴板不可用则静默)。reviewer 自己写的不给 —— 原文就在手边。
- **Findings**:运行时 triage 列表 —— 按严重度分组(可切按文件)+ tally;每行 sev·category / 标题 / `file:line` / origin(◆ agent vs ● 你·提升) / `◇ suggestion` 标记 / triage:保留(天蓝左条)· 剔除(虚线 + 删除线 + 恢复) / submitted passive(绿左条,锁定不可改);底部「＋ 手动新增 finding」。点行跳 diff / 开 discussion。**文件整个不在改动内的 finding 抽成末尾专组**(`◇ 文件不在改动内`,列在各严重度/文件组之后),使列表顺序贴合它们在 diff 底部 off-diff 区的物理位置,逐条点下去不再在改动处与底部之间来回弹。
- **Summary**:codex 审核总结 —— 结论卡(codex 建议的 review event,标注「仅建议 · 最终 event 在提交时确认」)+ 统计条(high/med/low + 保留/已提交/讨论)+ **可就地编辑的 codex 生成正文**(即提交屏 review body 的来源;`✎ 编辑` 展开 Markdown textarea,`⌘↵` 保存 / `Esc` 取消,保存后轻量渲染段落 / `**粗**` / `` `代码` ``,byline 标「你已编辑」)+ 关注主题(按 category 聚合,点击筛 findings)+ 覆盖度行 + 「提交 review →」直达 [findings-submit](findings-submit.md)。

### finding 就地编辑器(`mockup/diff-review.html` 内联 finding 卡)

编辑发生在 finding 的**锚点处**——diff 主区的内联 finding 卡,而非另开面板;Findings tab 点行即跳到此处编辑。同一张卡有 view / edit / dismissed 三态切换:

- **触发**:卡片 action 区 `✎ 编辑`,或悬停卡片按 `e`(沿用 1.0)。
- **`↳ 追问`**(卡片主动作,agent 声道着色):切到右栏 Discussion 栏并选中这条 finding 的**承载 discussion**,composer 即刻可用。这是从 diff 进对话的主路径 —— 每条 finding 落库时都同时建出承载 discussion,agent 上报时须连同它一起外发,否则本轮会话内 Discussion 栏是空的。
- **可编辑字段**:severity(high/med/low segmented)· category(mono 输入)· 标题 · 说明(textarea)· suggestion(开关控制是否附带;开启后为 mono 代码 textarea,提交时渲染为 GitHub suggestion 块)。
- **保存/取消**:`保存`(`⌘↵`)写回卡片视图并同步 Findings tab / dismissed 摘要;`取消`(`Esc`)丢弃。编辑仅改本地 finding,与 codex 经 MCP `update_finding` 的回写互不冲突。
- **submitted(已提交)· 只读**:绿左条 + `✓ 已提交 · #NNN` 徽标,内容锁定(仅保留 `↳ 追问` —— 提交后仍该能接着聊);footer 提示需在 GitHub 更新或撤回后重提。
- **dismissed(剔除)· diff 内呈现**:整卡折叠为虚线细条(`✕ 已剔除 · 标题`,删除线)+ `↩ 恢复`,不占视觉重量但可召回。

### 框选发起 discussion + composer 引用(`mockup/diff-review.html`)

"在 diff 上对话"的核心入口。在 diff 主区框选任意代码 → 浮出操作条(popover):

- **popover**:显示选区 `file:行范围` + 两个动作 —— `⬆ 发起 discussion`(human/琥珀)与 `◆ 追问 codex`(agent/天蓝)。定位在选区上方,贴边自动翻转到下方;点击别处 / 滚动即消失。
- **发起 discussion**:在选中行下方就地插入一张 human composer 卡(选中行标琥珀左条),含选区引用块 + textarea + `发送`(`⌘↵`)/ `取消`;发送后原地变成一条「你的 discussion」卡(带「转为 finding / 继续对话」)。每行悬停的 `＋` 复用同一条单行流程。
- **行内 `＋` 落在新侧行号格上,不在代码格右缘**:代码格随长行横滚,贴其右缘的按钮要一路滑到行尾才够得着(unified 下行号格是钉住的,见「diff 导航与覆盖」)。按钮整格覆盖行号(hover 才显影、背景不透明),点击热区因此与行号同宽;split 里让开左侧那枚 anchor dot。
- **追问 codex**:切到右栏 Discussion tab,并把选区作为可移除的引用 chip(`↳ file:行`)附到 composer;composer 的 `↳ 引用选区` chip 行为相同。
- **composer `@file`**:弹出文件菜单(按 diff 文件列表),选中即把 `@path` 引用写入输入区。

### diff 导航与覆盖(`mockup/diff-review.html`)

- **文件检索过滤**:文件树头下方常驻一枚检索框(与标题行一起 sticky),匹配**完整路径**,空格分词逐词 AND;每词先整段包含,≥3 字才退化为顺序子序列(`plne` → `pipeline.ts`;两字母词若也模糊,`ts` 会把 `styles/app.css` 一并捞进来,过滤等于没过滤)。命中字符高亮(搜索高亮 token `--code-hl`)+ 未命中字符压暗,目录头只按整段包含高亮(一个头对应整组文件,不能取决于组内选了哪个文件)。**结果不按相关度重排**:树的顺序必须与中栏 diff 的堆叠顺序一致。过滤只收窄这棵树,**中栏 diff 仍是全量** —— 否则过滤态下会误判改动规模,右栏计数也跟着对不上。树头计数在过滤时切成「X / N 匹配」,零命中给「没有匹配的文件」。检索词是纯导航态,不持久化,换 review 即清空。
- **per-file Viewed ✓**:文件树每行右侧有 viewed tick(悬停显影),标记已看后该行删除线 + 变灰 + 绿 ✓;文件树头显示「N 改动 · M 已看」进度。diff 主区 file-header 的「已看」按钮 = 标记当前文件已看**并折叠**内容为一条「已折叠 · 点击展开」bar;折叠按钮只折叠不改 viewed。
  - **两枚都带文案**,纯图标读不出功能:已看是**勾选框语义**(未看空框、已看填色打勾,文案恒为「已看」,状态不靠文案变化表达,免得点一下按钮宽度就跳);折叠按钮反过来,`− 折叠` / `+ 展开` 给的是**点下去会发生什么**。tooltip 按 viewed × 「标记已看即折叠」偏好四种组合分别措辞——同一枚按钮在四种状态下做的事不同。
  - **标记已看后自动推进到下一个未看文件**(把它的文件头顶到列头下沿,左栏选中同步跟随):折叠只是把当前文件的高度抽走、滚动位置不变,视口会塌进下一个文件的中段。仅在「标记已看即折叠」开启时推进(不折叠就没有塌陷,此时用户多半想接着读);取消已看不推进;后面没有未看文件则回到自己的文件头。
  - **落点必须自己算 `scrollTop`,不能用 `scrollIntoView`**:file-header 是 sticky,目标文件头一旦已被吸在列头下方,`scrollIntoView` 会认定它「已在视口起点」而一步不滚——表现就是折叠完视口原地不动、顶上停着的还是上一个文件。改为按非 sticky 的 `.diff-file` 区块算偏移(padding 读 `scroll-padding-top`,不重复硬编码列头高度)。左栏点选跳转同一个坑,共用这条路径。
  - **跳到代码前先展开目标文件**:折叠态下整段 diff 与内联卡都不在 DOM 里,滚动会静默落空、中栏停在原处 —— 右栏点 finding、点 discussion、锚点行跳转、提升为 finding、手动新增 finding 全走这条。展开只展开、不改 viewed(读过的记录不该因为回头看一眼就被抹掉),也不改左栏树的点选(那只是导航,折叠条自带「点击展开」)。展开与选中态同批提交,effect 跑时卡片已在 DOM;聚焦滚动的依赖里带上「被聚焦那条所在文件是否折叠」,好让展开后补一次滚动,又不至于折叠别处也把视口拽回来。
- **off-diff findings 分两类承载**:锚点不在当前 diff 新侧的 finding,按「文件在不在改动内」分开落位,都保留完整卡片(triage/编辑/追问),避免因无处内联被忽略。
  - **行 off-diff**(文件在改动内、锚点行不在新侧 hunk:被删除行 / 未展开区 / 无行锚点的 PR 级):归入**该文件区顶部**的 off-diff 段(`◇ N 条 off-diff finding(锚点不在当前改动新侧)`)。
  - **文件 off-diff**(文件整个不在本次 diff —— agent 允许顺 import 读到被引用文件并 off-diff 提出):无对应文件区承载,单列到 diff 主区**底部**、按文件成组(`◇ 文件不在本次改动内 · path`),并挂 `fileAnchorId` 锚点。**这枚锚点是必须的**:否则点该卡时 `setActivePath`/`focusFindingId` 找不到 DOM 目标,滚动静默失败(实机踩过,见 `#3912`)。
- **横向滚动只归 code 表**:长代码行的横滚容器是每张 `.code` 表外的 `.code-scroll`,diff 栏本身 `overflow-x:hidden`。整栏可横滚时,file-header、hunk 头、gap bar、内联卡片会跟着长行一起被推出视口(它们只有一屏宽,右侧还会露出空白底)。一份 diff 被内联卡片切成多张表,`DiffPane` 用一个捕获期 scroll 监听把各表 `scrollLeft` 同步,读长行时不会段与段错位。
  - **行号列与 gutter 在 unified 下钉住左缘**(`position:sticky`):横滚的是整张表,不钉住则滑出去就既读不到行号、也够不着挂在行号格上的 ＋。钉住的格子背景必须**不透明**,`--add-gutter` / `--del-gutter` 是半透明 token,故垫一层实底再叠色调,否则代码从格子底下透出来。split 表是 `table-layout:fixed`、不横滚,不需要。
  - **三处宽度(`width` / `min-width` / `max-width`)要一起写**:长行把表撑出容器时,auto 表布局会把只写了 `width` 的行号列压到几乎为零 —— 行号挤成一条,＋ 也无处落脚。
- **split vs unified**:中栏列头(`.diff-bar`)右端的 `Unified | Split` segmented 切换(全局偏好,不再逐文件重复)。**同一 hunk 的 unified / split 两张 `.code` 表切换,内联 discussion/finding 卡共享**(不复制),因此 finding 编辑器、追问、框选 popover、行内 ＋ 在两种视图下都可用;split 的行锚点取新侧行号。split 为并排双列(旧 / 新,新增行左侧留空占位、删除行右侧留空),保留 anchor dot 与新侧 ＋。

### 键盘快捷键(`mockup/diff-review.html`)

- **统一快捷键体系 + 帮助层**:散落在各交互里的键位(编辑 `e`、保存 / 发送 `⌘↵`、取消 `Esc`)收敛为一套,并有一个随时可唤起的 cheatsheet 浮层。底部状态栏右端放一个 `⌘ 快捷键` 触发按钮,快捷键 `?` 唤起 / 关闭;`Esc` 关闭。浮层双列分组(通用 / Diff 视图 / Finding / Discussion),键位用 `<kbd>` 呈现,底部注明「⌘ 在 Windows/Linux 为 Ctrl · 焦点在输入框时快捷键自动让位」。浮层跟随两轴配色(tokens 驱动),明暗自洽。
- **键位约定**:通用 —— `?` 帮助、`Esc` 关闭弹层/取消编辑、`1`/`2`/`3` 切右栏 Discussion/Findings/Summary。文件过滤 —— `/` 聚焦检索框(要吞掉这次按键,否则 `/` 跟着落进刚聚焦的输入框)、框内 `↵` 跳第一条命中、`↑`/`↓` 在命中间移动、`Esc` 先清空再退焦。Diff —— `u` 切 Unified/Split(拖选发起 discussion、悬停行 ＋ 追加讨论为鼠标手势,列在浮层作参照)。Finding —— `e` 编辑悬停卡、`⌘↵` 保存、`Esc` 取消。Discussion —— `⌘↵` 发送、`↵` 换行(多行追问常见,不让裸 `↵` 误发)、`@` 唤起引用文件菜单。
- **让位原则**:焦点在 `INPUT/TEXTAREA/SELECT` 或 contenteditable 时,全局导航键(`?`/数字/`u`/`/`)不拦截,只保留输入框自身的 `⌘↵`/`Esc`/`↵`;帮助层打开时也不再抢导航键。(实现项:键位表按用户可配置。)

### 应用外壳:导航 rail + 顶栏 + 底部状态栏(2026-07-23 重设计)

review 屏原先把品牌、来源、模型、用量、状态、CTA、主题、快捷键全塞进一条顶栏,既拥挤又**没有任何回到入口 / 进设置的出口**。拆成三处:

- **全局导航 rail**(左侧 52px,常驻于顶栏之下):`入口 · 当前审核 · 历史 · 审核规则` ▸ 底部 `明暗切换 · 设置`。**除 onboarding 外所有屏共用**,替换掉开发态的顶栏屏切换。选中项左缘一条 accent 指示条;无活跃 review 时「当前审核」禁用。rail 在顶栏下方而非贯通全高 —— 让 macOS 交通灯始终落在顶栏的 `padding-left:88px` 里,不与 rail 抢位。
- **顶栏只留上下文**:来源 chip(来源图标 + `#PR 号` / 分支名;github 来源**整枚 chip 即打开 PR 的按钮**,尾部 ⧉ 图标只作可点提示)、PR 标题、仓库 `owner/repo` 尾注,右端常驻 CTA(提交 review / 导出 review)。整条是窗口拖拽区。
- **底部状态栏**(28px,仅 review 屏,参照 IDE / Claude Desktop):左起 **状态胶囊**(扫描中/审核中/失败,运行时带 pulse)· `codex · 模型 · effort`(模型名是 agent 侧实际生效的那个:用户没指定时由起会话的应答回填落库)· **ctx 环 + token 用量** · 最近工具调用(最弱、限宽、窄窗口先隐);右端 `⌘ 快捷键`。
- **Unified / Split 从 per-file header 迁到中栏列头**(`.diff-bar`,sticky 于 diff 列顶,左端另给整份改动总量 `+A −D`):它本就是全局偏好,过去在每个文件头重复渲染一份,还与 per-file 的「已看 / 折叠」混在一起;放状态栏右下角则太靠边、容易被忽略,列头紧贴它作用的那一栏。
- 配色主题(`data-theme`)只在设置屏改;明暗(`data-mode`)在 rail 一键切 —— 高频的留在外壳,低频的收进设置。

### file-header:文件名 / 路径分两行

长路径会把右侧状态挤扁,单行排不下。改为左侧两行、右侧分组:

- **第一行**:文件名(mono 13.5px/600,主体)+ 非常规状态 pill(新增 / 删除 / 重命名 / 二进制;modified 不标)。
- **第二行**:目录路径(10.5px faint),重命名时追加 `← 旧路径`(琥珀)。**超长路径用 `direction:rtl` 从头部省略**,保留更有辨识度的尾部目录;完整路径挂 `title`。
- **右侧**依次:`⚑ N`(该文件 finding 数)· `+N −N` 增删统计 · 一条分隔线后是 per-file 操作(勾选框 `已看` / `− 折叠`,见「diff 导航与覆盖」)。
- **挤窄时先撤增删统计**:中栏宽度由两侧栏拖拽决定、与窗口宽度无关,故退化按 **container query**(容器是 file-header 自身)而非视口断点。两侧栏拉满时中栏只剩 ~340px,此时撤掉 `+N −N`(左栏每行本就有一份),把宽度让给文件名与操作按钮。

### 布局与栏宽

- 三栏:文件树 / diff(主区,`minmax(0,1fr)` 自适应)/ 会话栏。
- **左右栏可拖动调宽**:两条分隔线拖拽,带 min/max 约束(文件树 180–420 / 会话栏 300–560),双击复位;由 CSS var `--left-w` / `--right-w` 驱动。**栏宽应按用户持久化**(实现项)。
- **窄窗口退化**断点已计入 rail 的 52px:≤1180px 收窄侧栏、隐最近工具调用;≤940px 收起文件树、隐标题与 effort。

### 空态 / 错误态(entry,`mockup/entry.html` 顶栏「预览态」可切)

- **首次无历史**:会话历史区显示引导空态(还没有审核记录 + 如何开始),隐藏计数与「全部历史」。
- **gh 未登录**:GitHub 面板替换为提示卡 —— 说明 Duetlens 依赖 `gh` CLI + `gh auth login` 命令 + 「已登录,重试 / 安装」,并提示**本地仓库来源无需 gh**;此时 CTA 禁用。
- **PR 解析失败**:输入框标红 + 预览卡转错误态(不存在 / 无权限,附格式提示);CTA 禁用。
- **仓库路径不匹配**:本地路径的 remote 与 PR 不符 —— **软警告、不阻断**(琥珀提示,继续则忽略本地路径改用临时 checkout),CTA 仍可用。
- 原则:**硬错误(gh 未登录 / PR 解析失败)禁用 CTA;软警告(路径不匹配)放行**。

### 设置 / 偏好面板(`mockup/settings.html`)

- **左栏分组导航 + 右栏分节表单**,滚动定位联动高亮;每个设置一行(标题 + 说明 + 控件)。落地本地即时保存,底部 `恢复默认设置`。
- **偏好(per-user)**对齐 `ui_settings`(见 [frontend-components](frontend-components.md#ui-状态持久化)):
  - **外观**:明暗模式(跟随系统 / 浅 / 深)× 配色主题(Duetlens / GitHub)两正交轴,控件**实时驱动 `data-mode`/`data-theme`**;栏宽「重置为默认」。
  - **审核默认**:默认 source / 默认 diff 视图(unified/split)/ 默认右栏 tab / Findings 默认分组 / 标记已看后自动折叠。措辞点明「单次审核内临时改动不写回默认」(区分 persisted 默认 vs ephemeral 覆盖)。
  - **快捷键**:摘录常用绑定,完整列表指向审核屏 `?` 帮助层。
- **环境配置**:
  - **codex**:可执行文件路径(留空走 `PATH`)+ 选择 / 检测;app-server 连通状态胶囊;模型选择;**沙箱 read-only 锁定不可改**(标注)。
  - **GitHub CLI**:`gh` 路径 + 登录状态(登出);重申本地仓库来源无需 gh。
- **审核规则提示词**为独立编辑器入口(见下);**关于**块给版本 + 依赖版本 + 检查更新。
- 状态胶囊复用 severity/add/del 语义色(ok 绿 / warn 琥珀 / err 红 / lock 灰),与 review 屏运行态一致。

### 审核规则提示词 · 三层编辑器(`mockup/prompt-rules.html`)

- **优先级 project ▸ global ▸ builtin,上层按节覆盖下层**;合并结果注入 codex `thread/start · baseInstructions`(见 [codex-integration](codex-integration.md))。
- **可配置面 vs 锁定段**:baseInstructions 分两类内容,**只有前一类进设置页**。
  - **可配置节**(审核重点 / 严重度判定 / 忽略范围 / 输出与语气 / 项目上下文)= 审核**口径**,用户随便改。
  - **锁定段**(角色与 MCP 工具流程、`report_finding` 字段协议)= 工具**契约**:severity 枚举、category 规范集、`line` 锚新侧、`suggestion` 是会被逐字套用的字面补丁。这些字段由 Duetlens 机械消费,改写不是口径变化而是**功能失常**(finding 被 ingress 拒收 / 提交到 GitHub 时补丁错位)。锁定段既不可编辑,也不下发 renderer —— 设置页里根本不存在,连「有这么一段」都不暴露。
  - 锁定段**首尾夹住**用户内容:角色段在最前(身份),协议段在最末(硬契约),用户节里写了冲突口径也压不过后面的协议。
- **合并模型 = 分节覆盖**:每节独立取**最高优先且有定义的层**作为生效值。比整块替换更细,能明确「哪一节被谁覆盖」。节分两种:
  - **free**:整节一块自由文本(忽略范围 / 输出与语气 / 项目上下文)。
  - **structured**:字段集固定、字段名锁死,只有每个字段的正文可改,且**逐字段独立继承/覆盖**。字段名与执行框架绑定,故只开放正文:
    - **审核重点** —— 字段就是 `FINDING_CATEGORIES`(Scope / Correctness / Type Safety / …),与 finding 分类同源、由类型强制不漂移,逐类别写「这一类看什么」。
    - **严重度判定** —— 字段是 `high / medium / low`,MCP ingress 的 `z.enum(SEVERITIES)`,被改名即导致上报被拒,逐档写「每档收什么问题」。
    - 逐字段落盘为 `- <字段名>: …`;解析不出任何字段的正文(如自由文本、或自造 P0/P1 分级)视为**未覆盖**,builtin 保留。「先判断改动属于哪类代码、只报真实问题」等总则不属任何类别,落在锁定的角色段。
- **三栏**:
  - **左 rail** = 编辑层选择(project 随仓库 `.duetlens/review.md` / global 个人 `~/.duetlens/review.md` / builtin 只读内置),每层标「覆盖 N 节」;底部「生效预览」入口。
  - **中 = 选中层的分节编辑器**:每节卡片头标 `生效层 X`(反映实际 winner,与正在编辑的层解耦)+ 一行 hint 说明这节控制什么;已覆盖节可 `✎ 编辑` / `重置(改回继承)`,未覆盖时来源做成**独立标签**「继承自下层」(带层色圆点、与正文分行,不再把标识混排进规则文字)+ `＋ 覆盖`。structured 节改为逐字段行:左侧字段名做成钉死的标签(非输入位;severity 档位带语义色、审核重点类别名为中性 chip),右侧才是可编辑的正文。builtin 层整体只读。
  - **右 = 生效结果(常驻)**:按节合并后的文本(**可配置部分**,不含锁定段),每节标来源(project 覆盖 / global 覆盖 / 默认)并用 provenance 左条配色(project=天蓝 / global=琥珀 / builtin=灰),底部图例。structured 节整节徽标取最具体的一个字段,故逐字段再补一个 provenance 圆点 —— 否则「只改了某一类/某一档」在整节徽标上看不出来。
- provenance 三色沿用品牌语义:project(最具体)= 天蓝 accent、global(个人)= 琥珀、builtin(基线)= 灰。

### 全部会话历史页(`mockup/history.html`)

- entry「最近的审核」只显示近几条,`全部历史 →` 进入本页(已接 `entry.html` 链接);**复用 entry 的 `.rev` 卡片词汇**(srcbadge gh/local/gb · 标题 · meta(repo · findings · discussions/已提交 · 相对时间)· stat(审核中/已提交/已完成)),保证两处一致。
- **工具条**:搜索框(标题 / 仓库 / 分支 / PR 号)+ 来源筛选(全部 / GitHub / 本地 / GitButler)+ 状态筛选(全部 / 审核中 / 已提交 / 已完成)。全部即时过滤,顶部计数随之更新。
- **按时间分桶**(今天 / 本周 / 更早),每桶标题带条数;筛选 / 搜索后空结果显示引导空态。
- **软删除 + 撤销**:卡片悬停出现 🗑,删除后原地折叠为虚线条「已删除 · 撤销」(承接 backlog「删除 / 恢复」),不即时清除。
- 点卡进入对应 review 屏(审核中→运行态,已完成/已提交→只读回放)。

### 首次启动 / codex onboarding(`mockup/onboarding.html`)

- 无历史首启进入全屏引导:wordmark hero + 「环境检查」清单,逐项探测运行前置,而非直接抛错。
- **前置项分必需 / 可选**:
  - **codex CLI**(必需):在 `PATH` 探测 + 版本;缺失→红「缺失」+ 修复面板(`brew install codex` 可复制命令 + `↻ 重新检测` + 安装文档)。
  - **app-server 连通**(必需):由 Duetlens 自动拉起、无用户命令;**级联依赖 codex** —— codex 未就绪时显示灰「待前一步」。
  - **GitHub CLI**(可选):标「可选」,未登录为琥珀「未配置」+ `gh auth login`;**不阻断 CTA**,面板明说仅 GitHub 来源需要。
- **CTA 门控**:仅必需项(codex + app-server)全就绪才启用「进入 Duetlens →」;可选项(gh)未配只影响 GitHub 来源。底部「跳过,稍后在设置中配置」次要入口。
- 顶栏「预览态」下拉演示 checking / codex 未安装 / gh 未登录 / 全部就绪四态;checking 态模拟探测完成自动落到就绪。状态胶囊与 severity/add/del 语义色一致,同 settings 环境区。

> 所有屏(主干 entry → review → 提交/导出、运行时/异常态、设置/审核规则/历史/onboarding)都已落地;进度见 [implementation-status](implementation-status.md)。

## mockup(历史存档,已冻结)

`mockup/` 是设计语言尚未收敛时用来对齐视觉的 HTML 稿。**七屏全部落地后它已完成使命,现予冻结**:

- **不再同步更新**。改 UI 只改 `src/renderer/`;出现分歧一律**以实现为准**,不要回头去"修 mockup"(那是本末倒置 —— 先实现再补稿,补的稿也没人看)。
- **`mockup/tokens.css` 不是配色单一来源**,它只是 `src/renderer/theme/tokens.css` 的一份历史副本;改配色改后者。
- 仍可作为**设计意图的历史记录**翻阅(尤其 `review-runtime.html` 覆盖的运行时/异常态尚未落地,那份稿仍是该功能唯一的设计参照)。
- **源码里已不留任何指向这里的注释**(原先各屏头部的 `→ mockup/xxx.html` 已清理干净)。想追某屏的设计出处查 `git log`。
- 打开方式:静态服务(如 `python3 -m http.server`),**不能走 `preview:ui`** —— vite 会把 mockup 当入口做 HTML transform,代码示例里的 `Result<()>` 之类被当标签解析而报错。

存档清单:

- `mockup/entry.html` —— 主入口 / launcher:三源发起 + 粘贴解析 + 会话历史。
- `mockup/diff-review.html` —— 核心屏:应用外壳(全局导航 rail + 上下文顶栏 + 底部状态栏)+ 三栏(可调宽)+ 两行 file-header + 内联 discussion + 右栏三 tab(Discussion/Findings/Summary)+ 首轮机审扫描态 + finding 就地编辑器(view/edit/submitted/dismissed 四态)+ Summary 正文就地编辑 + 框选发起 discussion / composer 引用 + per-file Viewed / off-diff findings 区 + split / unified 切换(状态栏)+ 键盘快捷键帮助层(`?`)+ 两轴配色切换。
- `mockup/review-runtime.html` —— review **运行时 / 异常态**(外壳与 `diff-review.html` 同构:rail + 上下文顶栏 + 底部状态栏 + 两行 file-header):状态栏「demo · 运行态」下拉切 9 态(空闲 / turn 运行中+中断 / 反向审批 / turn 失败 / agent 断开重连 / 离线 / MCP 通道故障 / ctx 接近上限 / 压缩中);演示 status 胶囊、全局横幅、右栏底部运行区、ctx 用量表。见上「运行时 / 异常态」。
- `mockup/submit-to-github.html` —— findings 筛选与提交到 GitHub 的流程屏(见 [findings-submit](findings-submit.md));顶栏「提交态」切换器演示提交结果/异常态(submitting / success / **invalid 行锚点失效** / failed / **incremental 增量**)。
- `mockup/export-markdown.html` —— 非 GitHub source(本地分支 / GitButler)的**本地 Markdown 导出屏**:左侧实时报告预览(渲染/源码)、右侧导出配置(包含项 + 分组 + 勾选保留 + 复制/保存 .md)。见 [findings-submit](findings-submit.md#非-github-source--导出为-markdown)。
- `mockup/tokens.css` —— 两轴配色 tokens,供各 mockup 引用;**真正的单一来源是 `src/renderer/theme/tokens.css`**,此处只是历史副本。
- `mockup/design-system.html` —— 可视化 style guide:色板 + 字阶 + 组件清单(见 [design-system](design-system.md))。
- `mockup/settings.html` —— **设置 / 偏好面板**:左栏分组导航 + 右栏分节表单;外观两轴实时驱动主题、审核默认(source/diff视图/tab/分组)、codex/gh 环境配置、快捷键摘录、关于。对齐 `ui_settings`。
- `mockup/prompt-rules.html` —— **审核规则提示词三层编辑器**:优先级 ribbon + 左栏层选择 + 中栏分节编辑(继承/覆盖/重置)+ 右栏生效结果(provenance 配色)。分节覆盖模型(free 节整节覆盖 + 审核重点/严重度 structured 逐字段覆盖),合并注入 `baseInstructions`;锁定段不在其中呈现。
- `mockup/history.html` —— **全部会话历史页**:搜索 + source/状态筛选 + 时间分桶列表(复用 entry `.rev` 卡)+ 软删除/撤销;`entry.html` 的「全部历史 →」入口指向本页。
- `mockup/onboarding.html` —— **首次启动 / codex onboarding**:环境检查清单(codex CLI / app-server / gh)+ 修复命令面板 + CTA 门控;顶栏「预览态」切 checking / 未安装 / gh 未登录 / 就绪。

> 迭代界面时按偏好用 HTML mockup 对齐(而非 ASCII 预览)。后续细化(线框、状态机、design tokens / 组件清单)在本目录新增分册,并在 [文档索引](../README.md) 登记。
