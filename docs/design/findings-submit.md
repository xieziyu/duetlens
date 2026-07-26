# Findings 筛选与提交

> 返回 [文档索引](../README.md)

从 1.0 保留的**核心价值流程**:agent 产出 findings 后,用户勾选保留有用的、剔除无用的、提交前编辑,最后提交为 GitHub PR review 评论。1.0 的三大痛点里有两个正是这条链路(checkbox 勾选 vs 手打 `R1,R3,R5-R7`;提交前编辑字段)。

**finding 现在是一条 discussion,但仍是一条可提交的记录 —— 对话是「打磨」它的地方,不是替代它。** 追问 → codex 回答 → 若结论改变该 finding,codex 经 MCP `update_finding` 回写字段,UI 标示「已依据本讨论更新」。对话本身作为历史保留,但**不提交**到 GitHub,只提交 finding 的定型字段。

## 只 review,不改代码

Duetlens 只做审阅,不替 author 改代码(codex 锁只读 sandbox)。因此**去掉「让 codex 给修法 / 应用修改」这类动作** —— 与追问重复,且不符合 review-only 定位。codex 至多产出一段 `suggestion`,作为 finding 的字段提给 author,提交时渲染为 GitHub suggestion 块(author 可在 GitHub 上一键采纳),Duetlens 侧不落地执行。

用户框选发起的 discussion 默认只是讨论;若讨论后认为值得作为正式意见提交,可**提升为 finding**(`origin: promoted`),锚点沿用、会话历史保留,随后进入与 agent finding 相同的 triage / 提交管线。

## 入口与流程(仅 `github-pr`)

diff-review 是工作面,submit 是终点步骤,靠**顶栏常驻主 CTA** 连接 —— 对标 GitHub PR 右上角的 "Finish your review"。diff 里每条 finding 卡片可就地剔除,边读边 triage,进提交屏时筛选已完成大半。

保留项组成**一次 GitHub PR review**:

- 有 `file:line` 锚点的 → **inline 行评论**(带 `suggestion` 的用 suggestion 块)。
- `file=null`(整体 / 架构类)的 → 并入 **review 摘要 body**,连同 codex 审核总结。
- 用户选 **event**:`Comment` / `Request changes` / `Approve`。
- **零 finding 也可提交** —— event 本身就是表态。仅照搬 GitHub 的硬约束:`Comment` / `Request changes` 至少要有 body 或一条行评论。

提交经 `gh` 完成(app 侧调用,不经 codex 工具),只读 sandbox 不影响。

## 原子提交:结果态由此推导

**PR review 是一次原子提交** —— GitHub 要么整份落地、要么整份失败,**没有「部分成功」**。所以结果只有三类:成功 / 整体失败(认证过期 / 网络 / PR 已关闭,未提交任何评论)/ **422 行锚点失效**。

**422 才是「部分不可提交」的真实形态**:某条 finding 的 `file:line` 已不在最新 diff 的新增侧,作为 inline 会让整份被拒。逐条处理(降级为摘要评论 / 改锚点到最近改动行 / 剔除此条)后整份重提,并给成批入口。

### 失效锚点靠「现拉最新 diff」定位

GitHub 的 422 只说整份被拒、**不告知是哪条**,得由我们自己指出来。判定依据必须是 **PR 此刻的 diff**,不能是审核时落库的那份快照 —— 恰恰是「快照已落后于 GitHub」才导致 422,照快照预判会**一条都找不出来**,用户面对一句「提交被拒」无从下手。

因此 submit 屏有一条独立于审核快照的**现拉**通路:

- **进屏即后台核对一次**(有 inline 锚点时),把失效锚点摆在提交**之前**;顶部状态条交代判定依据(核对结果 / PR 是否有新提交 / 拉取失败时降级为按快照预判)。
- **被 422 拒后自动重拉一次**并按最新 diff 重判。
- **定位不到时给退路**:拉取失败,或最新 diff 下仍无失效锚点(评论锚在 diff 之外),提供「把 N 条行评论全部并入摘要」—— 没有 inline 锚点的 review 不可能再被 422 拒。
- **文案不能用「当前 stale 数为 0」分岔** —— 用户把 N 条修完后它同样是 0,得记住**拒稿当下**定位到几条,否则会改口说「未能定位到失效锚点」。

