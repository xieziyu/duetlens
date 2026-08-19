# 架构

> 返回 [文档索引](../README.md)

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | **Electron**(自带 Chromium,渲染与 Chrome 一致);目标平台先做 macOS |
| 后端 | **Node / TypeScript**,写在 Electron main 进程,不引入独立后端进程 |
| 审核 agent | **codex app-server**(常驻 JSON-RPC 会话),见 [codex-integration](codex-integration.md) |
| MCP 回传通道 | main 进程内自托管的 **in-process HTTP MCP server**,codex 以 `--url` 连接 |
| 外部依赖 | `gh` CLI(拉 PR / diff、提交 review)、`but` CLI(GitButler 虚拟分支) |
| 前端 | React SPA,承载于 Electron renderer |

**为什么不是 Tauri + 全 Rust**:Tauri 在 macOS 用系统 WKWebView,与 Chromium 有渲染差异,不少在 Chrome 上正常的效果到那儿会出问题。换 Electron 后主进程即 Node,「全 Rust 后端」的顺势前提随之消失 —— 编排层的实质是管外部进程(git / gh / codex)+ 本地 HTTP MCP + sqlite + 事件流,都是 Node 的主场,还能捞回 1.0 的 zod schema / source-flow / prompt-resolver,反而**减少**重写量。

**代价**:打包体积(~100MB 级)与内存显著高于 Tauri,且须按 Electron 安全基线配置(`contextIsolation` 开、`nodeIntegration` 关、preload + `contextBridge` 暴露 IPC)。「收敛技术债」的目标不靠后端语言,而靠重新架构(新数据模型、MCP 回传、discussion 实体)达成。

## 后端分层

- **`ConversationalAgent`(agent 接口层)**:`startConversation` / `sendMessage` / `streamEvents` / `interrupt` / `approve`。codex app-server 是目前唯一实现;把它的 event / approval 模型包薄一层,不让协议细节渗透到 UI。
- **MCP server(控制反转层)**:app 向 agent 暴露的工具集,是 findings 与源码读取的回传通道。
- **Elicitation / 审批处理器**:codex 执行 MCP 工具前会发反向审批请求,client 必须应答,否则 turn 卡死 —— 属架构必需件。
- **source 层**:`github-pr` / `local-branch` / `gitbutler-vbranch` 三种实现,各自负责取 diff 与读文件。
- **持久化**:本地 sqlite(`better-sqlite3`,WAL + FK)。codex thread 由 codex 侧持久化,我们只存 threadId 做续接。

### 活跃会话并发上限

一个活跃会话 = 一个常驻 codex 子进程 + 一个 MCP server,故上限写死 **4**(`maxLiveSessions`),否则长时间使用会攒下一堆子进程。位置不够时按 LRU 逐出。

- **只逐出空闲会话**。忙碌一律避让 —— 拆掉正在跑的会话等于替用户打断一轮机审,那一轮只会以一句莫名其妙的失败收场。这条曾经缺失,4 个都在扫时开第 5 个会**静默**弄挂其中一个。
- **「忙」从入口算起,不只是在途 turn**:建 MCP、起/恢复 codex thread 的那段一个 turn 都没有,拆掉照样把这次审核打断在起跑线上(`spike:session-busy` 守着这条)。
- **全在跑就拦下并告知**,列出在跑的是哪几条、可直达。「上限」是用户完全无法预期的内部数,不说清楚只会让人觉得应用坏了。有空闲位时静默回收,不打扰。
- 会话位是**原子预留**、不是先判一下:判定与真正建出会话之间隔着拉取与建库几个 await,只判不占的话两个同时发起会在只剩一个位子时双双通过。预留兜不住的残余(判定后有空闲会话转忙)则整条回滚新建的 review/round/diff —— 否则库里会躺着一条用户当次看不见的失败审核。
- 满载拦截只在**确实拿到满载快照**时接管;容量接口自己失败时退回普通报错,不然点了没反应、原因也一并丢了。
- 错误跨 IPC 只剩 message(Electron 丢自定义字段),故满载错误在消息里嵌 `DUETLENS_LIVE_SESSION_LIMIT` 供 renderer 识别,在跑的名单由 renderer 回头问 `review.capacity()`。

**领域事件面全程编译期收敛**:`ReviewSessionEvents` 是事件名→载荷的单一来源;ReviewSession **组合**(非继承)EventEmitter,`on/off` 收窄、`emit` 私有;ReviewManager 用 `keyof` 映射的转发表;renderer `useReviewStream` 用 `switch` + never 哨兵(运行时只告警不抛,容忍 main 比 renderer 新)。三处任一漏接新事件都编译失败。起因是 agent finding 的**承载 discussion** 曾只落库未外发,整个 Discussion 栏为空却无人报错。

