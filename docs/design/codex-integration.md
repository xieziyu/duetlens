# codex app-server 集成

> 返回 [文档索引](../README.md)
>
> 审核 agent 完全建立在 codex-cli 的 `app-server` 之上。下列是**实测结论**(2026-07-18 在 0.144.5 字节级验证,2026-07-20 在 0.144.1 端到端复跑并修正),不是文档臆测。协议随版本演进,升级后重新导出比对。

## 关键假设验证

| 锁定假设 | 结论 |
| --- | --- |
| app-server 常驻会话取代 one-shot exec | ✅ `initialize` → `thread/start` → `turn/start` → `turn/completed` 跑通 |
| Duetlens 暴露 MCP、codex 调 `report_finding` 回传 | ✅ 事件流与 server 端 `tools/call` **双向观测** —— 「不再 watch 文件」坐实 |
| 只读 sandbox 锁定 | ✅ `read-only` 生效 |
| `ConversationalAgent` 抽象可落地 | ✅ 协议方法逐条对上 start / send / stream / interrupt / approve |
| token 膨胀有治理原语 | ✅ 内置 auto-compact + `thread/tokenUsage/updated` |

**版本稳定性**:`generate-ts` 全量导出在 **0.144.1 → 0.144.6 逐字节完全一致**(方法名 / 通知名 / 反向请求名全同),即 0.144.x 内 wire 契约无变化。升级到不同 minor 时按此法重导比对。我们只手写最小协议子集,全量重导有专门脚本。

## 会话 / turn 映射

- **会话 = thread**:`thread/start` / `resume` / `list` / `fork` / `archive` / `compact/start`。
- **一轮对话 = turn**:`turn/start` / `steer` / `interrupt`。
- **注入点(`thread/start` 参数)**:`baseInstructions`(多层级提示词)、`config`(透传 config.toml 的 map)、`sandbox`(**顶层参数,不在 `config` 里**)、`approvalPolicy`、`cwd`、`personality`。
- **MCP 工具调用没有 `item/mcpToolCall` 这个方法名**,经 `item/started` + `item/completed` 观测(`item.type === "mcpToolCall"` 时带 server / tool / status / arguments)。
- **`model/list`** 在 `initialize` 后即可调,复用本机登录态,**不起 thread、不发 turn,故不烧 token** —— 发起表单的模型下拉数据源。注意各模型的 `supportedReasoningEfforts` 与我们硬编码的 effort 集不完全一致,下拉未按模型动态收窄。

## MCP 传输:in-process HTTP + per-thread 注入

- main 进程内自托管 HTTP MCP server,codex 以 `--url` 连接;工具调用直接落进 app 状态,无需再 IPC 回来。
- 注入走 **per-thread config**(`config.mcp_servers.duetlens = { url }` + `sandbox: "read-only"`),**不写全局 `~/.codex/config.toml`** —— 避免污染用户环境,并让每次 review 用独立端口 / 令牌隔离。
- **为什么不用 stdio 子进程**:实测 codex 会对同一 MCP server 做**多次 `initialize`**(一次 review 观测到 startup starting/ready 各 4 次),stdio 子进程会被反复 respawn;HTTP transport 规避这一点。故每会话独立 Server 是对的。

## 审批 / elicitation(架构必需件)

codex 通过 **server→client 反向请求**要求授权,client 必须应答,否则 turn **卡死**。

**坑(已验证)**:即便 `approvalPolicy: "never"` + `sandbox: "read-only"`,codex 仍会在**每次** MCP 工具调用前发 elicitation。故 client 对**自建受信工具**自动 accept 是架构必需件(另一条路是 `AskForApproval::granular{ mcp_elicitations:false }`)。`exec` / `applyPatch` 类审批在 review-only 下一律拒绝(只读 sandbox 下实测未触发)。

反向审批统一归一成 `approval` 领域事件:受信 accept 标记为预期内,其余拒绝并上浮供 UI 审批卡呈现。

## 上下文压缩

**靠 codex 内置 auto-compact**(按模型的上下文窗百分比默认开启,配置项为 null 表示用模型默认**而非关闭**),它能**在 turn 内触发**,优于只能插在 turn 间的手动 `thread/compact/start` —— 手动那条覆盖不到单 turn 撑爆的场景,故**不主动调用**,也不做「立即压缩」按钮。

我们侧只观测,归一成 `compaction` 领域事件。压缩只摘要 codex 内部历史,**discussion / finding 的代码锚点存于自有 sqlite、与 codex 上下文无关**,追问时再重注入,故锚点在压缩后天然保持。

## 失败归因有两条通道,都要接

- `turn/completed` 的 `turn.error`(仅失败时有值)是**终局**。
- `error` 通知带 `willRetry` 报**中途失败** —— `willRetry=true` 时 codex 会自行退避重试(实测 5 次),这期间没有任何 item 事件,不接就是几十秒黑盒。

只在 `willRetry` 时外发重试事件(不再试的那次紧跟终局 `turn/completed`,两边都发会把同一次失败报两遍)。错误信息里的 `codexErrorInfo` 可能是裸字符串也可能是带 HTTP 状态码的单键对象;**`additionalDetails` 常常才是可诊断的那半,不要只取 `message`**。

## 已决定不复用的能力

codex 另有内置 `review/start` + `item/autoApprovalReview/*` 全流程 —— **不复用,自建 MCP 扫描**:用自己的 baseInstructions + `report_finding` 驱动首轮,与后续对话式 review 同一套机制、完全可控。
