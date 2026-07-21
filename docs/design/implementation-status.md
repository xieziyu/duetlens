# 实现进度

> 返回 [文档索引](../README.md)
>
> 状态:后端垂直打通 + 前端 diff-review 起步 · 最后更新 2026-07-21(`origin/main` = d83d8c5) —— backlog #1–#6 已合入 main;#7 前端三栏 diff-review shell + 语法高亮 + 拖拽栏宽已合入 main;另有 UI preview harness(`npm run preview:ui`,脱 Electron 视觉自查)(见下)

设计文档描述目标结构;本页记录**已落地到代码**的部分、验证方式与剩余 backlog。实现细节以代码为准,本页只做导航与状态。

## 分层落地情况

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 桌面外壳 | electron-forge(vite-typescript)+ React SPA | ✅ 骨架、安全基线(contextIsolation/sandbox)、主题两轴 |
| 主进程后端 | `src/main.ts` + `src/backend/**` | ✅ |
| ConversationalAgent 抽象 | `src/backend/agent/conversational-agent.ts` | ✅ 接口;codex 唯一实现 |
| codex app-server 封装 | `src/backend/agent/codex/`(jsonrpc / codex-app-server / codex-agent / protocol) | ✅ 薄封装、事件归一、elicitation 自动 accept |
| in-process HTTP MCP | `src/backend/mcp/duetlens-mcp-server.ts` | ✅ report_finding / update_finding / get_diff / get_file |
| review 编排 | `src/backend/review/`(review-session / review-manager) | ✅ 首轮扫描 + 多轮追问(discussion 回路)→ findings/messages 落库 → 领域事件 |
| source 层 | `src/backend/source/`(source / local-git-source / github-pr-source / gitbutler-source / create-source) | ✅ git / gh / but(三种 source 齐备) |
| 持久化 | `src/backend/db/`(schema / database / review-store) | ✅ better-sqlite3、迁移、六表 |
| 领域模型 | `src/shared/domain.ts` | ✅ 类型 + zod ingress schema |
| IPC 契约 | `src/shared/ipc.ts` + `src/preload.ts` + `src/backend/ipc/` | ✅ 查询/命令(start/resume/send-message)/事件推送 + dialog 目录选择 + `review:diff` |
| 结构化 diff | `src/shared/diff.ts`(parseUnifiedDiff)+ `review_diffs` 表(schema V2) | ✅ 后端预取落库、MCP 与 renderer 共用;add/del/modify/rename/binary |
| 前端屏 | `src/renderer/`(EntryScreen 真实发起表单 / ReviewScreen 三栏 + FileTree/DiffPane/InlineCard/Resizer) | 🚧 三栏 shell + 只读 unified diff + 语法高亮(highlight.js)+ 拖拽栏宽 + 锚定内联 finding 卡 + off-diff 已落;编辑/triage/split/框选/discussion/summary 待做 |

## 端到端验证(headless spike)

`npm run spike:<name>`。前四个真跑 codex(需 `codex login`、耗 token);`mcp`/`diff`/`prompt`/`gitbutler` 确定性、不烧 token。**原生模块 ABI 切换**:同一个 `better-sqlite3` 服务两个运行时——跑 app(`npm start`)需 Electron ABI(`npm run rebuild:electron`),跑 spike(tsx/Node)需 Node ABI(`npm run rebuild:node`);两者切换后对方即失效,按当前要跑的目标先执行对应 rebuild。

| spike | 验证 |
| --- | --- |
| `codex` | app-server 常驻会话 + MCP 注入 + report_finding 双向可见 + elicitation |
| `db` | 持久化读写 / 迁移 / triage / update / 级联删 |
| `review` | ReviewSession 垂直:codex 扫描 → MCP → sqlite 落库 |
| `source` | LocalGitSource 取真实 git diff/文件 → codex → 落库;parsePrRef |
| `discussion` | 扫描后就 finding/user-discussion 多轮追问 → user/agent 消息成对落库(同一 thread) |
| `resume` | session dispose 后按落库 threadId `thread/resume` 续接 → 复用会话记忆追问 |
| `gitbutler` | `but diff --format json` 重建标准 unified + 路径穿越防护 + 实仓 smoke;不烧 token |
| `mcp` | MCP client 驱动 report_finding/update_finding 回写 store + bearer 令牌鉴权(无/错令牌 401);不烧 token |
| `prompt` | 审核规则提示词分层解析/合并/注入:分节覆盖(project ▸ global ▸ builtin)+ 空节忽略 + 两层读盘 + baseInstructions 组装;不烧 token |
| `diff` | parseUnifiedDiff 对 add/del/modify/rename/binary/多 hunk 的结构与行号 + store setDiff/getRawDiff 回环;不烧 token |

`npm start` 实机验证过:Electron 启动、`better-sqlite3` 在 Electron ABI 下加载、六表迁移到位、IPC 注册无崩溃。

**前端视觉自查(不需 Electron)**:`npm run preview:ui` 起纯 Vite dev server,`src/renderer/preview/` 用 fixture stub `window.duetlens`(一个 review + 多文件 diff + findings 含 off-diff),浏览器开 `/preview.html` 即渲染真实 diff-review 组件 + CSS,顶栏可切明暗×配色两轴。dev-only,forge 生产只打 `index.html`。做 UI 切片时先扩 `preview/fixtures.ts` 再看效果。