> 继承 EventEmitter + 同名 interface 声明合并也能收窄类型,但会触发 eslint `no-unsafe-declaration-merging`,故选组合。

## 前端:状态分层与持久化

三层,来源与生命周期不同,不要混进一处 store:

| 层 | 是什么 | 来源 |
| --- | --- | --- |
| **Server state** | review / discussions / findings / messages / summary / diff | 后端 sqlite + codex 事件流,经 IPC 拉取与推送 |
| **Persisted UI state** | 栏宽 / viewed / 上次 tab / 主题两轴 / diff 视图偏好 | 后端表,见下 |
| **Ephemeral UI state** | 编辑草稿、popover 显隐、hover、菜单开合 | 组件本地 `useState` |

**Server state 的写路径始终经后端命令**,前端不本地臆造权威数据;后端落库并回推事件,前端据事件更新视图 —— 多处视图(diff 内联卡 ↔ Findings tab ↔ Summary)因此天然一致。finding 的就地编辑与 codex 经 MCP `update_finding` 的回写是**同一后端字段**的两个写入方,由后端串行化。

**持久化的粒度与存储位置**:

| 状态 | 粒度 | 理由 |
| --- | --- | --- |
| 主题两轴 / 栏宽 / 默认 tab | per-user(`ui_settings`) | 用户级偏好,不随 PR 变;单次审核内的临时覆盖属 ephemeral,不写回默认 |
| diff 视图 / 文件列表视图 | per-user(`ui_settings`) | 同上,但这两项在审核内切换**即写回** —— 读 diff 的方式是习惯,不是这次 PR 的属性 |
| per-file viewed / 本次 tab | per-review(`review_ui_state`) | 属这次审核的进度,换 PR 应清零,并要与「N 改动 · M 已看」一致 |
| diff 折叠 / 目录树折叠 / banner 展开 / 编辑草稿 | 不持久化 | 纯视图态 |

**一律进后端 sqlite,不用 renderer `localStorage`**:领域进度(viewed 是这次 review 的一部分)要能随会话历史一起恢复;外观偏好放同一处是为单一来源,顺带避开多窗口 / 清缓存导致的漂移与两套读写路径。

## 审核强度

`ReviewIntensity = standard | adversarial` 两档,**只做 L1(只读对抗推理)**:对抗档注入证伪立场段(归锁定角色侧、不进分层模型),并在扫描 / 复审 turn 之后于**同一 thread** 追加一轮自检;自检失败吞掉、保留扫描成果。

### 自检轮为什么是「先裁决、后补漏」

agent 审核的主要失效模式是**幻觉 finding**(引用一条并不存在的调用路径),不是漏报 —— 噪声比漏报更毒,它训练人忽略整个审核通道。所以自检轮先逐条裁决已报的,再去补没报的;一条待裁的都没有时**整轮跳过**(裁决无事可裁,补漏则是「第二眼硬找茬」的经典失效场景,产出的恰好是这个档位最想消灭的凑数 finding)。跳过要在活动流留痕:档位文案承诺了这一轮,静默跳过在用户眼里就是功能坏了。

清单(`selfCheckRoster`)按 **`lastSeenRound`** 取,不是首报轮次:复审轮里被 `resolve_finding` 判 still_present 的既有条目仍挂着首报轮次,按首报轮次取就一条都选不中 —— 复审轮于是要么整轮跳过自检,要么只裁本轮新报的那几条。而「仍存在」恰恰是最该被证伪的结论:它决定要不要给作者追发一条评论。已剔除与自动结案的排除在外(前者 reviewer 已经判过,后者本轮已认定修好)。

### 判据靠取证,不靠「再想一遍」

同一 thread 里让模型推翻自己十分钟前的结论,对抗的是承诺一致性偏差,典型产出是"我复核了一遍,结论仍然成立"。但**工具返回值是它没法对其保持一致的 ground truth**:被迫重读原文时,编出来的引用会当场塌掉。

故 `judge_finding` 有一道**取证硬闸** —— 该 finding 锚定的文件若在本轮没被 `get_file` / `search_code` 碰过,裁决直接拒收(记账在 MCP 侧,按 turn 清空)。模型可以在散文里伪造引用,但伪造不了一次被后端记下的工具调用。

闸门只有在这几件事都成立时才真的挡得住,少一条就形同虚设:

