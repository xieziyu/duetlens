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
| 主题两轴 / 栏宽 / 默认 tab / 默认 diff 视图 | per-user(`ui_settings`) | 用户级偏好,不随 PR 变;单次审核内的临时覆盖属 ephemeral,不写回默认 |
| per-file viewed / 本次 tab | per-review(`review_ui_state`) | 属这次审核的进度,换 PR 应清零,并要与「N 改动 · M 已看」一致 |
| diff 折叠 / banner 展开 / 编辑草稿 | 不持久化 | 纯视图态 |

**一律进后端 sqlite,不用 renderer `localStorage`**:领域进度(viewed 是这次 review 的一部分)要能随会话历史一起恢复;外观偏好放同一处是为单一来源,顺带避开多窗口 / 清缓存导致的漂移与两套读写路径。

## 审核强度

`ReviewIntensity = standard | adversarial` 两档,**只做 L1(只读对抗推理)**:对抗档注入证伪立场段(归锁定角色侧、不进分层模型),并在扫描 / 复审 turn 之后于**同一 thread** 追加一轮自检(补漏 + 给存疑结论降级 —— codex 侧没有删除 finding 的工具);自检失败吞掉、保留扫描成果。

**L2「拉 worktree 写并执行对抗测试」已明确否决,别再提**。原因不是翻个 sandbox 开关那么简单:在审代码经常根本不在磁盘可运行形态(github-pr 走 `gh api` 无 checkout,local-branch 读 `git show HEAD:path`),要跑测试得先自建 worktree materialize + exec 审批通路,并正面扛「执行不可信 PR 代码」的安全面,还顶着 read-only / 只审不改两条铁律。

**强度与 `reasoningEffort` 正交** —— effort 是模型自身的推理深度,强度是审核方法论的深浅;对抗档**不**偷偷抬 effort。重跑可单轮调档,给出即持久化为新档(使后续轮次与续接追问的 baseInstructions 一致)。

## 保留自 1.0 的能力

审核会话历史 · 三种 source · 多层级覆盖的审核规则提示词(经 `thread/start · baseInstructions` 注入)· 审核总结 · **findings 筛选 + 提交到 GitHub**。
