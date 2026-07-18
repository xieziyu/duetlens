# codex app-server 集成

> 返回 [文档索引](../README.md)

Duetlens 的审核 agent 完全建立在 codex-cli 的 `app-server` 之上。本页记录集成机制与 2026-07-18 的验证结论。协议随版本演进,升级后应重新导出 schema 比对。

## 关键技术假设验证(2026-07-18,codex-cli 0.144.5)

对最高风险的假设做了真实字节级验证(非文档臆测)。全部通过:

| 锁定假设 | 验证方式 | 结论 |
| --- | --- | --- |
| app-server 常驻会话取代 one-shot exec | 真实 stdio JSON-RPC:`initialize` → `thread/start` → `turn/start` → `turn/completed` 跑通 | ✅ |
| Duetlens 暴露 MCP,codex 调 `report_finding` 回传 | 最小 MCP server per-thread 注入 → codex 实际以正确参数调用,事件流 `item/mcpToolCall` 与 server 端 `tools/call` **双向观测** | ✅ "不再 watch 文件"坐实 |
| 只读 sandbox 锁定 | `sandbox_mode:"read-only"` 生效(枚举 `read-only`/`workspace-write`/`danger-full-access`) | ✅ |
| `ConversationalAgent` 抽象可落地 | 协议 schema 机器导出,方法逐条对上 start/send/stream/interrupt/approve | ✅ |
| token 膨胀有治理原语 | 协议内置 `thread/compact/start` + `thread/tokenUsage/updated` | ✅ |

## 协议获取

`codex app-server generate-json-schema --out <DIR>`(另有 `generate-ts`)可机器导出协议:约 **87** 个 client→server 请求、**68** 个流事件、**10** 个 server→client 反向审批请求。据此生成 Rust 类型并对 codex 升级做回归。

## 会话 / turn 映射到 `ConversationalAgent`

- **会话 = thread**:`thread/start`(返回 threadId,带 `forkedFromId`/`parentThreadId`/`ephemeral`/`historyMode`)、`thread/resume`/`list`/`fork`/`archive`/`compact/start`。
- **一轮对话 = turn**:`turn/start`(input=`[{type:"text",text}]`)、`turn/steer`(中途注入)、`turn/interrupt`。
- **流事件**:`turn/started`、`item/started`、`item/agentMessage/delta`、`item/reasoning/*`、`item/mcpToolCall`、`item/completed`、`turn/completed`、`thread/tokenUsage/updated`。

**注入点**(`thread/start` 参数):`baseInstructions`(多层级提示词)、`config`(per-thread 覆盖,可注入 MCP server 与 sandbox)、`approvalPolicy`、`cwd`、`personality`。

## MCP 传输:in-process HTTP + per-thread 注入

- Duetlens 在 Rust 进程内自托管一个 **HTTP MCP server**,codex 以 `--url` 连接;工具调用直接落进 app 状态,无需再 IPC 回来。
- 注入走 **per-thread config**:`thread/start.config = { mcp_servers: { duetlens: { url: "http://127.0.0.1:PORT" } }, sandbox_mode: "read-only" }`。**不写全局 `~/.codex/config.toml`**,避免污染用户环境,并让每次 review 用独立端口/令牌隔离。
- thread 启动时 codex 自动拉起 MCP server 并流 `mcpServer/startupStatus/updated`(starting→ready)。
- **为什么不用 stdio 子进程**:实测 codex 会对 MCP server 做多次 `initialize`(thread 启动一次、首次用工具一次),stdio 子进程会被反复重启/重连;HTTP transport 规避 respawn。

## 审批 / elicitation(架构必需件)

codex 通过 **server→client 反向请求** 要求授权,client 必须应答,否则 turn **卡死**:

- `mcpServer/elicitation/request` —— MCP 工具调用前的批准(`_meta.codex_approval_kind`,`persist:["session","always"]`;应答 `{action:"accept"|"decline"|"cancel"}`)。
- 其他:`execCommandApproval`、`applyPatchApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。

**坑(已验证)**:即便 `approvalPolicy:"never"` + `sandbox_mode:"read-only"`,codex 仍会对 MCP 工具发 elicitation。两条治理路径:
1. client 侧对**自建受信工具**(`report_finding` 等)自动 `accept`——列为架构必需件;
2. 或用 `AskForApproval::granular{ mcp_elicitations:false }` 从源头关。

## 相关枚举

- `SandboxMode` = `read-only` / `workspace-write` / `danger-full-access`
- `AskForApproval` = `untrusted` / `on-request` / `never` / `granular{ mcp_elicitations, rules, sandbox_approval, request_permissions }`
- `Personality` = `none` / `friendly` / `pragmatic`

## 版本注记与待评估

- 基于 codex-cli **0.144.5**,`app-server` 仍标 `[experimental]`,可能无预告 breaking change → `ConversationalAgent` 薄封装 + schema 导出回归隔离。
- codex 另有内置 `review/start` + `item/autoApprovalReview/*` 全流程,**首轮机审或可复用而非自造**(待评估)。
