# 实现进度

> 返回 [文档索引](../README.md) · 最后更新 2026-07-22 · origin/main HEAD=f5b6ee2
>
> 本页只做**导航与当前状态**:各层落地情况、如何运行、尚缺的整屏、spike 验证、与设计的偏差。实现细节以代码为准。逐切片的开发流水不在此保留(见 git history)。

## 当前状态:核心 review 闭环已可实机使用

真实链路(非 demo)已端到端打通并合入 main:

> 入口发起(本地分支 / GitHub PR / GitButler 三 source)→ **真实 codex 首轮扫描** → findings 经 MCP 流入 → 三栏 diff review(unified/split · 语法高亮 · viewed/折叠 · 拖栏宽)→ triage(保留/剔除/就地编辑)→ 框选/行内发起 discussion + **追问 codex**(多轮 · 重启后 `thread/resume` 续接)→ Summary(结论/统计/可编辑总结)→ 终点:**GitHub PR review 原子提交**(真实 `gh api`,含 422 锚点定位/修锚)或 **导出 Markdown**。

外加:模型/effort 选择(动态下拉 + 手填兜底)、完成通知(失焦原生 / 聚焦应用内)、审核规则三层编辑、键盘快捷键、持久化(全局偏好 + per-review viewed/tab)。

### 如何运行
- **实机**:`npm run rebuild:electron` → `npm start`。前提:`codex login`(扫描/追问烧 token);github-pr source 需 `gh auth login`。
- **前端视觉自查(不需 Electron)**:`npm run preview:ui` → 浏览器开 `/preview.html`。`src/renderer/preview/` 用 fixture stub `window.duetlens`,顶栏切明暗×配色两轴;支持 `?screen=entry|review|submit|prompt`、`?source=github`、`?submit=invalid|failed`、`?scan`、`?clean`。
- **ABI 坑**:同一 `better-sqlite3` 服务两运行时——app 需 Electron ABI(`rebuild:electron`)、spike/tsx 需 Node ABI(`rebuild:node`),切换后对方失效。

### 尚缺(不阻断核心,影响"零配置首用"顺滑;均有 mockup 未接 React)
1. **onboarding 环境自检屏**(`mockup/onboarding.html`):首启不检测 codex/gh,缺失时抛原始错误。
2. **独立设置屏**(`mockup/settings.html`):设置只能就地改(入口的模型/effort/通知、顶栏主题);codex 路径/`CODEX_HOME`、gh 路径无 UI,走 PATH 默认。
3. **历史屏**(`mockup/history.html`):只有入口「最近的审核」列表,无搜索/筛选/软删除。
4. 顶部 dev 屏切换导航为开发态临时物,非成品导航。

> 入口页丰富流程已接 mockup(见「前端屏」):三来源分段选择器、GitHub PR 粘贴+实时预览卡+remote 校验、最近 open PR 列表、gh 未登录引导、本地分支选择器(commits ahead + base)、GitButler workspace 检测+虚拟分支列表、附加上下文。后端配套 `source:*` 只读发现 IPC（check-gh-auth / preview-pr / list-open-prs / get-repo-remote / list-local-branches / detect-gitbutler）+ `review:list-recent`（附计数）。

## 分层落地情况

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 桌面外壳 | electron-forge(vite-typescript)+ React SPA | ✅ 骨架、安全基线(contextIsolation/sandbox)、主题两轴 |
| 主进程后端 | `src/main.ts` + `src/backend/**` | ✅ |
| ConversationalAgent 抽象 | `src/backend/agent/conversational-agent.ts` | ✅ 接口;codex 唯一实现 |
| codex app-server 封装 | `src/backend/agent/codex/`(jsonrpc / codex-app-server / codex-agent / protocol) | ✅ 薄封装、事件归一、elicitation 自动 accept、`model/list` |
| in-process HTTP MCP | `src/backend/mcp/duetlens-mcp-server.ts` | ✅ report_finding / update_finding / get_diff / get_file |
| review 编排 | `src/backend/review/`(review-session / review-manager / github-submitter) | ✅ 首轮扫描 + 多轮追问 + GitHub 提交 → 落库 → 领域事件 |
| source 层 | `src/backend/source/`(local-git / github-pr / gitbutler / create-source) | ✅ git / gh / but 三种齐备 |
| 持久化 | `src/backend/db/`(schema / database / review-store) | ✅ better-sqlite3、迁移(V4)、六表 |
| 领域模型 | `src/shared/domain.ts` | ✅ 类型 + zod ingress schema |
| IPC 契约 | `src/shared/ipc.ts` + `src/preload.ts` + `src/backend/ipc/` | ✅ 查询/命令/事件推送 + dialog + `review:diff` + `agent:list-models` |
| 结构化 diff | `src/shared/diff.ts` + `review_diffs` 表 | ✅ 后端预取落库、MCP 与 renderer 共用;add/del/modify/rename/binary |
| 前端屏 | `src/renderer/screens/`(EntryScreen + entry/ · ReviewScreen 三栏 · SubmitExportScreen · PromptRulesScreen) | ✅ 主流程四屏齐,入口页已接 mockup 丰富流程;缺 settings/history/onboarding 三屏(见上「尚缺」) |