**现拉刻意不写库**:审核时的 diff 快照是 findings 锚点与 diff 屏渲染的共同基准,推进它是**复审(rerun)**的职责;这里只借最新 diff 做一次判定与修锚。

## 增量提交与复核追评

一次 review 可多轮提交。已 `submitted` 的 finding 锁定不重发,上次提交后新增或改动的组成 delta,每次 submit = **追加一份新的 PR review**。

**唯一例外是复核追评,`submitted` 因此不是绝对终态。** 最常见的复审流是「首轮提交 → 作者改了一版 → 重跑复核仍存在」;若照「submitted 即锁定」办,这条复核结论只留在本地,author 永远收不到 —— 等于白复核。故上一轮已提交、本轮判 `still_present` 且 agent 给了说明的条目,回到待提交集,就同一处追发一条评论。

- **不重复追发**靠记录「提交发生在第几轮」,只有提交轮次 < 当前轮次才算欠一条;同一轮里连点两次不会发出两条一样的评论。
- **追评自报身份**(首行标明是第 N 轮复核追评、同一处此前已提过),否则 author 看到同一行冒出第二条评论,像重复上报。
- **仍可剔除**:追评项不是锁定态 —— 追不追这一条是 reviewer 的决定。
- 没给说明的 `still_present` 不追评:那条评论与上一轮一字不差,发出去只是噪音。

### 复核过的 finding:复核说明**取代**首轮正文

判定 `still_present` 的条目,提交 / 导出时正文**只发 agent 本轮的复核说明**。复核说明是看过作者这次改动之后写的(「改成了 RefCell,跨线程仍不安全」),首轮正文写在这次改动之前 —— 复核说明一旦存在,它描述的代码已经不在了,再附一段对不上代码的描述只会让 author 分辨哪句还算数。

代价是复核说明必须**自足**:这一点写进 `resolve_finding` 的 note 契约与复审指令,而非靠附上旧正文兜底。**曾把首轮正文降为背景小标题保留,已废** —— 那段东西恰恰是「已经被改掉」的部分。

**首轮 suggestion 同属首轮产物,一并作废。** 它和首轮正文同源、同样写在作者这次改动之前,而 `resolve_finding` 没有刷新它的入口。GitHub 的 ```suggestion 是一键应用的补丁:把改动前的写法挂到改动后的锚点上,轻则与复核说明互相打架,重则一键盖掉作者刚改的代码 —— 比一段对不上的描述更伤。要给新补丁的话,该做的是让复核结论自带 suggestion 并落库,而不是把旧的接着发。

口径与 review 屏一致:只有表态轮次 === 当前轮次才算本轮结论。`wont_fix` 不走这条 —— 那条说明是作者的原话,不是对问题的重新描述。

## 非 GitHub source:导出 Markdown

`local-branch` / `gitbutler-vbranch` 无 PR 可提交,顶栏 CTA 换成「导出 review」。同一条 triage 管线,终点从「提交到 GitHub」换成「生成一份 Markdown 报告」。

- **布局倒置**:导出屏以**报告本身为主场** —— 左侧宽栏是实时预览(渲染 / 源码可切),右侧窄栏是配置。对照 submit 屏的「左筛选 / 右 finish」。
- **包含项开关**(审核摘要 / 无锚点 finding 并入摘要 / suggestion 代码块 / 已剔除项)与分组(按严重度 | 按文件)**实时改写预览与将导出的内容**,所见即所得 —— Markdown 由数据模型实时生成,保证预览 = 复制 = 保存。
- **无 event 选择**:`Comment / Request changes / Approve` 是 GitHub review 概念,导出屏不涉及。
- 保存经 Electron 原生保存对话框写本地文件。
