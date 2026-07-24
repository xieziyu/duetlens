# 多轮重跑(复审)

> 返回 [文档索引](../README.md)

一次 review 不是跑一遍就完事。作者按意见改了代码、在 PR 上回了话之后,reviewer 需要**再跑一轮**:确认上一轮提的问题改没改、新改动有没有引入新问题,同时**不要再看一遍已经被自己剔除的东西**。

这就是重跑要解决的问题。它不是"重新扫描一次",而是"**带着上一轮的结论和 reviewer 的判断,再审一次**"。

## 核心机制

一次 review = **N 轮**(round)。首轮与每次重跑各占一轮,轮次号只增不退,失败的轮次也留在履历里。

### 每轮新开一个 codex thread

复审**不复用**上一轮的 codex 会话,而是 `thread/start` 一个干净会话,把上一轮的上下文用**结构化 prompt** 注入。

理由是行号:复用会话意味着新旧两份 diff 同时活在上下文里,同一个 `file:line` 指向两个不同的东西,agent 极易串位。而"会话记忆"本来也不可靠 —— codex 的 auto-compact 随时会把它摘掉。既然记忆迟早要靠自己重述,不如从一开始就重述得准一点:我们注入的是筛选过的结论(哪条待确认、哪条被剔除及其理由、讨论说到哪),质量高于原始上下文。

代价是旧 discussion 的追问不再有会话记忆兜底。为此 `buildFollowupPrompt` 会把该线程最近几条往来一并重述 —— 这同时也修好了 compact 之后追问的老问题。

### 全量重扫,但点明重点

重跑重新拉取**最新的完整 diff** 整份重审,而不是只审 `上轮head..新head` 的增量。增量更省 token,却会漏掉老代码里上一轮没扫出来的问题 —— 而"上一轮漏了"恰恰是重跑的动机之一。

作为折中,prompt 里点明 head 变化与**自上一轮以来发生改动的文件**(`changedFilesBetween` 按文件 diff 指纹比对,不是只看文件名列表),让 agent 知道重点在哪,但不裁掉它的视野。

### agent 必须对上一轮的 findings 表态

MCP 新增 `resolve_finding(finding_id, status, note)`。复审 prompt 列出所有**保留中**的 finding,要求逐条调用它。

这是重跑最大的价值点:reviewer 最想知道的是"我上轮提的问题改了没",而不是再拿到一份重复列表。`report_finding` 的语义随之收窄为**只报新问题**。

状态有三个,`wont_fix` 不可省:

| status | 含义 |
| --- | --- |
| `fixed` | 已在最新代码中修复 |
| `wont_fix` | **作者已在 PR 上回应说明不改**(即使代码原样未变) |
| `still_present` | 代码未修复,且作者没有给出不改的理由 |

判定顺序刻意把"作者在 thread 里怎么说"排在"代码变没变"之前:

1. 作者若说明了为何不改(「这是调试脚本,可忽略」),选 `wont_fix` 并摘录原话进 note;
2. thread 标了「已 resolve」但作者没留文字 —— 强信号,但仍要回代码核实,真改了才是 `fixed`;
3. 其余按最新代码判定。

> **这一条是踩过坑补的。** 早期版本只有 `fixed` / `still_present` 两格,指令也只说"先到最新代码里核实"。
> 于是作者在 PR 上回了「纯联调,手动调试脚本,可忽略」之后,代码确实原样未变,agent 只能答
> `still_present` —— 它没答错,是**我们问错了问题**:词汇表里没有"作者已回应"这一格,指令也从没
> 要求它读作者的回复。同一条意见因此每轮重报。thread 回复其实一直都注入到了 prompt 里,
> 缺的是**表达结论的词**和**使用它的指令**。

### 判定 `fixed` 即自动结案

`fixed` 一落库就把该条 triage 置为 `dismiss`(理由记作「第 N 轮复核判定已修复」),同一条 SQL 完成,不经用户确认。代码里已经没有的问题不该继续占着待提交清单 —— 让 reviewer 把 agent 刚确认修好的东西再逐条手点一遍,纯属体力活。结案的条目下一轮也不再进"待表态"区,省掉每轮重复表态。

