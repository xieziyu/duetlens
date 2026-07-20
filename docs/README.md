# Duetlens 文档索引

> Duetlens 是 [better-review](https://github.com/xieziyu/better-review) 的 **2.0 全重写**:把 code review 从"人消费 agent 一次吐出的 findings"变成"**人与 agent 协同对话式** review"。
>
> 状态:设计定稿 · 关键技术假设已验证 · **后端垂直已实现并端到端验证**(codex 扫描 → MCP → sqlite,含 source 层与 update_finding 回环)· 最后更新 2026-07-20
>
> 实现进度见 [design/implementation-status.md](design/implementation-status.md)。设计文档描述目标,实现细节以代码为准。

本索引是所有设计文档的**统一入口**。单篇文档只聚焦一个关注点,便于按需 recall。新增设计(如 UI 细化、持久化 schema、提示词系统)时新建分册并在下方"文档地图"登记一行。

## 文档地图

| 文档 | 内容 | 何时看 |
| --- | --- | --- |
| [design/overview.md](design/overview.md) | 定位、背景、核心变革、命名约定 | 想理解"为什么这么做" |
| [design/architecture.md](design/architecture.md) | 技术栈、架构分层与 `ConversationalAgent` 抽象、保留能力、暂不做的抽象 | 动结构 / 加模块前 |
| [design/data-model.md](design/data-model.md) | Review / codex thread / discussion / findings 的数据结构与状态 | 改 schema / 数据流前 |
| [design/findings-submit.md](design/findings-submit.md) | findings 筛选(保留/剔除)与提交到 GitHub PR review 的流程 | 碰提交流程 / finding 状态前 |
| [design/codex-integration.md](design/codex-integration.md) | app-server 协议验证结论、MCP HTTP 注入、elicitation/sandbox/审批 | 碰 codex 集成 / MCP / 审批前 |
| [design/ui.md](design/ui.md) | UI 方向 + 主题两轴 + 主入口/review 三 tab/扫描态/栏宽等屏与状态 | 做界面前 |
| [design/ui-states.md](design/ui-states.md) | 屏级流转 + 各组件状态机(scan / tab / card 四态 / finding 两轴 / diff / viewed / 空态) | 理状态迁移 / 接事件前 |
| [design/design-system.md](design/design-system.md) | tokens 单一来源(`tokens.css`)+ 两轴分组 + 组件清单;可视化在 `mockup/design-system.html` | 抽组件 / 定 tokens 前 |
| [design/frontend-components.md](design/frontend-components.md) | React 组件树 + 状态分层 + UI 状态持久化(粒度 / 存储 / schema) | 搭前端 / 定持久化前 |
| [design/implementation-status.md](design/implementation-status.md) | 各层落地情况 + headless spike 验证 + 与设计的偏差 + 剩余 backlog | 想知道「写到哪了」/ 接着开发前 |
| [design/open-questions.md](design/open-questions.md) | 待解决 / 风险点(开发中复审) | 遇到坑 / 排优先级时 |

## 命名约定(易踩)

codex app-server 把"一次常驻会话"本身称作 `thread`。为避免冲突,Duetlens 把自己"锚定代码的讨论线程"统一叫 **discussion**;`thread` / `conversation` 一词只指 codex 的会话实体。详见 [overview](design/overview.md)。

## 已拍板决策清单

最常被 recall 的核心决策;每条注明详述所在分册。

1. **全重写**(方案 A),另起新仓库,代号 **Duetlens**。→ [overview](design/overview.md)
2. 技术栈:**Electron + Node/TS 主进程后端 + codex app-server + 外部 gh CLI**,先做 macOS(选 Electron 图渲染与 Chrome 一致,规避 Tauri 的 WKWebView 差异)。→ [architecture](design/architecture.md)
3. findings 回传走 **MCP 工具**,不再 watch 文件(**已验证**)。→ [data-model](design/data-model.md) · [codex-integration](design/codex-integration.md)
4. 会话粒度:**一个 review 一个 codex thread**,全局视野;`thread/fork` 仅作备选。→ [data-model](design/data-model.md)
5. 保留:会话历史、三种 source、多层级提示词(经 `baseInstructions`)、审核总结、**findings 筛选+提交到 GitHub**。→ [architecture](design/architecture.md) · [findings-submit](design/findings-submit.md)
6. 多 agent 暂不做,只在 **`ConversationalAgent` 接口层** 留抽象。→ [architecture](design/architecture.md)
7. UI 整体重设计,**diff review 为核心界面**;讨论线程统一命名 **discussion**。→ [ui](design/ui.md)
8. MCP server 采用 **in-process HTTP transport**,经 `thread/start` 的 **per-thread config 注入**,不写全局 `~/.codex/config.toml`。→ [codex-integration](design/codex-integration.md)
9. **Elicitation 处理器为架构必需件**:对自建受信工具自动 accept,避免协同流程卡在审批。→ [codex-integration](design/codex-integration.md)
