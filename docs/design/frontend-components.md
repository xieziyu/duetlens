# 前端组件层与 UI 状态持久化

> 返回 [文档索引](../README.md)
>
> 状态:**已落地**。组件树、状态分层与持久化均已实现于 `src/renderer/`;本篇是结构索引,**细节与视觉均以代码为准**。

前端为 **React SPA**,承载于 Electron renderer(见 [architecture](architecture.md))。本篇定三件事:组件如何拆、状态放哪层、哪些状态要持久化。视觉 tokens 的单一来源是 `src/renderer/theme/tokens.css`;组件承载的状态机见 [ui-states](ui-states.md)。

## 组件树

以三个顶层屏为根,复用 [design-system](design-system.md) 组件清单里的命名。叶子标注对应 mockup class,便于对照迁移。

```
<App>                                      主题两轴 data-mode × data-theme 挂根节点
│                                          外壳网格 top / rail+host / foot;屏根用 display:contents 落进网格
├─ <AppRail>                               全局导航 rail(除 onboarding 外各屏共用)
│                                          入口 · 当前审核 · 历史 · 审核规则 ▸ 明暗 · 设置
├─ <EntryScreen>                           mockup/entry.html
│  ├─ <Hero>
│  ├─ <StartReviewCard>                    发起卡片
│  │  ├─ <SourceSegmented>                 GitHub PR / 本地分支 / GitButler
│  │  ├─ <PrInput> / <RepoPathField>       粘贴即解析 · 可选本地仓库路径
│  │  ├─ <RecentOpenPrList>                从 open PR 选择 · 默认折叠,展开才拉
│  │  ├─ <ExtraContext>                    可折叠附加上下文 textarea
│  │  └─ <StartButton>                     单一「开始审核」CTA
│  └─ <RecentReviews>                      最近的审核 (点击=恢复会话)
│
├─ <ReviewScreen>                          mockup/diff-review.html
│  ├─ <TopBar>                             .rev-topbar 只留上下文
│  │  ├─ <SourceChip>                      来源图标 + #PR/分支 + ⧉ 打开 PR 网页
│  │  └─ <SubmitCta>                       提交 review / 导出报告 (随 source)
│  ├─ <ScanProgressBar>                    .scanbar 横跨三栏 (scan 期);点开向下展开竖排 .timeline
│  ├─ <FileTree>                           .tree
│  │  └─ <FileRow>                         .file (.badge finding 徽标 · .vtick viewed)
│  ├─ <DiffPane>                           左侧主场
│  │  ├─ <OffDiffBanner>                   .offdiff 非改动行锚点 finding 集合
│  │  ├─ <DiffFile>                        .diff (per-file, 可折叠)
│  │  │  ├─ <DiffHeader>                   两行:文件名+状态 / 目录路径;右侧 ⚑ +− ✓ ⌄
│  │  │  ├─ <CodeTable variant>            .code.unified | .code.split
│  │  │  ├─ <Expander>                     展开未改动代码
│  │  │  ├─ <InlineCard>                   .card.agent | .card.human (view/edit/submitted/dismissed)
│  │  │  │  ├─ <FindingEditor>             .c-edit (sev/cat/标题/正文/suggestion)
│  │  │  │  └─ <DiscussionComposer>        追问 + @file + 引用选区
│  │  │  └─ <SelectionPopover>             .sel-pop 框选发起 discussion / 追问
│  │  └─ …
│  ├─ <RightPanel>                         .tabs 三 tab 互斥
│  │  ├─ <DiscussionTab>                   讨论线程 + <Composer>
│  │  ├─ <FindingsTab>                     运行时 triage 列表 (.frow 分组 + tally)
│  │  └─ <SummaryTab>                      结论卡 + 统计 + <SummaryEditor> 可编辑正文
│  └─ <ReviewStatusBar>                    .rev-statusbar 底部整幅
│     ├─ 状态胶囊 · codex/模型 · effort · ctx 环+token · 最近工具调用
│     └─ 通读进度 · <ViewSegmented> unified/split · ⌘ → <KbdHelpOverlay>
│
├─ <SubmitGitHubScreen>                    mockup/submit-to-github.html (source=github-pr)
└─ <ExportMarkdownScreen>                  mockup/export-markdown.html (source=local/vbranch)
   ├─ <MarkdownPreview>                     渲染 / 源码切
   └─ <ExportConfig>                        包含项开关 · 分组 · findings 勾选
```

`<InlineCard>` 与 `<SelectionPopover>` / `<Composer>` 是复用度最高的三块,应优先抽成独立组件并配单元测试;它们在 unified / split 两视图共享同一实例(见 ui-states「diff 视图」)。

## 状态分层

三层,来源与生命周期不同,不要混在一处 store:

| 层 | 是什么 | 来源 | 生命周期 |
| --- | --- | --- | --- |
| **Server state** | review / discussions / findings / messages / summary / diff | Node 后端(sqlite)+ codex 事件流,经 Electron IPC(`ipcRenderer.invoke` 拉取、`webContents.send` 推送)| 权威数据,后端持久化 |
| **Persisted UI state** | 栏宽 / viewed / 上次 tab / 主题两轴 / diff 视图偏好 | 见下「持久化」 | 跨会话保留,但非业务数据 |
| **Ephemeral UI state** | 卡片 edit 中的草稿、popover 显隐、hover、菜单开合 | 组件本地 `useState` | 随组件卸载即弃 |