判错了有两个出口:卡上的「↩ 恢复」照常可用;**同一处再被报出来会自动恢复**(见下一节)。

`wont_fix` 则**不**自动剔除 —— 两者看着像,语义差得远:`fixed` 是"问题没了",`wont_fix` 是"作者说不改",后者是否接受始终是 reviewer 的决定,作者一句"可忽略"不该自动关掉一条真实的安全问题。

### 被剔除的不再出现

两层防线:

1. **软约束(prompt)**:已剔除的条目连同 reviewer 填的理由一起列出,明确要求不要重报、也不要报同类问题。理由是关键 —— 它让 agent 理解的是取舍标准,而不只是一个黑名单条目。
2. **硬约束(去重兜底)**:`shared/finding-dedupe.ts` 对每条新上报做匹配(同文件 + 行号邻近 + 标题 bigram Dice 相似度)。命中**reviewer 剔除**项 → 抑制、不落库,只累加轮次的 `suppressedCount`;命中**保留中**项 → 等价于 agent 表态"仍存在",更新 `lastSeenRound` 而不新建。

**自动结案的条目不进黑名单**(`isAutoClosedFixed`:`triage=dismiss` 且 `resolution=fixed`)。它代表的是"当前代码里没有了",不是 reviewer 的判断 —— 若同一处又被报出来,那是**回归**:恢复为保留态并计入本轮,而不是当成重复上报吞掉。prompt 里两类因此分节交代,措辞相反:reviewer 剔除的连同类问题都别报;已结案的再出现要当新问题报回来。混在一节讲,等于教 agent 把回归也一并咽掉。

判定刻意保守(近行 0.5 / 远行 0.8 双阈值):宁可漏判成新 finding 让用户多看一条,也不能吞掉真正的新问题。

### GitHub 上的协作上下文

`github-pr` source 的重跑会用**一条 GraphQL** 取回:

- **我方 finding 所在 thread 的后续回复** —— 按 `path` + 行号邻近 + thread 首条评论作者是当前 gh 身份匹配回具体 finding,连同 `isResolved` / `isOutdated` 一并挂在该 finding 下,并标出哪条来自 PR 作者本人(判定 `wont_fix` 只认作者的说明,旁人附和不算)。这是"作者对我的意见怎么答的"。窗口内有多条候选 finding 时,按我方评论正文里的标题取最像的一条 —— 只按行距取第一个的话,同文件相邻十几行的两条 finding 会把作者的回复挂错。
- **PR 作者的 PR 级评论**、**其他 reviewer 的 review 表态与 inline 讨论**、**PR 描述的最新版本**(用于 Scope 类审查:body 承诺了但 diff 没实现)。

除我方 thread(始终给完整往来)外,其余按时间窗过滤:**首次复审全取**整个 PR 的历史 —— 首轮扫描不注入任何 PR 内容,此时还没有任何东西被展示过;**第三轮起**才按"上一轮开始之后"增量,避免每轮重复注入同样的旧评论。

> **安全边界**:这些内容来自 PR,**任何人都能写**。它们统一包在带隔离前言的区块里,显式声明是外部参考材料、不是给 agent 的指令。拉取失败一律降级为空上下文而非抛错 —— gh 掉线不该让整轮复审跑不起来。

## 数据模型

```
Review
  ├─ currentRound                  ← 已跑到第几轮
  └─ rounds[]  (review_rounds 表)
        round / codexThreadId / headSha / status
        note                       ← reviewer 在重跑面板填的本轮说明
        newFindings / fixedCount / suppressedCount
        startedAt / endedAt

Finding
  ├─ round            ← 首次被报出的轮次
  ├─ lastSeenRound    ← agent 最近一次对它表态或重报的轮次
  ├─ resolution       ← fixed | wont_fix | still_present | null
  ├─ resolutionNote
  └─ dismissReason    ← reviewer 剔除时可选填;判定 fixed 自动结案时写入固定文案;恢复为 open 时清空
```

