# 实现进度

> 返回 [文档索引](../README.md)
>
> 状态:后端垂直打通 + 前端 diff-review 推进中 · 最后更新 2026-07-21(`origin/main` = c7cd172) —— backlog #1–#6 已合入 main;#7 前端三栏 diff-review shell + 语法高亮 + 拖拽栏宽 + **finding 写路径(triage + 就地编辑)** + **diff 视图交互(unified/split + per-file viewed/折叠)** + **框选/行内 ＋ 发起 discussion + Discussion 栏协同对话** + **Summary tab(结论/统计/可编辑总结/关注主题筛选)** + **全局 UI 偏好持久化(主题/栏宽/tab/diff 视图)** + **per-review viewed 持久化(`review_ui_state`)** + **键盘快捷键 + 帮助浮层** + **promote(discussion→finding)**均已合入 main(右栏三 tab 全齐);另有 UI preview harness(`npm run preview:ui`,脱 Electron 视觉自查)(见下)

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
| 前端屏 | `src/renderer/`(EntryScreen 真实发起表单 / ReviewScreen 三栏 + FileTree/DiffPane/InlineCard/Resizer + SelectionPopover/InlineComposer/DiscussionTab/Composer/SummaryTab + settings/SettingsProvider) | 🚧 三栏 shell + unified/split diff + 语法高亮(highlight.js)+ 拖拽栏宽 + 锚定内联 finding 卡 + off-diff + **finding 写路径(triage + 就地编辑)** + **per-file viewed/折叠** + **框选/行内 ＋ 发起 discussion + Discussion 栏对话** + **Summary tab(结论/统计/可编辑总结/关注主题筛选)** + **全局 UI 偏好持久化(主题/栏宽/tab/diff 视图)** + **per-review 进度持久化(viewed → `review_ui_state`)**已落;提交屏 待做 |

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
| `write` | finding 写路径:ReviewManager.setTriage/updateFinding 落库 + 外发 `finding` 事件(dismiss→keep 往返、编辑不重置 triage、suggestion 清空、未知 id 抛错);不烧 token |
| `ui-state` | per-review UI 进度态:ReviewStore.get/saveReviewUiState 往返 + 默认空态 + upsert 单行 + 损坏 JSON 降级 + 级联删除;不烧 token |
| `promote` | discussion→finding 提升:锚点沿用 + 会话历史保留 + kind 翻转为 finding + 重复/无锚点/未知 id 守卫;不烧 token |
| `export` | 导出 Markdown 生成:文件名 slug + 结构(标题/来源 blockquote/摘要/Findings)+ 开关(summary/suggestion/dismissed)+ 分组(按严重度/按文件)+ 全部剔除空态;纯函数、不烧 token |
| `submit` | GitHub 提交:payload 组装(inline RIGHT 锚点 + suggestion 块 + summary body)+ ReviewManager.submitReview 的 success(锁定 submitted/status/事件)/ 增量(已提交不重发)/ invalid / failed / 非 github 守卫;注入假 submitter、不烧真 PR |
| `add-finding` | 手动新增 finding:ReviewManager.addManualFinding 落库(origin=manual)+ 建承载 discussion + 外发 finding/discussion 事件 + 同 triage 管线 + body/suggestion/category 缺省;不烧 token |

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
7. 前端:diff-review 三栏真实屏(进行中,已合入 main = 3b2f704)
   - ✅ 后端 diff 暴露:`parseUnifiedDiff` + `review_diffs` 预取落库 + `review:diff` IPC(见上表)
   - ✅ 三栏 shell(FileTree | DiffPane | RightPanel)+ 只读 unified diff + 右栏 findings/扫描态
   - ✅ 语法高亮(`screens/review/highlight.ts` highlight.js core + 精选语言,按扩展名逐行高亮;token→`review-syntax.css` 映射主题 --k/--fn/...)
   - ✅ 可拖拽栏宽(`screens/review/Resizer.tsx`,左右 pane 间 5px handle;**本地态,未持久化**)
   - ✅ 锚定内联 finding 卡(read-only view 态,table→card→table 切段)+ off-diff banner + 右栏点选定位高亮
   - ✅ wordmark 多色 + 闪烁光标(App.tsx/App.css);删 DevBridgeProbe 骨架件
   - ✅ finding 写路径 · triage + 就地编辑:`review:set-triage` / `review:update-finding` IPC(ReviewManager.setTriage/updateFinding 落库后外发 `finding` 事件,useReviewStream upsert)+ InlineCard view/edit/dismissed 三态(severity/category/title/body/suggestion 编辑,⌘↵ 保存 / Esc 取消,✕ 剔除 / ↩ 恢复;submitted 只读)+ 右栏 Findings tab triage 保留/剔除/恢复 + 保留·剔除 tally。preview fixtures 写路径改内存态并回推事件,双主题实测闭环。**promote(discussion→finding)/ 手动新增 finding / submission 落 submit 屏归后续切片**
   - ✅ diff 视图交互:unified/split 切换(file-header segmented,全局态;`toSplitRows` 把连续 del/add 两两配成并排双列,pure-add/pure-del 一侧留 blank,内联卡与 unified 共用 InlineCard、锚点一律新侧行号,split 亦逐行语法高亮)+ per-file viewed✓/折叠(file-header ✓=标记已看并折叠、⌄=仅折叠,折叠显 file-collapsed-bar;FileTree viewed tick + 划线灰显 + 树头「N 改动 · M 已看」进度)。**均为本地态,持久化统一留 ④**
   - ✅ 框选发起 discussion + Discussion 栏协同对话(已合入 main):DiffPane 框选选区解析新侧锚点 → SelectionPopover(`发起 discussion` / `追问 codex`);行内 hover ＋(每新侧行)→ InlineComposer 就地新建;发送即 `addDiscussion` + `sendMessage`,消息经事件流回推。右栏 Discussion tab = 线程切换器 + 活跃线程(anchor-ref + finding 根气泡 + user/agent 气泡 + agent 打字指示 + 自动滚底)+ Composer(引用 chip + 发送);点 finding 亦选中其讨论线程。useReviewStream 加 `ensureMessages` 懒加载续接旧 review 的历史消息。preview fixtures stub `addDiscussion`/`sendMessage`(延迟回推 agent 回复),双主题实测:框选 popover/行内 composer/线程/追问引用/发送闭环全通。**追问烧 token 的真实回路由 spike:discussion 覆盖。**
   - ✅ Summary tab(已合入 main):结论卡(按未剔除 findings 最高严重度推导 review event:high→Request changes / 有→Comment / 无→Approve,标「仅建议·提交时确认」)+ 统计条(high/med/low + 保留/已提交/讨论)+ **可编辑总结正文**(轻量 markdown 视图 `**粗**`/`` `代码` ``/空行分段 ↔ textarea,⌘↵ 保存·Esc 取消,经 `review:update-summary` 落库、`review` 事件回推)+ 关注主题(按 category 聚合,点击→切 Findings tab 并按分类筛选,Findings 顶部出「筛选·X ✕」可清)+ 覆盖度行 + 提交 CTA(禁用,提交屏后续)。后端补 `ReviewManager.updateSummary`(store.setReviewSummary 已存在)+ `review` ReviewEvent 变体 + useReviewStream setReview。preview fixtures stub updateSummary。双主题实测:verdict/stats/markdown 编辑保存/分类筛选全通。
   - ✅ 全局 UI 偏好持久化(已合入 main):`SettingsProvider`(`src/renderer/settings/`)启动拉 `ui.getSettings`、改动去抖(400ms)写回 `ui.saveSettings`、主题两轴挂 documentElement,取代原来只存组件 state 的 ThemeProvider(已删)。App 主题控件 + ReviewScreen 的栏宽/默认 tab/默认 diff 视图全部改由 settings 驱动、拖拽/切换即写回。**后端 `ui_settings` 表 + IPC 早已就绪,本切片纯前端接线。** per-file viewed/collapsed 仍为 per-review 本地态(`review_ui_state` 持久化留后续)。preview fixtures 用非默认栏宽(300/420)+ 可变 saveSettings 存储,实测:启动即应用 300/420、明暗切换与 split 切换经去抖落库回读一致。
   - ✅ per-review UI 态持久化(viewed → `review_ui_state`,已合入 main):`review:get-ui-state`/`review:save-ui-state` IPC(ReviewManager.get/saveReviewUiState → ReviewStore JSON 列)+ `useReviewUiState` hook(挂载按 reviewId 拉取、viewed 改动去抖 400ms 写回、恢复时把已看文件默认折叠)。collapsed 是「标记已看即折叠」派生的临时态、不持久化。preview fixtures 预置一个已看文件证明启动即恢复(非空态);`npm run spike:ui-state` 确定性 PASS。**last_active_tab 列暂留空(tab 现为全局 `ui_settings` 偏好)**
   - ✅ 键盘快捷键 + 帮助浮层(→ mockup #kbdHelp,已合入 main):`useEffect` 全局 keydown —— `?`/⌘ 开关帮助、`Esc` 关、`1/2/3` 切右栏 tab、`u` 切 unified/split(经 `update()` 一并去抖持久化到 `ui_settings`);焦点在输入框或按住修饰键时让位。`KbdHelp.tsx` 双列分组浮层(仅列已实现快捷键;编辑/发送的 ⌘↵·Esc·↵ 由各 InlineCard/Composer/SummaryTab 自理)。rev-topbar 加 `⌘` 触发按钮。preview 实测:帮助开关、Esc、1/2/3 切 tab、u 切 diff 全通
   - ✅ promote(discussion→finding,已合入 main):Discussion 栏活跃 user 线程顶部「⬆ 转为 finding」按钮 → `review:promote-discussion` IPC(ReviewManager 派生默认标题/正文取首条 user 消息、severity 默认 medium → ReviewStore.promoteDiscussion 翻转 discussion.kind=finding/origin=promoted + 建 finding、事务保证、锚点沿用 discussion、保留会话历史)→ 外发 `finding` + `discussion` 事件(useReviewStream discussion 改为 upsert 使 kind 变更传播)→ 前端聚焦新 finding 内联卡就地编辑。`npm run spike:promote` 确定性 PASS;preview 实测:user 线程 promote → Findings 4→5、glyph 你→◆、内联卡「你·提升」、按钮消失。**手动新增 finding(需锚点选择 UX)留后续切片**
   - ✅ 提交屏 · 导出 Markdown(非 GitHub source 终点,feat/dev):`SubmitExportScreen` 按 `review.source` 分派——`local-branch`/`gitbutler-vbranch` → `ExportMarkdownScreen`(左预览 hero + 右配置)。纯生成器 `src/shared/export-markdown.ts`(`buildReviewMarkdown`/`exportFileName`/`isKept`,triage!=dismiss 即保留、按严重度/文件分组、summary/suggestion/dismissed 开关),轻量 md 渲染 `screens/export/markdown.ts`(渲染/源码切),右栏保留 checklist 走同一 triage 管线(`setTriage`→事件回推→预览实时刷新)。保存经新 IPC `dialog:save-text-file`(main `showSaveDialog`+`writeFile`);复制走 `navigator.clipboard`。`npm run spike:export` 确定性 PASS;preview 双主题实测全通。
   - ✅ 提交屏 · GitHub PR review(github-pr source 终点,feat/dev):`SubmitExportScreen` github-pr 分支 → `SubmitGitHubScreen`(左 findings 筛选 + 右 Finish your review)。纯组装 `src/shared/github-review.ts`(`buildPrReviewPayload`:有锚点→inline RIGHT 行评论 + suggestion 块,无锚点→并入 review body;`isSubmittable`=保留且未提交)。提交层 `backend/review/github-submitter.ts`(`GhReviewSubmitter` 经 `gh api …/reviews --input -` 原子提交,实时 head sha 作 commit_id,422/行锚点→invalid、其余→failed;`GitHubSubmitter` 接口可注入)。`ReviewManager.submitReview`:summaryBody 先落库 → 组装待提交集 → 提交;success 时逐条 `setSubmission('submitted', url)` + `setReviewStatus('submitted')` + 事件回推,invalid/failed 不改任何态。已提交项锁定 → 二次提交只发新 delta(增量天然)。新 IPC `review:submit`;`exec.ts` 加 stdin 支持。前端状态机 ready/submitting/success(锁定+GitHub 链接)/invalid(422 banner)/failed(重试);summary textarea 复用 `updateSummary`,event 三选(Comment/Request changes/Approve)。`npm run spike:submit` 确定性 PASS;preview `?source=github`(+`?submit=invalid|failed`)双主题实测:success 锁定+增量 bar、422 banner、failed 重试全通。**per-finding 422 定位 + 修锚点/降级 fix-action、inline 编辑(diff 屏已有)留后续。**
   - ✅ 顶栏合并(review 单顶栏,feat/dev):抽出 `components/Wordmark` + `components/ThemeControls` 复用;review 屏自渲染合并单栏(brand + 源 chip/title + spacer + meta:model glyph·codex / lastTool / tokens 环 / status / **常驻 CTA** / 主题两轴 / ⌘),`App` 在 `screen==='review'` 时不再套全局栏(entry/submit 仍保留骨架期全局栏 + 开发用屏切换)。CTA 按 `review.source` 分派——github-pr「提交 review」(徽标=待提交 `isSubmittable` 数)/ 本地·vbranch「↓ 导出 review」(徽标=保留数),点击 `onOpenSubmit` 切提交/导出屏。`rev-topbar` 领 `-webkit-app-region: drag` + 88px 交通灯内缩(合并后即窗口顶栏)。preview 双主题 × 双 source 实测:单栏渲染、CTA 变体、CTA→提交/导出→返回闭环全通。**submit/export 屏的次级 bar(exp/sg-topbar)本次不并——其为返回 diff 的子导航,非同一层。**
   - ✅ 手动新增 finding(origin=manual,feat/dev):diff 框选 → SelectionPopover 加第三动作「＋ 记为 finding」→ 锚点处内联 `NewFindingComposer`(空白起编,复用 InlineCard 编辑态 `.c-edit/.fe-*` 样式:severity/category/title/body/suggestion,标题必填,⌘↵ 新增·Esc 取消)。保存即 `review:add-finding` IPC → `ReviewManager.addManualFinding`(store.addFinding origin=manual + 建承载 discussion + 外发 finding/discussion 事件)→ 前端 upsert 并聚焦新 finding 内联卡,切 Findings tab。**创建即完整、不留空草稿、无需删除路径**;与 agent finding 同 schema/同 triage·提交管线。DiffPane 内联 composer 改为多态(discussion/finding 共用锚点插槽)。`exec` 无关;`npm run spike:add-finding` 确定性 PASS;preview 实测:框选→记为 finding→填写→新增,Findings 4→5、新卡「● 你 · HIGH·Correctness」锚 pipeline.ts:16、CTA 徽标随之 +1。
   - ⏳ gutter 锚点圆点(有讨论的行)· 扫描 timeline
   - ⏳ 审核规则三层编辑器(`mockup/prompt-rules.html`)+ 读写 IPC(读走 `review-prompt.ts`,写落 `.duetlens/review.md`)
