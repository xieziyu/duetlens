# 架构与技术栈

> 返回 [文档索引](../README.md)

## 技术栈决策

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面外壳 | **Tauri 2.0** | 目标平台先做 macOS |
| 后端 | **全 Rust**(方案 A) | 编排层完全用 Rust 重写,**不引入 Node sidecar**。借重写把数据 schema 收敛干净 |
| 审核 agent | **codex app-server** | 常驻会话(JSON-RPC over stdio),取代 1.0 的一次性 `codex exec`。详见 [codex-integration](codex-integration.md) |
| MCP 回传通道 | **in-process HTTP MCP server**(Rust) | Duetlens 进程内自托管,codex 以 `--url` 连接;工具调用直接落进 app 状态 |
| 外部依赖 | `gh` CLI | 沿用外部进程调用拉取 PR / diff / 提交 review |
| 前端 | React(Web SPA,承载于 Tauri webview) | UI 整体重设计,见 [ui](ui.md) |

**为什么全 Rust 而不用 Node sidecar:** 追求最彻底的重写和单进程干净架构。git/gh/codex 都是外部进程,Rust(tokio)管理子进程很称手;代价是 1.0 的 `src/shared/` zod schema、source-flow、prompt-resolver 等都要用 Rust 重写,但这也是收敛技术债的机会。

## 架构分层与抽象

- **`ConversationalAgent` 抽象(agent 接口层)**:定义 `startConversation` / `sendMessage` / `streamEvents` / `interrupt` / `approve` 等能力。codex app-server 是目前 **唯一** 实现。把 app-server 的 event / approval 模型包薄一层,不让它的协议细节渗透到 UI。协议可机器导出并据此生成 Rust 类型,见 [codex-integration](codex-integration.md)。
- **MCP server(控制反转层)**:app 侧对 agent 暴露的工具集(`report_finding` 等),是 findings 和源码读取的回传通道。以 in-process HTTP 形式自托管、per-thread 注入——机制详见 [codex-integration](codex-integration.md)。
- **Elicitation / 审批处理器(必需件)**:codex 执行 MCP 工具前会发反向审批请求,client 必须应答,否则 turn 卡死。属架构必需件,详见 [codex-integration](codex-integration.md)。
- **source 层**:延续 1.0 的 SourceFlow 思路,三种 source 各一实现。
- **持久化**:会话历史、discussions、messages、findings 存本地(sqlite 或等价方案,Rust 侧待定)。codex thread 由 codex 侧持久化,我们存 threadId 做续接。

## 保留能力(来自 1.0)

- 审核会话 **历史**
- 三种 source:**GitHub PR / 本地分支 / GitButler vbranch**
- **多层级覆盖** 的审核规则提示词(project → global → builtin)—— 通过 `thread/start` 的 `baseInstructions` 注入
- agent 审核 **总结概况**(summary)
- **findings 筛选 + 提交到 GitHub**:勾选保留/剔除无用、提交前编辑,提交为 PR review 评论。核心流程见 [findings-submit](findings-submit.md)

## 暂不做,但保留抽象

- **多 agent**:这次只接 codex。**但** 在 `ConversationalAgent` 接口层留好口子,方便以后接入其他 agent。原则:**先只做一个真实实现,把接口磨对了再谈第二个**,避免过早抽象。
