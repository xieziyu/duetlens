# 待解决 / 风险点

> 返回 [文档索引](../README.md)
>
> 开发中复审。关键技术假设已在 [codex-integration](codex-integration.md) 验证通过,以下为验证后仍需在骨架期打磨的项。

- **codex app-server API 稳定性**:仍标 experimental,可能无预告 breaking change → `ConversationalAgent` 薄封装 + `generate-json-schema` 导出做回归。
- **上下文 / token 膨胀**:🟢 已定 —— 依赖 codex 内置 auto-compact(按模型 `effective_context_window_percent` 默认开启,`model_auto_compact_token_limit:null` 即用模型默认而非关闭),能在 turn 内触发,优于只能插在 turn 间的手动 `thread/compact/start`。压缩只摘要 codex 内部历史;我们的 discussion / finding 锚点(file/line)存于自有 SQLite,与 codex 上下文无关,追问再重注入 finding 上下文,故锚点在压缩后天然保持。我们侧只做观测:`contextCompaction` item 归一成 `compaction` 领域事件。
- **per-thread MCP 注入的鲁棒性**:🟡 部分落地 —— HTTP transport + 每会话独立 Server 已应对 codex 多次 `initialize`(端口 0 系统分配)。仍待做:令牌隔离、HTTP server 生命周期严格对齐 review 生命周期(dispose)。
- **审批面收敛**:🟢 已实测并落地 —— 只读 sandbox 下除 MCP elicitation 外未见 `execCommandApproval` / `applyPatchApproval`;client 对二者一律 `denied`,elicitation 对受信工具自动 accept。反向审批现统一归一成 `approval` 领域事件(受信 accept 为 expected,其余 denied 且 expected=false),白名单外的反向请求经 IPC 上浮供 UI 审批卡呈现。
- **持久化 schema**:🟢 已定稿并落地 —— 见 `src/backend/db/schema.ts` 与 [data-model](data-model.md)、[implementation-status](implementation-status.md)。
- **原生模块 ABI**:🆕 `better-sqlite3` 在 Electron ABI 与 Node ABI 间不可兼容;`electron-vite dev` **不会**自动 rebuild,须先 `npm run rebuild:electron`(= `electron-builder install-app-deps`);`npm run package`/`dist` 出包时 electron-builder 自动 rebuild 为 Electron ABI。跑 tsx/Node spike 需 `npm run rebuild:node` 切回。已从 main bundle external,并在 asar 里 unpack。
- **Electron 成本面**:自带 Chromium 使打包体积(~100MB 级)与内存占用显著高于 Tauri;安全基线(`contextIsolation` / `nodeIntegration` / preload `contextBridge`)🟢 已落实;自动更新、代码签名 / 公证仍待打包阶段做。这是为渲染一致性付出的代价(见 [architecture](architecture.md))。
