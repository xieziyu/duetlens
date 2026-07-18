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
3. 经 `gh` 提交(`gh api` / `gh pr review`);只读 sandbox 不影响提交(提交是 app 侧用 gh,不经 codex 工具)。
4. 提交后 finding 标 `submitted`(passive 标注,沿用 1.0 「不做 unsubmitted-changes 徽标」的约定)。

## 非 GitHub source

`local-branch` / `gitbutler-vbranch` 无 PR 可提交 → 提交动作不可用,退化为**本地导出**(markdown 汇总)。**[deferred]** 先只做 GitHub 提交,导出后续再补。

## UI

见 mockup `mockup/submit-to-github.html`:左侧 findings 筛选列表(勾选/剔除/编辑,dismissed 项灰显可恢复,`file=null` 单独归入摘要),右侧 "Finish your review"(摘要 body + event 选择 + 提交按钮)。设计语言与 [ui.md](ui.md) 一致(duet 双声道、两轴配色)。