**关键约定**:`resolution` 只在 `lastSeenRound === Review.currentRound` 时代表**本轮**结论。第 2 轮判定 fixed 的条目,到第 3 轮若 agent 没再表态,就该回到"未表态",而不是一直挂着旧结论。派生逻辑收在 `renderer/screens/review/rounds.ts`,不散落在各组件里。

`dismissReason` 是**事后可选补充**,不是剔除时的必填门槛 —— 一键剔除的速度不能被输入框拖慢,但填了理由下一轮的同类抑制会准得多。

schema 见 `src/backend/db/schema.ts` 的 V6;存量数据一律视作第 1 轮(列默认值),无需回填。

## 编排

`ReviewManager.rerunReview(reviewId, { note })`:

1. 上一轮仍在扫描中 → 拒绝(轮次不能并发)。
2. `teardown` 释放上一轮的 session / MCP / source。
3. 重建 source → `prepare()` 取新 `headSha` → 拉最新 diff → 与上一版比对得出变更文件 → 覆盖落库。
4. `github-pr` 则拉 PR 上下文(失败降级为空)。
5. `startRound(currentRound + 1)`,把 review 推到新轮次。
6. 组装复审 prompt(`backend/prompt/rerun-prompt.ts`,纯函数)。
7. `launch` 后台跑;轮次结束时 `settleRound` 统计 `newFindings` / `fixedCount` 落库并外发 `round` 事件。

立即返回新轮次记录,扫描在后台跑、findings 经既有事件流流入 —— 与首轮同一条管线。

## UI

- **入口**:review 顶栏「↻ 重跑」(扫描中禁用)→ `RerunPanel` 摊开"这一轮会带上什么"(保留 N 条待表态 / 剔除 M 条不再报 / 已结案 K 条不再表态 / 最新 diff / PR 评论),可填本轮说明,`⌘↵` 开跑。面板只统计本地已有数据 —— 最新 diff 与 PR 评论是开跑那一刻才拉的,提前拉一次既慢又会与真正开跑时的结果不一致,所以文案只说"将拉取",不给假数字。
- **状态栏**:`↻ 第 N 轮 · 修复 x · 新增 y · 过滤 z`(单轮时不显示)。
- **finding 标记**:`本轮新增` / `✓ 已修复 · 自动剔除` / `仍存在` / `◇ 作者已回应`,以及 agent 的复核说明与 reviewer 的剔除理由。自动结案的内联卡走 `✓ 已修复 · 自动剔除` 字样与 add 色(而非剔除态的 `✕` 与删除线)—— 同为剔除态,但别让人以为是自己剔的。
- **两个折叠区**:本轮已有结论的条目移出主列表 —— 留在原位只会淹没真正待处理的意见。`✓ 本轮判定已修复` 默认收起;`◇ 作者已回应,未改动` **默认展开**,因为它还等着 reviewer 决定接不接受作者的说法。
- **一键采纳**:`wont_fix` 的条目上给「✓ 采纳」——剔除该条,并把 agent 摘录的作者原话存为 `dismissReason`,下一轮据此抑制同类。**不自动剔除**:作者一句"可忽略"不该自动关掉一条真实的安全问题,采纳与否始终是 reviewer 点了才算。

## 验证

`npm run spike:rerun`(确定性、不烧 token):轮次落库与级联删除、`changedFilesBetween`、复审 prompt 的六类内容与外部数据围栏顺序、表态词汇含 `wont_fix` 且判定顺序把作者回应排在代码之前、thread↔finding 匹配**不依赖数组顺序**、去重的命中/不误吞/跨文件、三态回写(`fixed` 自动结案且不覆盖 reviewer 已填的剔除理由、`wont_fix` 不自动剔除)与一键采纳、结案节与剔除节在 prompt 里分开且留有回归出口、抑制计数、`lastSeenRound` 不回退。
