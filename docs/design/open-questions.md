# 待解决 / 风险点

> 返回 [文档索引](../README.md)
>
> 开发中复审。关键技术假设已在 [codex-integration](codex-integration.md) 验证通过,以下为验证后仍需在骨架期打磨的项。

- **codex app-server API 稳定性**:仍标 experimental,可能无预告 breaking change → `ConversationalAgent` 薄封装 + `generate-json-schema` 导出做回归。
- **上下文 / token 膨胀**:单会话多轮追问会持续增长,长 PR 尤甚。已有 `thread/compact/start` 原语,但**何时触发压缩、压缩后锚点 / discussion 引用如何保持**仍需设计。
- **per-thread MCP 注入的鲁棒性**:🟡 部分落地 —— HTTP transport + 每会话独立 Server 已应对 codex 多次 `initialize`(端口 0 系统分配)。仍待做:令牌隔离、HTTP server 生命周期严格对齐 review 生命周期(dispose)。
- **审批面收敛**:🟢 已实测 —— 只读 sandbox 下除 MCP elicitation 外未见 `execCommandApproval` / `applyPatchApproval`;client 对二者一律 `denied`,elicitation 对受信工具自动 accept。
- **持久化 schema**:🟢 已定稿并落地 —— 见 `src/backend/db/schema.ts` 与 [data-model](data-model.md)、[implementation-status](implementation-status.md)。
- **原生模块 ABI**:🆕 `better-sqlite3` 在 Electron ABI 与 Node ABI 间不可兼容;`electron-forge start`/打包会 rebuild 为 Electron ABI,跑 tsx/Node spike 需 `npm rebuild better-sqlite3` 切回。已从 main bundle external。
- **上下文 / token 膨胀**:仍待做 —— `thread/compact/start` 何时触发、压缩后锚点保持未实现。
- **Electron 成本面**:自带 Chromium 使打包体积(~100MB 级)与内存占用显著高于 Tauri;安全基线(`contextIsolation` / `nodeIntegration` / preload `contextBridge`)🟢 已落实;自动更新、代码签名 / 公证仍待打包阶段做。这是为渲染一致性付出的代价(见 [architecture](architecture.md))。