## 与设计的偏差 / 决策记录

- **前端重写不移植 1.0**;source 层重新实现(未整体搬 1.0 SourceFlow)。
- **首轮机审自建**,不复用 codex 内置 `review/start`。
- **MCP SDK 用低阶 `Server` + 手写 JSON Schema**,规避 zod4 与高阶 tool API 的兼容不确定性。
- **finding id 回环**:report_finding 由 MCP 生成 id 回传,使 codex 侧 id 与存储 id 一致,update_finding 据此定位。
- codex 版本以 **0.144.1** 实测为准,**0.144.6 经 `generate-ts` 全量 diff 确认协议逐字节无变化**(详见 [codex-integration](codex-integration.md));协议子集手写在 `protocol.ts`,`npm run codex:gen-types` 可全量重导比对。

## 剩余 backlog(非 UI 框架优先)

1. ✅ 多轮 / discussion 回路(sendMessage 续问、user-discussion + message 落库、追问经 IPC)—— source 生命周期改为随 session dispose(续问需读文件)
2. ✅ `thread/resume` 续接(会话不在内存时按 codexThreadId 重建 source + 恢复 codex thread;sendMessage 自动续接,另有显式 `review:resume`)—— demo review 因临时 workdir 重启即失效,续接面向真实 source
3. ✅ IPC `review:start` 真实命令通道(EntryScreen 真实发起表单:source 选择 / ref / 仓库目录选择器 / 基线;演示入口降级为次要链接)—— startReview 核心路径由 spike:source 覆盖
4. ✅ GitButler source(`but diff <branch> --format json` 重建 unified;文件读 worktree 磁盘;EntryScreen 选项已启用)
5. 生命周期健壮性:✅ MCP bearer 令牌隔离(codex 经 `bearer_token_env_var` 携带,无/错令牌 401)· ✅ `get_file` 路径穿越防护 · ✅ dispose 对齐(`disposeReview`/`review:release` + LRU 会话上限逐出闲置子进程)· ✅ 审批面收敛(反向审批归一成 `approval` 领域事件:受信 elicitation 自动 accept 为 expected,`execCommandApproval`/`applyPatchApproval` 等一律 denied 且上报)· ✅ 长会话 compaction 观测(依赖 codex 内置 auto-compact——按模型 `effective_context_window_percent` 默认开启、可 turn 内触发,优于我们只能插在 turn 间的手动 `thread/compact/start`;经 `contextCompaction` item 归一成 `compaction` 领域事件,压缩只摘要 codex 历史,不碰 DB 锚点/finding)
6. ✅ 多层级提示词(project→global→builtin **分节覆盖**注入 baseInstructions):resolver 在 `src/backend/prompt/review-prompt.ts`(5 固定节 focus/severity/ignore/tone/context + builtin 默认;层文件 `<cwd>/.duetlens/review.md` 与 `~/.duetlens/review.md`,H2 分节、空节不算覆盖、缺失/读错降级为不覆盖不阻断);每节独立取最高优先层,合并 + 操作性前言 = baseInstructions,经 ReviewManager 注入 start/demo/resume。spike:prompt 覆盖。builtin `focus` 用 better-review 1.0 builtin-rules 的 8 大类规范(非 mockup 占位);severity 保持 high/med/low;`category` 软规范集见 `FINDING_CATEGORIES`(自由串 + 建议取值,MCP 工具描述与 tone 节引用)。分节覆盖比 1.0 整档 winner-takes-all 更细,但仍是整节替换(节内追加待议)。**三层编辑器 UI + 读写 IPC 归入 #7**(与前端一起做)。
7. 前端:diff-review 三栏真实屏(进行中,已合入 main = b16c35d)
   - ✅ 后端 diff 暴露:`parseUnifiedDiff` + `review_diffs` 预取落库 + `review:diff` IPC(见上表)
   - ✅ 三栏 shell(FileTree | DiffPane | RightPanel)+ 只读 unified diff + 右栏 findings/扫描态
   - ✅ 语法高亮(`screens/review/highlight.ts` highlight.js core + 精选语言,按扩展名逐行高亮;token→`review-syntax.css` 映射主题 --k/--fn/...)
   - ✅ 可拖拽栏宽(`screens/review/Resizer.tsx`,左右 pane 间 5px handle;**本地态,未持久化**)
   - ✅ 锚定内联 finding 卡(read-only view 态,table→card→table 切段)+ off-diff banner + 右栏点选定位高亮
   - ✅ wordmark 多色 + 闪烁光标(App.tsx/App.css);删 DevBridgeProbe 骨架件
   - ⏳ InlineCard edit/dismissed/submitted 态 + 写路径(triage / update_finding / promote IPC)
   - ⏳ split 视图 · file-header viewed✓/折叠 · gutter 锚点圆点 · hover ＋ · 框选发起 discussion(SelectionPopover)· Composer · Discussion/Summary tab · 扫描 timeline · per-file viewed · 键盘快捷键
   - ⏳ 顶栏合并(App 全局栏 + rev-topbar 现为两条,mockup 是单条含 submit CTA/模型/⌘)· 主题+栏宽持久化(settings IPC)
   - ⏳ 审核规则三层编辑器(`mockup/prompt-rules.html`)+ 读写 IPC(读走 `review-prompt.ts`,写落 `.duetlens/review.md`)