## 端到端验证(headless spike)

`npm run spike:<name>`。`codex`/`review`/`source`/`discussion`/`resume` 真跑 codex(需 `codex login`、耗 token);其余确定性、不烧 token。

| spike | 验证 |
| --- | --- |
| `codex` | app-server 常驻会话 + MCP 注入 + report_finding 双向可见 + elicitation |
| `db` | 持久化读写 / 迁移(V3 model/effort · V4 notify)/ triage / update / 级联删 |
| `review` | ReviewSession 垂直:codex 扫描 → MCP → sqlite 落库 |
| `source` | LocalGitSource 取真实 git diff/文件 → codex → 落库;parsePrRef |
| `discussion` | 扫描后多轮追问 → user/agent 消息成对落库(同一 thread) |
| `resume` | session dispose 后按 threadId `thread/resume` 续接 → 复用会话记忆追问 |
| `gitbutler` | `but diff --format json` 重建 unified + 路径穿越防护 + 实仓 smoke |
| `mcp` | report_finding/update_finding 回写 store + bearer 令牌鉴权(无/错令牌 401) |
| `prompt` | 提示词分层解析/合并/注入:分节覆盖(project ▸ global ▸ builtin)+ baseInstructions 组装 |
| `diff` | parseUnifiedDiff 对 add/del/modify/rename/binary/多 hunk 的结构与行号 + store 回环 |
| `write` | finding 写路径:setTriage/updateFinding 落库 + 外发 `finding` 事件 |
| `ui-state` | per-review UI 态:get/saveReviewUiState 往返(viewed + last_active_tab)+ 默认/upsert/降级/级联 |
| `promote` | discussion→finding 提升:锚点沿用 + 会话历史保留 + kind 翻转 + 守卫 |
| `export` | 导出 Markdown 生成:结构 + 开关 + 分组 + 全部剔除空态;纯函数 |
| `submit` | GitHub 提交:payload 组装 + submitReview 的 success/增量/invalid/failed/非 github 守卫 + 锚点预判 |
| `add-finding` | 手动新增 finding(origin=manual)+ 建承载 discussion + 同 triage 管线 |
| `notify` | 完成通知决策:偏好门控 + 扫描完成去重 + 追问回复 + 失焦/聚焦分派;纯函数 |

`npm start` 实机验证过:Electron 启动、`better-sqlite3` Electron ABI 加载、六表迁移、IPC 注册无崩溃。

## 与设计的偏差 / 决策记录

- **前端重写不移植 1.0**;source 层重新实现(未整体搬 1.0 SourceFlow)。
- **首轮机审自建**,不复用 codex 内置 `review/start`。
- **MCP SDK 用低阶 `Server` + 手写 JSON Schema**,规避 zod4 与高阶 tool API 的兼容不确定性。
- **finding id 回环**:report_finding 由 MCP 生成 id 回传,codex 侧 id 与存储 id 一致,update_finding 据此定位。
- **提示词分节覆盖**:project→global→builtin 每节独立取最高优先层,整节替换(**节内追加已拍板不做**,winner-takes-all)。
- **右栏 tab 持久化**:全局 `ui_settings.default_tab` 为「无记忆时的初始默认」,per-review `review_ui_state.last_active_tab` 覆盖。
- codex 版本以 **0.144.1** 实测为准,**0.144.6 经 `generate-ts` 全量 diff 确认协议逐字节无变化**(详见 [codex-integration](codex-integration.md));协议子集手写在 `protocol.ts`。

## 后续可选项

diff-review 主流程(三栏 / triage / discussion / summary / 提交导出)与入口页丰富流程均已收口。未收口的整屏:settings / history / onboarding 三块从 mockup 接入 React——均不阻断核心 dogfood,按需再做。
