# 架构与技术栈

> 返回 [文档索引](../README.md)

## 技术栈决策

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面外壳 | **Electron** | 打包 Chromium,渲染与 Chrome 一致(规避 macOS 系统 WKWebView/Safari 内核的渲染差异);目标平台先做 macOS |
| 后端 | **Node / TypeScript**(Electron main 进程) | 编排层用 TS 写在 main 进程,**不引入独立后端进程**。可复用 1.0 的 `src/shared/` zod schema、source-flow、prompt-resolver,而非另用 Rust 重写 |
| 审核 agent | **codex app-server** | 常驻会话(JSON-RPC over stdio),取代 1.0 的一次性 `codex exec`。详见 [codex-integration](codex-integration.md) |
| MCP 回传通道 | **in-process HTTP MCP server**(Node) | Electron main 进程内自托管,codex 以 `--url` 连接;工具调用直接落进 app 状态 |
| 外部依赖 | `gh` CLI | 沿用外部进程调用拉取 PR / diff / 提交 review |
| 前端 | React(Web SPA,承载于 Electron renderer) | UI 整体重设计,见 [ui](ui.md) |

**为什么 Electron + Node 而不用 Tauri + 全 Rust:** 换 Electron 的动机是渲染一致性——Tauri 在 macOS 用系统 WKWebView(WebKit/Safari 内核),与 Chromium 有渲染差异,不少在 Chrome 上正常的效果到 WKWebView 会出问题;Electron 自带 Chromium,消除这类不确定性。换壳后主进程即 Node,"全 Rust 后端"的顺势前提随之消失:编排层的实质是管外部进程(git/gh/codex)+ 本地 HTTP MCP + sqlite + 事件流,都是 Node 的主场,也正是 1.0 已有实现,故后端定为 Node/TS 写在 main 进程——单进程、顺 Electron 纹理,并能捞回 1.0 的 TS 代码,反而**减少**重写量。

**代价与权衡:** Electron 打包体积显著大于 Tauri(自带 Chromium,~100MB 级 vs Tauri 复用系统 webview 的几 MB),内存占用更高,且须按 Electron 安全基线配置(`contextIsolation` 开、`nodeIntegration` 关、preload + `contextBridge` 暴露 IPC)。用渲染一致性 + 更低重写成本换体积/内存,详见 [open-questions](open-questions.md)。"收敛技术债"的目标不靠后端语言,而靠重新架构(新数据模型、MCP 回传 findings、discussion 实体)达成,与外壳/语言无关。

## 架构分层与抽象

- **`ConversationalAgent` 抽象(agent 接口层)**:定义 `startConversation` / `sendMessage` / `streamEvents` / `interrupt` / `approve` 等能力。codex app-server 是目前 **唯一** 实现。把 app-server 的 event / approval 模型包薄一层,不让它的协议细节渗透到 UI。协议可机器导出并据此生成 TS 类型(codex 提供 `generate-ts`),见 [codex-integration](codex-integration.md)。
- **MCP server(控制反转层)**:app 侧对 agent 暴露的工具集(`report_finding` 等),是 findings 和源码读取的回传通道。以 in-process HTTP 形式自托管、per-thread 注入——机制详见 [codex-integration](codex-integration.md)。
- **Elicitation / 审批处理器(必需件)**:codex 执行 MCP 工具前会发反向审批请求,client 必须应答,否则 turn 卡死。属架构必需件,详见 [codex-integration](codex-integration.md)。
- **source 层**:延续 1.0 的 SourceFlow 思路,三种 source 各一实现。
- **持久化**:会话历史、discussions、messages、findings 存本地 sqlite。**已定 `better-sqlite3`**(原生模块,须按运行时 rebuild ABI,见 [open-questions](open-questions.md));落地见 `src/backend/db/`。codex thread 由 codex 侧持久化,我们存 threadId 做续接。

## 保留能力(来自 1.0)

- 审核会话 **历史**
- 三种 source:**GitHub PR / 本地分支 / GitButler vbranch**
- **多层级覆盖** 的审核规则提示词(project → global → builtin)—— 通过 `thread/start` 的 `baseInstructions` 注入。只有**审核口径**可覆盖;描述 MCP 工具契约的段落是锁定段,不进分层模型也不下发 renderer(见 [ui](ui.md#审核规则提示词--三层编辑器mockupprompt-ruleshtml))
- agent 审核 **总结概况**(summary)
- **findings 筛选 + 提交到 GitHub**:勾选保留/剔除无用、提交前编辑,提交为 PR review 评论。核心流程见 [findings-submit](findings-submit.md)

## 暂不做,但保留抽象

- **多 agent**:这次只接 codex。**但** 在 `ConversationalAgent` 接口层留好口子,方便以后接入其他 agent。原则:**先只做一个真实实现,把接口磨对了再谈第二个**,避免过早抽象。
