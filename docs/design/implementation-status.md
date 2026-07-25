# 实现进度

> 返回 [文档索引](../README.md)
>
> 本页只做**导航与当前状态**:各层落地情况、如何运行、尚缺的整屏、spike 验证、与设计的偏差。实现细节以代码为准。逐切片的开发流水不在此保留(见 git history)。
>
> 不写 HEAD / 最后更新日期 —— 那种快照值每次合并都得人肉改,漏改一次就开始骗人。要时间线就查 `git log`。

## 当前状态:核心 review 闭环已可实机使用

真实链路(非 demo)已端到端打通并合入 main:

> 入口发起(本地分支 / GitHub PR / GitButler 三 source)→ **真实 codex 首轮扫描** → findings 经 MCP 流入 → 三栏 diff review(unified/split · 语法高亮 · viewed/折叠 · 拖栏宽)→ triage(保留/剔除+可选理由/就地编辑)→ 框选/行内发起 discussion + **追问 codex**(多轮 · 重启后 `thread/resume` 续接)→ **↻ 重跑复审**(每轮新 thread · 重拉 diff · agent 对旧 findings 表态 · 剔除项抑制 · 同步 PR 评论)→ Summary(结论/统计/可编辑总结)→ 终点:**GitHub PR review 原子提交**(真实 `gh api`,进屏与 422 后均**现拉最新 diff**定位失效锚点,支持逐条/成批修锚)或 **导出 Markdown**。

外加:模型/effort 选择(动态下拉 + 手填兜底)、完成通知(失焦原生 / 聚焦应用内)、审核规则三层编辑(可配置口径与锁定契约分离,见下「关键决策」)、键盘快捷键、持久化(全局偏好 + per-review viewed/tab)。

### 如何运行
- **实机**:`npm run rebuild:electron` → `npm start`。前提:`codex login`(扫描/追问烧 token);github-pr source 需 `gh auth login`。
- **前端视觉自查(不需 Electron)**:`npm run preview:ui` → 浏览器开 `/preview.html`。`src/renderer/preview/` 用 fixture stub `window.duetlens`;明暗在左侧 rail 底部切,配色主题在设置屏(`?screen=settings`)。支持 `?screen=entry|review|submit|prompt|settings|history|onboarding`、`?source=github`、`?submit=invalid|failed`(`invalid` 同时让「最新 diff」推进,复现锚点落空)、`?latest=error`(现拉最新 diff 失败)、`?scan`、`?clean`。
- **mockup 自查**:`mockup/*.html` 要用静态服务打开(如 `python3 -m http.server`),**不能走 `preview:ui`** —— vite 会把 mockup 当入口做 HTML transform,代码示例里的 `Result<()>` 之类会被当标签解析而报错。
- **出包**:`npm run package` 出免打包的 `release/mac-arm64/Duetlens.app`,`npm run dist` 出 zip。本地无 Developer ID,走 ad-hoc 签名(`identity: "-"` + `disable-library-validation` entitlement);翻过 fuses 的二进制不重签会被系统 SIGKILL。
- **ABI 坑**:同一 `better-sqlite3` 服务两运行时——app 需 Electron ABI(`rebuild:electron`)、spike/tsx 需 Node ABI(`rebuild:node`),切换后对方失效。

### 应用外壳(2026-07-23 重设计,方案见 [ui](ui.md#应用外壳导航-rail--顶栏--底部状态栏2026-07-23-重设计))

开发态的顶栏屏切换已由**全局导航 rail** 取代(`src/renderer/components/AppRail.tsx`,除 onboarding 外各屏共用);review 屏顶栏瘦身为纯上下文 + CTA,agent 运行态下沉到**底部状态栏**(`screens/review/StatusBar.tsx`),diff 视图切换归**中栏列头**(`.diff-bar`,见 `screens/review/DiffPane.tsx`);file-header 改为文件名 / 路径两行。App 外壳是一张 `top / rail+host / foot` 网格,屏根用 `display:contents` 直接落进去。github-pr review 顶栏的来源 chip **整枚可点开 PR**(IPC `review:open-in-browser`,URL 在 main 侧解析后 `shell.openExternal`)。