**Server state** 的写路径始终经后端命令(如 `keep_finding` / `update_finding` / `post_discussion`),前端不本地臆造权威数据;后端落库并回推事件,前端据事件更新视图 —— 这样多处视图(diff 内联卡 ↔ Findings tab ↔ Summary)天然一致,不需前端手动同步。finding 的就地编辑保存走 `update_finding`,与 codex 经 MCP 的回写是**同一后端字段**的两个写入方,后端负责串行化(见 [data-model](data-model.md))。

### 数据流

```
codex app-server ──JSON-RPC──▶ Node (ConversationalAgent)
                                  │  ▲
                     MCP 工具调用  │  │ report_finding / update_finding
                                  ▼  │
      Node 后端 (sqlite) ◀────────────┘
        │  ▲
 IPC    │  │ ipcRenderer.invoke (query / command)
 send   ▼  │
      React (server-state store)
        │
        ▼  props / context
      组件树
```

agent 侧的 event / approval 不直接渗入 UI:`ConversationalAgent` 薄封装后,后端把 turn 事件、`report_finding` 等归一成 Duetlens 领域事件再经 IPC 推给前端(对照 [architecture](architecture.md) 抽象层)。

**这条链路上的事件面全程编译期收敛**,三处缺一即报错:`ReviewSessionEvents`(事件名→载荷的单一来源,ReviewSession 组合 EventEmitter、`emit` 私有)→ ReviewManager 的 `keyof` 映射转发表 → renderer `useReviewStream` 的 `switch` + never 哨兵。新增一种领域事件时三处都要动。之所以这么收:agent finding 的**承载 discussion** 曾只落库、未随事件外发,Discussion 栏整栏为空而无任何报错。

## UI 状态持久化

只持久化上表 **Persisted UI state**。核心问题是**粒度**(跟人还是跟这次 review)与**存哪**(后端 sqlite 还是 renderer 本地),按下表定:

| 状态 | 粒度 | 存储 | 理由 |
| --- | --- | --- | --- |
| 主题 `data-mode` / `data-theme` | per-user(全局) | 后端 settings 表 | 用户级偏好,应用启动即需要,跨 review 一致 |
| 栏宽 `--left-w` / `--right-w` | per-user(全局) | 后端 settings 表 | 布局习惯不随 PR 变 |
| 上次右栏 tab / diff 视图(unified/split) | per-user(默认)| 后端 settings 表 | 作为默认偏好;单次覆盖属 ephemeral |
| **per-file viewed** | **per-review** | 后端(挂 review) | 属这次审核的进度,换 PR 应清零;需与「N 改动 · M 已看」一致 |
| diff 折叠 / off-diff banner 展开 | ephemeral | 不持久化 | 纯视图态,重开恢复默认无碍 |
| 卡片 edit 草稿 | ephemeral | 不持久化(可选后端 draft) | 未保存的编辑;若要防丢可另存 draft,非本期必须 |

**存储位置原则**:凡属**领域进度**(viewed 是这次 review 的一部分)一律进后端 sqlite,与 discussions/findings 同库、随会话历史恢复 —— 这样「打开最近的审核」能连同看过哪些文件一起还原。纯**设备级外观偏好**(主题、栏宽)也放后端 settings 表以求单一来源;不用 renderer `localStorage`,避免多窗口 / 清缓存导致的漂移,也免去两套读写路径。

### schema 草图

跟人的偏好一张表,跟 review 的进度挂 review。字段最终随骨架期定稿(见 [open-questions](open-questions.md)「持久化 schema」),此处只定形状:

```
ui_settings (per-user, 单行或 kv)
  data_mode        text     -- light | dark
  data_theme       text     -- duetlens | github
  left_width       integer
  right_width      integer
  default_tab      text     -- discussion | findings | summary
  default_diff_view text    -- unified | split

review_ui_state (per-review, 挂 review_id)
  review_id        text  fk
  viewed_files     text     -- 已看文件路径集合 (json / 关联表)
  last_active_tab  text     -- 本次 review 覆盖 default_tab (可空)
```

`viewed_files` 是否升为独立关联表,取决于是否要按文件记时间戳 / 顺序;初版可先 json 集合。

## 实现顺序(已按此走完,存档)

1. 落 tokens 为 React 主题层(两轴挂根节点,现为 `src/renderer/theme/tokens.css`),先跑通 `<App>` 骨架 + 主题切换。
2. 抽三块高复用组件:`<InlineCard>`(四态)、`<SelectionPopover>`、`<Composer>`,配状态机([ui-states](ui-states.md))与单测。
3. 接 server-state store + Electron IPC,先渲染只读 diff + findings。
4. 补写路径命令(triage / edit / discussion)与 UI 持久化两张表。

## 关联索引

- 组件承载的状态机:[ui-states.md](ui-states.md)
- tokens 与组件清单:[design-system.md](design-system.md)
- 后端分层 / 前端选型:[architecture.md](architecture.md)
- 持久化 schema 待决项:[open-questions.md](open-questions.md)