- **读失败不记账**。`Source.getFile` 读不到必须**抛**而不是回一句 `// 无法读取 …` 占位文本 —— 两者不可分的话,锚到不存在文件的 finding 只要调一次注定失败的 `get_file` 就能解锁裁决。
- **finding id 限定在本 review**(`McpContentProviders.findingFile`)。解析不到就拒收:早先把「不存在」与「无需取证」都折叠成放行,于是未知 id 既绕过闸门又拿到一句 recorded,而**别的 review** 的有效 id 更会一路写到那条 finding 上去(两条 review 审同一个仓库时路径重名,取证闸也挡不住)。ReviewSession 侧再校验一次作纵深。
- **搜索失败 ≠ 0 命中**。`git grep` 用 exit code 1 表示无匹配,>1 才是真错误;一并吞成空结果的话,一次跑不起来的搜索会伪装成「0 命中」—— 那正是这个工具要拦的反向幻觉,只不过换成由我们自己制造。
- **产出量在读取阶段封顶**,不是拿回全量再切。模型完全可以提交单字符 query,那会先把几百 MB 灌进缓冲区再撞上 maxBuffer,变成同一种假 0 命中。两道闸缺一不可:`-m` 管住单文件的命中数,而命中的**文件数**照样无上限 —— 故逐行读 stdout,数够文件上限就杀掉子进程。代价是剩下几个文件无从得知,所以「还有更多」是布尔不是计数;截断过就只报展示数,不能说「共 N 处」。

同理,`search_code` 的护栏做在**返回值**里而不是 prompt 里:prompt 层的告诫隔几万 token 就衰减了,返回值里的告诫在它做判断的那一刻被读到 —— 零命中必须内嵌「不能据此断言不存在」的免责句,截断必须回显总数,否则「没有调用点 ⇒ dead code」这条反向幻觉会畅通无阻。

### 裁决是标注,不是动作

`verdict` 三档 `confirmed / refuted / cannot_verify`(`cannot_verify` 不可省且**不等于 confirmed`** —— 合并它会让「查无实据」在统计与展示上都伪装成「已证实」)。裁决只落 `verdict` / `verdict_note` / `verdict_turn` 三列:**不动 severity、不动 triage**。机器降 severity 就是事实上的软剔除(severity 决定注意力排序),而剔除权只在 reviewer 手里 —— 这条线在自检轮就要划清。UI 只加一枚徽标 + 判据,判据必须与徽标成对给出:一条没有依据的「判不成立」比没有裁决更坏,它看起来像有人查过,而 reviewer 无从核对。

这条线要守住,光在 `judge_finding` 上设闸不够 —— **自检轮同时拒收 `update_finding`**。那条路能改 severity / 正文 / suggestion,不拦的话「降个级」「在 body 里补一句存疑」就是一道绕开取证、且直接改变 reviewer 待处置与待提交内容的侧门。判不成立走 `judge_finding`,发现的是新问题就 `report_finding` 另报一条。`resolve_finding` 有意不在此列:它写的是本轮表态(复审 turn 的正常产物,note 必填且要求自足),不碰 finding 本体。

裁决还会**过期**,两条规则与 resolution 同构:

- **按轮**:`verdictRound !== currentRound` 就不再展示(`currentVerdict`,与 `currentResolution` 同一条约定)。否则首轮判「不成立」的条目在下一轮被复审判「仍存在」后,会同时挂着两个互相矛盾的结论。
- **改写即作废**:reviewer 改写正文时三列一并清空 —— 判据说的是旧正文,留着就成了对不上号的引用。这与「改写正文作废本轮复核说明」是同一条规矩。

### 搜索能力随 source 而定

`search_code` 只在 source 拿得到完整代码树、且能与 `get_file` **同口径**时才声明:local-branch 搜 head 那棵树,gitbutler 搜工作区(含未跟踪),**github-pr 不实现**(走 `gh api` 逐文件取内容,没有可搜的树)。口径不一致比没有搜索更坏 —— agent 会拿着对不上的两段代码推出一个像模像样的结论。不实现时工具**根本不声明**,而不是声明了再报错:工具不存在,agent 就不会调用,也就不会把「搜不了」误读成「代码里没有」。

**L2「拉 worktree 写并执行对抗测试」已明确否决,别再提**。原因不是翻个 sandbox 开关那么简单:在审代码经常根本不在磁盘可运行形态(github-pr 走 `gh api` 无 checkout,local-branch 读 `git show HEAD:path`),要跑测试得先自建 worktree materialize + exec 审批通路,并正面扛「执行不可信 PR 代码」的安全面,还顶着 read-only / 只审不改两条铁律。

**强度与 `reasoningEffort` 正交** —— effort 是模型自身的推理深度,强度是审核方法论的深浅;对抗档**不**偷偷抬 effort。重跑可单轮调档,给出即持久化为新档(使后续轮次与续接追问的 baseInstructions 一致)。

## 保留自 1.0 的能力

审核会话历史 · 三种 source · 多层级覆盖的审核规则提示词(经 `thread/start · baseInstructions` 注入)· 审核总结 · **findings 筛选 + 提交到 GitHub**。