### 尚缺
1. 键位表不可配置(帮助层为只读 cheatsheet)。
2. 运行时/异常态(turn 中断 / 反向审批 / turn 失败 / 连接断 / 压缩)只有设计,未落地 —— 设计见 `mockup/review-runtime.html`。`mockup/` 整体已冻结,但这一份是该功能目前**唯一**的设计参照,落地前别丢。

> 入口页丰富流程已接 mockup(见「前端屏」):三来源分段选择器、GitHub PR 粘贴+实时预览卡+remote 校验、默认折叠的 open PR 列表(展开才拉)、gh 未登录引导、本地分支选择器(commits ahead + base)、GitButler workspace 检测+虚拟分支列表、附加上下文。后端配套 `source:*` 只读发现 IPC（check-gh-auth / preview-pr / list-open-prs / get-repo-remote / list-local-branches / detect-gitbutler）+ `review:list-recent`（附计数）。发起后到进屏之间由**启动等待浮层**接管（`screens/entry/StartOverlay.tsx`，阶段走 `review:start-progress` 事件；设计见 [ui](ui.md#启动等待浮层点开始审核到进屏之间)）。

## 分层落地情况

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 桌面外壳 | electron-vite(构建)+ electron-builder(出包)+ React SPA | ✅ 骨架、安全基线(contextIsolation/sandbox)、主题两轴 |
| 主进程后端 | `src/main.ts` + `src/backend/**` | ✅ |
| ConversationalAgent 抽象 | `src/backend/agent/conversational-agent.ts` | ✅ 接口;codex 唯一实现 |
| codex app-server 封装 | `src/backend/agent/codex/`(jsonrpc / codex-app-server / codex-agent / protocol) | ✅ 薄封装、事件归一、elicitation 自动 accept、`model/list` |
| in-process HTTP MCP | `src/backend/mcp/duetlens-mcp-server.ts` | ✅ report_finding / update_finding / **resolve_finding** / get_diff / get_file |
| review 编排 | `src/backend/review/`(review-session / review-manager / github-submitter) | ✅ 首轮扫描 + 多轮追问 + **多轮重跑复审** + GitHub 提交 → 落库 → 领域事件 |
| source 层 | `src/backend/source/`(local-git / github-pr / **github-pr-context** / gitbutler / create-source) | ✅ git / gh / but 三种齐备;PR 协作上下文一条 GraphQL 取回 |
| 持久化 | `src/backend/db/`(schema / database / review-store) | ✅ better-sqlite3、迁移(V6)、七表 |
| 领域模型 | `src/shared/domain.ts` | ✅ 类型 + zod ingress schema |
| IPC 契约 | `src/shared/ipc.ts` + `src/preload.ts` + `src/backend/ipc/` | ✅ 查询/命令/事件推送 + dialog + `review:diff` + `review:open-in-browser` + `agent:list-models` |
| 结构化 diff | `src/shared/diff.ts` + `review_diffs` 表 | ✅ 后端预取落库、MCP 与 renderer 共用;add/del/modify/rename/binary |
| 前端屏 | `src/renderer/screens/`(EntryScreen + entry/ · ReviewScreen 三栏 · SubmitExportScreen · PromptRulesScreen · SettingsScreen · HistoryScreen · OnboardingScreen) | ✅ 七屏齐;全局 rail 导航 + review 底部状态栏已落地 |

## 端到端验证(headless spike)

`npm run spike:<name>`。`codex`/`review`/`source`/`discussion`/`resume` 真跑 codex(需 `codex login`、耗 token);其余确定性、不烧 token。

| spike | 验证 |
| --- | --- |
| `codex` | app-server 常驻会话 + MCP 注入 + report_finding 双向可见 + elicitation |
| `db` | 持久化读写 / 迁移(V3 model/effort · V4 notify)/ triage / update / 级联删 |
| `review` | ReviewSession 垂直:codex 扫描 → MCP → sqlite 落库 |
| `session-events` | ReviewSession 对外事件面(stub agent + 真实 MCP,不烧 token):finding 与其**承载 discussion** 成对外发 |
| `source` | LocalGitSource 取真实 git diff/文件 → codex → 落库;parsePrRef |
| `discussion` | 扫描后多轮追问 → user/agent 消息成对落库(同一 thread) |
| `resume` | session dispose 后按 threadId `thread/resume` 续接 → 复用会话记忆追问 |
| `gitbutler` | `but diff --format json` 重建 unified + 路径穿越防护 + 实仓 smoke |
| `mcp` | report_finding/update_finding 回写 store + bearer 令牌鉴权(无/错令牌 401) |
| `prompt` | 提示词分层解析/合并/注入:分节覆盖(project ▸ global ▸ builtin)+ 锁定段首尾夹住 + severity 逐档覆盖/旧格式迁移/自造分级不生效 + baseInstructions 组装 |
| `diff` | parseUnifiedDiff 对 add/del/modify/rename/binary/多 hunk 的结构与行号 + store 回环 |
| `write` | finding 写路径:setTriage/updateFinding 落库 + 外发 `finding` 事件 |
| `ui-state` | per-review UI 态:get/saveReviewUiState 往返(viewed + last_active_tab)+ 默认/upsert/降级/级联 |
| `promote` | discussion→finding 提升:锚点沿用 + 会话历史保留 + kind 翻转 + 守卫 |
| `export` | 导出 Markdown 生成:结构 + 开关 + 分组 + 全部剔除空态;纯函数 |
| `submit` | GitHub 提交:payload 组装 + submitReview 的 success/增量/invalid/failed/非 github 守卫 + 锚点预判 + 现拉最新 diff(不覆盖快照 / headMoved / 失败不抛) |
| `add-finding` | 手动新增 finding(origin=manual)+ 建承载 discussion + 同 triage 管线 |
| `notify` | 完成通知决策:偏好门控 + 扫描完成去重 + 追问回复 + 失焦/聚焦分派;纯函数 |
| `rerun` | 多轮复审:轮次落库/级联删 + 变更文件比对 + 复审 prompt 六类内容与外部数据围栏 + thread↔finding 匹配 + 去重命中/不误吞 + 表态回写与抑制计数 |

`npm start` 实机验证过:Electron 启动、`better-sqlite3` Electron ABI 加载、六表迁移、IPC 注册无崩溃。

## 与设计的偏差 / 决策记录

- **前端重写不移植 1.0**;source 层重新实现(未整体搬 1.0 SourceFlow)。
- **首轮机审自建**,不复用 codex 内置 `review/start`。
- **MCP SDK 用低阶 `Server` + 手写 JSON Schema**,规避 zod4 与高阶 tool API 的兼容不确定性。
- **finding id 回环**:report_finding 由 MCP 生成 id 回传,codex 侧 id 与存储 id 一致,update_finding 据此定位。
- **提示词分节覆盖**:project→global→builtin 每节独立取最高优先层;free 节整节替换(**节内追加已拍板不做**,winner-takes-all),structured 节(严重度)逐字段替换。
- **可配置口径 vs 锁定契约**:baseInstructions 里描述 MCP 工具契约的段落(角色与工具流程、`report_finding` 字段协议)**不进分层模型、不下发 renderer、设置页不可见** —— severity 枚举、category 规范集、`line` 锚新侧、`suggestion` 逐字套用都是被机械消费的,用户改写它们不是调口径而是让 finding 被 ingress 拒收或提交时补丁错位。锁定段首尾夹住用户内容(角色在前、协议在末),用户节里的冲突口径压不过末尾的协议。
- **严重度改为 structured 节**:`high/medium/low` 档位名锁死(= `z.enum(SEVERITIES)`),只开放每档的判定标准,逐档独立继承/覆盖。自造分级(P0/P1)解析不出档位即视为未覆盖,builtin 判定标准保留 —— 否则整节被替换掉,agent 会照着上报无效 severity 而 finding 静默丢失。旧的 `high = …;` / `med` 写法在解析层兼容迁移。
- **内置节定义与合并逻辑住在 `shared/prompt.ts`**:backend 与 preview fixture 复用同一份,不再各抄一份(此前 fixture 里的 builtin 文案已与后端漂移)。backend 只留 IO 与锁定段。
- **复审换新 thread**:一次 review 不再恒等于一个 codex thread —— 每轮机审各起一个,上一轮结论靠结构化 prompt 注入。原因是新旧 diff 的行号在同一上下文里会串位;副作用是追问不能再依赖会话记忆,故 `buildFollowupPrompt` 一并重述该线程近几条往来(顺带修好 compact 之后追问的老问题)。详见 [rerun](rerun.md)。
- **finding 去重从软约束升级为软+硬**:prompt 要求不重报之外,`shared/finding-dedupe.ts` 兜底吸收(同文件 + 邻近行 + 标题 bigram 相似度)。阈值取保守值 —— 宁可多出一条也不吞掉真问题。该兜底对首轮同样生效(agent 偶尔会重复上报同一处)。
- **复审表态是三态而非两态**:`resolve_finding` 除 `fixed` / `still_present` 外必须有 `wont_fix`(作者已回应说明不改)。实机踩过:作者在 PR 上回「纯联调,手动调试脚本,可忽略」后代码原样未变,只有两格时 agent 只能答 `still_present`,同一条每轮重报 —— 它没答错,是**我们问错了问题**。thread 回复一直都注入到了 prompt,缺的是**表达结论的词**与**要求它先读作者回复的指令**。判定顺序因此把「作者怎么说」排在「代码变没变」之前。`wont_fix` **不自动剔除**:作者一句"可忽略"不该自动关掉一条真实的安全问题,采纳与否是 reviewer 的决定(卡上给一键采纳,把作者原话存为剔除理由)。
- **`fixed` 反过来自动剔除**:复核判定已修复 = 代码里已经没有,不该继续占着待提交清单等人逐条手点。与 `wont_fix` 的差别是语义而非力度("问题没了" vs "作者说不改")。自动结案的条目不进去重黑名单 —— 同一处再被报出来算**回归**,恢复保留而非静默抑制;复审 prompt 里也因此与 reviewer 剔除项分节交代。判据 `isAutoClosedFixed` 收在 `shared/domain.ts`。
- **右栏 tab 持久化**:全局 `ui_settings.default_tab` 为「无记忆时的初始默认」,per-review `review_ui_state.last_active_tab` 覆盖。
- **领域事件面全程编译期收敛**:`ReviewSessionEvents` 是事件名→载荷的单一来源;ReviewSession **组合**(非继承)EventEmitter,`on/off` 收窄、`emit` 私有;ReviewManager 用 `keyof` 映射的转发表;renderer `useReviewStream` 用 `switch` + never 哨兵(运行时只告警不抛,容忍 main 比 renderer 新)。三处任一漏接新事件都编译失败 —— 起因是 agent finding 的承载 discussion 曾只落库未外发,整个 Discussion 栏为空却无人报错。
- codex 版本以 **0.144.1** 实测为准,**0.144.6 经 `generate-ts` 全量 diff 确认协议逐字节无变化**(详见 [codex-integration](codex-integration.md));协议子集手写在 `protocol.ts`。

## 后续可选项

七屏(entry / review / submit-export / prompt-rules / settings / history / onboarding)与应用外壳均已收口。剩下的是打磨项,见上「尚缺」——均不阻断核心 dogfood,按需再做。
