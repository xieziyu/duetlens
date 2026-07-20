# 实现进度

> 返回 [文档索引](../README.md)
>
> 状态:后端垂直打通 · 最后更新 2026-07-20(`origin/main` = 340c0ea)

设计文档描述目标结构;本页记录**已落地到代码**的部分、验证方式与剩余 backlog。实现细节以代码为准,本页只做导航与状态。

## 分层落地情况

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 桌面外壳 | electron-forge(vite-typescript)+ React SPA | ✅ 骨架、安全基线(contextIsolation/sandbox)、主题两轴 |
| 主进程后端 | `src/main.ts` + `src/backend/**` | ✅ |
| ConversationalAgent 抽象 | `src/backend/agent/ConversationalAgent.ts` | ✅ 接口;codex 唯一实现 |
| codex app-server 封装 | `src/backend/agent/codex/`(jsonrpc / CodexAppServer / CodexAgent / protocol) | ✅ 薄封装、事件归一、elicitation 自动 accept |
| in-process HTTP MCP | `src/backend/mcp/DuetlensMcpServer.ts` | ✅ report_finding / update_finding / get_diff / get_file |
| review 编排 | `src/backend/review/`(ReviewSession / ReviewManager) | ✅ 首轮扫描 → findings 落库 → 领域事件 |
| source 层 | `src/backend/source/`(Source / LocalGitSource / GitHubPrSource / createSource) | ✅ git / gh;⏳ gitbutler 待接 but CLI |
| 持久化 | `src/backend/db/`(schema / database / ReviewStore) | ✅ better-sqlite3、迁移、六表 |
| 领域模型 | `src/shared/domain.ts` | ✅ 类型 + zod ingress schema |
| IPC 契约 | `src/shared/ipc.ts` + `src/preload.ts` + `src/backend/ipc/` | ✅ 查询/命令/事件推送 |
| 前端屏 | `src/renderer/`(EntryScreen / ReviewScreen 演示流 + useReviewStream) | 🚧 仅演示级;diff-review 三栏真实屏未做 |

## 端到端验证(headless spike)

`npm run spike:<name>`。前四个真跑 codex(需 `codex login`、耗 token);`mcp` 确定性、不烧 token。原生模块 ABI:跑过 `npm start`(Electron ABI)后再跑 spike 需 `npm rebuild better-sqlite3` 切回 Node ABI。

| spike | 验证 |
| --- | --- |
| `codex` | app-server 常驻会话 + MCP 注入 + report_finding 双向可见 + elicitation |
| `db` | 持久化读写 / 迁移 / triage / update / 级联删 |
| `review` | ReviewSession 垂直:codex 扫描 → MCP → sqlite 落库 |
| `source` | LocalGitSource 取真实 git diff/文件 → codex → 落库;parsePrRef |
| `mcp` | MCP client 驱动 report_finding(带 id)+ update_finding 回写 store |

`npm start` 实机验证过:Electron 启动、`better-sqlite3` 在 Electron ABI 下加载、六表迁移到位、IPC 注册无崩溃。

## 与设计的偏差 / 决策记录

- **前端重写不移植 1.0**;source 层重新实现(未整体搬 1.0 SourceFlow)。
- **首轮机审自建**,不复用 codex 内置 `review/start`。
- **MCP SDK 用低阶 `Server` + 手写 JSON Schema**,规避 zod4 与高阶 tool API 的兼容不确定性。
- **finding id 回环**:report_finding 由 MCP 生成 id 回传,使 codex 侧 id 与存储 id 一致,update_finding 据此定位。
- codex 版本以 **0.144.1** 实测为准,**0.144.6 经 `generate-ts` 全量 diff 确认协议逐字节无变化**(详见 [codex-integration](codex-integration.md));协议子集手写在 `protocol.ts`,`npm run codex:gen-types` 可全量重导比对。

## 剩余 backlog(非 UI 框架优先)

1. 多轮 / discussion 回路(sendMessage 续问、user-discussion + message 落库、追问经 IPC)
2. `thread/resume` 续接(codexThreadId 已落库)
3. IPC `review:start` 真实命令通道(替换演示入口)
4. GitButler source(`but` CLI diff)
5. 生命周期健壮性(MCP 端口/令牌隔离、dispose 对齐 review 生命周期、审批面收敛、长会话 compaction 触发)
6. 多层级提示词(project→global→builtin 注入 baseInstructions)
7. 前端:diff-review 三栏真实屏(抽 InlineCard / SelectionPopover / Composer),删 DevBridgeProbe 骨架件
