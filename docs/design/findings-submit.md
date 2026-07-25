# Findings 筛选与提交到 GitHub

> 返回 [文档索引](../README.md)

这是从 1.0 保留的**核心价值流程**:agent 产出 findings 后,用户**勾选保留有用的、剔除无用的、提交前编辑**,最后**提交为 GitHub PR review 评论**。1.0 的三大痛点里有两个正是这条链路(checkbox 勾选 vs 手打 `R1,R3,R5-R7`;提交前编辑 severity/title/body/suggestion)。2.0 保留此能力,并与对话式模型融合。

## 与对话式模型的关系

**finding 现在是一条 discussion,但仍是一条可提交的记录 —— 对话是"打磨"它的地方,不是替代它。** 用户在 discussion 里追问、让 codex 澄清后,agent 可经 MCP `update_finding` 回写更准的 body/severity/suggestion;这条打磨过的记录才是最终提交到 GitHub 的内容。**追问的反馈闭环**:追问 → codex 回答 → 若结论改变该 finding,codex 调 `update_finding` 回写字段,UI 以系统提示("已依据本讨论更新此 finding")标示;对话本身作为历史保留,但**不提交**到 GitHub,只提交 finding 的定型字段。

## 定位:只 review,不改代码

Duetlens 只做审阅,**不替 author 改代码**(codex 锁只读 sandbox)。因此:

- 去掉"让 codex 给修法/应用修改"这类动作 —— 与"追问"重复,且不符合 review-only 定位。保留 **追问**。
- codex 至多产出一段 **suggestion(建议代码)**,作为 finding 的字段**提给 author**;提交时渲染为 **GitHub suggestion 块**(author 可在 GitHub 上一键采纳),Duetlens 侧不落地执行。

## 从 discussion 提升为 finding

用户框选代码发起的 discussion 默认只是讨论。若讨论后认为值得作为正式意见提交给 author,用 **「转为 finding」** 把它提升为一条 finding(`source: promoted`),补/由 codex 起草 severity/title/body,随后进入与 agent finding 相同的 triage/提交管线。这对应 1.0 的 manual findings(同 schema、同提交路径)。

## finding 生命周期

每条 finding 带两组独立状态:

- **triage**:`open` →(用户裁决)`keep` / `dismiss`
- **submission**:`unsubmitted` → `submitted`(记录 GitHub 评论/review 链接)

可编辑字段(提交前):`severity` / `title` / `body` / `suggestion`。`category` 与 `file:line` 由 agent 定(沿用 1.0)。手动新增的 finding 与 agent finding **同 schema、同提交路径**(带 `source: agent | manual`)。

## 入口(从 diff-review 进入)

diff-review 是工作面,submit 是终点步骤,靠**顶栏常驻主 CTA「提交 review」**(github-pr source 才显示,带 findings 数徽标)连接 —— 对标 GitHub PR 右上角的 "Finish your review"。此外 diff 里每条 finding 卡片可**就地「剔除」**(默认保留),边读边 triage,进提交屏时筛选已完成大半。submit 屏提供「← 返回 diff」回到工作面。

## 提交流程(仅 `github-pr` source)

1. 点顶栏「提交 review」进入 submit 屏,逐条 triage:勾选保留、剔除无用、就地编辑或回到 discussion 打磨。
2. "Submit review" 把保留项组成 **一次 GitHub PR review**:
   - 有 `file:line` 锚点的 → **inline 行评论**(带 `suggestion` 的用 GitHub suggestion 块)。
   - `file=null`(整体/架构类)的 → 并入 **review 摘要 body**,连同 codex 审核总结。
   - 用户选 **event**:`Comment` / `Request changes` / `Approve`。
   - **零 finding 也可提交**:event 本身就是表态(如干净通过直接 `Approve`)。仅 GitHub 的硬约束照搬 —— `Comment` / `Request changes` 至少要有 review body 或一条行评论,否则按钮禁用并给出原因。
3. 经 `gh` 提交(`gh api` / `gh pr review`);只读 sandbox 不影响提交(提交是 app 侧用 gh,不经 codex 工具)。
4. 提交后 finding 标 `submitted`(passive 标注,沿用 1.0 「不做 unsubmitted-changes 徽标」的约定)。

## 复核过的 finding:复核说明作正文主体

重跑后被判定 `still_present` 的条目,提交到 GitHub / 导出报告时**正文主体是 agent 本轮的复核说明**,首轮正文降为背景(GitHub 评论里作 `<sub>首次报出时的说明</sub>` 小标题,导出报告里作粗体小标题)。复核说明是看过作者这次改动之后写的("改成了 RefCell,跨线程仍不安全"),首轮正文是改动之前写的 —— 把旧的摆在前面,author 读到的是一段已经对不上代码的描述。首轮正文仍带上:只说"仍不安全"而不交代问题本身,author 无从下手。

口径与 review 屏一致:只有**表态轮次 === 当前轮次**才算本轮结论(见 `recheckNote()`),上一轮的旧表态不顶正文。`wont_fix` 不走这条 —— 那条说明是作者的原话,不是对问题的重新描述。

## 提交结果与异常态(原子提交 · 增量)

演示见 `mockup/submit-to-github.html` 顶栏「提交态」切换器(ready / submitting / success / invalid / failed / incremental)。

**PR review 是一次原子提交。** Duetlens 用一次 `gh api …/pulls/{n}/reviews`(review body + event + 全部 inline `comments[]`)提交;GitHub 要么整份落地、要么整份失败 —— **没有"部分成功"**。据此设计结果态:

- **submitting**:提交中,按钮转圈禁用。
- **success**:绿 banner「review 已提交 · #NNN · <event>」+「在 GitHub 查看 ↗」;保留项转 `submitted`(passive 绿条锁定、不可再改),foot 换「完成 · 返回 diff」。
- **invalid(422 · 行锚点失效)**:某条 finding 的 `file:line` 已不在最新 diff 的新增侧(base 更新 / 行移位),作为 inline 会让整份 review 被 GitHub 拒。这才是"部分不可提交"的真实形态(而非事后的部分成功)。红 banner + 该条**红框恢复**:**降级为摘要评论 / 改锚点到最近改动行 / 剔除此条**;处理后整份重提。**定位靠现拉,不靠快照** —— 见下。
- **failed(整体)**:`gh` 认证过期 / 网络中断 / PR 已合并关闭 —— 未提交任何评论,红 banner + 原因 + 重试;findings 保持未提交。

### 失效锚点靠「现拉最新 diff」定位

GitHub 的 422 只说整份被拒,**不告知是哪条**,得由我们自己指出来。判定依据必须是 **PR 此刻的 diff**,不能是审核时落库的那份快照 —— 恰恰是"快照已落后于 GitHub"才导致 422,照快照预判会一条都找不出来,用户面对一句"提交被拒"无从下手。

因此 submit 屏有一条独立于审核快照的**现拉**通路(`review.latestDiff` → `ReviewManager.getLatestDiff`,不写库):

- **进屏即后台核对一次**(有 inline 锚点时),把失效锚点摆在提交**之前**,而不是等被拒才知道;顶部状态条交代判定依据(核对结果 / PR 是否有新提交 / 拉取失败时降级为按快照预判)。
- **被 422 拒后自动重拉一次**并按最新 diff 重判,banner 直接说"定位到 N 条(左侧红框)"。
- 逐条修法之外给**成批**入口:全部改锚到最近改动行 / 全部降级为摘要评论。
- **定位不到时给退路**:拉取失败,或最新 diff 下仍无失效锚点(评论锚在 diff 之外),提供"把 N 条行评论全部并入摘要" —— 没有 inline 锚点的 review 不可能再被 422 拒。

**不写库是刻意的**:审核时的 diff 快照是 findings 锚点与 diff 屏渲染的共同基准,推进它是**复审(rerun)**的职责;这里只借最新 diff 做一次判定与修锚。

**增量提交(二次)**:一次 review 可多轮提交。已 `submitted` 的 finding **锁定不重发**;上次提交后新增或改动的 finding 组成 **delta**,再进 submit 屏只提交 delta,每次 submit = **追加一份新的 PR review**(info banner 标「上次已提交 N 条,本次 M 条新增」)。这与 finding 的 `submission` 状态(见上「finding 生命周期」)一致 —— submitted 是终态、只读。

## 非 GitHub source — 导出为 Markdown

`local-branch` / `gitbutler-vbranch` 无 PR 可提交 → GitHub 提交动作不可用,顶栏 CTA 换成 **「导出 review」**,进入**本地 Markdown 导出屏**(`mockup/export-markdown.html`)。同一条 triage 管线(勾选保留 / 剔除),终点从"提交到 GitHub"换成"生成一份 Markdown 报告"。

- **布局倒置**:导出屏以**报告本身为主场** —— 左侧宽栏是实时 Markdown 预览(`渲染 / 源码` 可切),右侧窄栏是导出配置。对照 GitHub submit 屏"左筛选 / 右 finish"的主次关系,导出屏是"左预览 / 右配置"。
- **报告结构**:标题(分支名)+ 元信息 blockquote(来源 / 日期 / codex 模型)+ `## 摘要`(codex 总结)+ `## Findings`(保留项,按严重度或按文件分组)。有 `suggestion` 的渲染为 ```` ```suggestion ```` fenced block(在 GitHub 之外无"一键采纳",但保留可读格式)。
- **包含项开关**:审核摘要 / 无锚点 finding 并入摘要 / suggestion 代码块 / 已剔除项(默认关,开则以删除线列出);分组 `按严重度 | 按文件`。开关实时改写预览与将导出的内容,所见即所得。
- **无 event 选择**:`Comment / Request changes / Approve` 是 GitHub review 概念,导出屏不涉及。
- **动作**:`复制 Markdown`(剪贴板)+ `保存为 .md`。**应用内**"保存"经 Electron 原生保存对话框(`dialog.showSaveDialog`)写本地文件;mockup 里以浏览器下载/剪贴板作预览替身。

## UI

- **GitHub 提交屏** `mockup/submit-to-github.html`:左侧 findings 筛选列表(勾选/剔除/编辑,dismissed 项灰显可恢复,`file=null` 单独归入摘要),右侧 "Finish your review"(摘要 body + event 选择 + 提交按钮)。
- **本地导出屏** `mockup/export-markdown.html`:左侧实时 Markdown 预览(渲染/源码切换),右侧导出配置(包含项开关 + 分组 + findings 勾选保留 + 复制/保存)。Markdown 由 findings 数据模型实时生成,保证预览与复制/保存内容一致。

两屏设计语言与 [ui.md](ui.md) 一致(duet 双声道、两轴配色,tokens 单一来源 `src/renderer/theme/tokens.css`)。
