# 数据模型

> 返回 [文档索引](../README.md)
>
> 字段级 schema 以代码为准:领域类型与 zod ingress schema 在 `src/shared/domain.ts`,建表与迁移在 `src/backend/db/schema.ts`,读写在 `ReviewStore`。

```
Review (一次审核会话)
  ├─ rounds[]                    ← 首轮 + 每次重跑各一轮(见 rerun.md)
  │     └─ 每轮 1 个 codex thread
  ├─ source (github-pr | local-branch | gitbutler-vbranch)
  ├─ diff / 源码树               ← 每轮重跑时刷新为最新
  └─ discussions[]               ← 挂在代码锚点上的对话线程(跨轮次存活)
        ├─ finding-discussion     (agent 经 MCP report_finding 上报的一类特殊 discussion)
        └─ user-discussion        (用户在 diff 上批注发起的讨论)
```

**一轮一个 codex thread,轮内全局视野。** 同一轮内所有 discussion 的追问都在这个会话里通过引用锚点进行,而不是每个 discussion 各开一个 thread —— 让 agent 始终握有整个 PR 的全局上下文,同时省 token(不必给每个 discussion 重复喂 diff)。**跨轮换新会话**,理由见 [rerun](rerun.md)。若某个讨论确需隔离上下文,codex 原生的 `thread/fork` 是已知备选,默认不用。

**findings 经 MCP 工具回传,不再 watch 文件。** app 向 codex 暴露 `report_finding` / `update_finding` / `resolve_finding` / `get_file` / `get_diff`,agent 实时、结构化地上报,并可在对话中随时修正。这取代了 1.0 用 chokidar 盯 `findings.json` 的做法 —— 数据实时、有明确 schema、天然契合多轮对话。

**总结同样走 MCP 回传,不从回复文本里捞。** agent 收尾调 `write_summary` 写下总结正文与重点关注文件。重点文件要被机械消费(点击跳到 diff 对应文件),从自由文本里解析出来的东西担不起这个;正文与它同一次产出,一并走工具。总结每轮**整份重写**而非追加 —— 上一轮的重点挂在新一轮的结论上只会误导。

**总结只读,且不外发。** 它是 agent 给 reviewer 的判断材料,不是 reviewer 的产出:故 Summary 屏不开编辑入口,提交到 GitHub 的 review 意见由 reviewer 在提交屏手填(不填即空、也不落库 —— 它属于那一次提交动作,不是 review 的属性),导出报告同样不含它。**一句 agent 写的话要发给 PR 作者或贴到别处,得由人自己写下**;让机器的结论顺着"复用"悄悄流出去,是把署名和责任一起转移了。

**总结记下写于第几轮,过期只标不清。** 总结是 review 级的单份值、重跑不清空,所以第 2 轮漏调 `write_summary`(模型跳过 / 被叫停 / 没写完就收尾)时,第 1 轮的结论会原样冒充本轮结论。要拦的是**冒充**,不是数据本身:开新轮就清空会让一份大体仍成立的总结凭空作废,把「本轮写过总结」当收轮硬门槛又会让一轮真 findings 因为漏写而判失败(且 `stopped` 定义上就没有总结)。故记 `summary_round`,Summary 屏标出过期,由 reviewer 决定还认不认。正文与重点文件共用这一个轮次:两者只可能被同一次 `write_summary` 写入,没有第二个写入者能让它们错开。

**`summary_round` 顺带成了来源判据。** 该列出现之前 agent 没有任何写入总结的通道,故升级后「有正文却没有轮次」只可能是当年人工编辑框写下的。这类正文不清空(那是用户写的话),但也不挂在 agent 名下 —— **把人的话署到机器名下,与把机器的结论当人的话发出去是同一种错**。下次机审会连正文带轮次一并覆盖,自愈回正常路径。

**finding id 由 MCP `report_finding` 生成回传**,codex 侧 id 与存储 id 一致,`update_finding` / `resolve_finding` 据此定位。每条 finding 落库时同时建出**承载 discussion**,且必须随事件一起外发,否则本轮会话内 Discussion 栏是空的。

## finding 的状态与字段

finding 是一类 discussion,但同时是一条**可提交到 GitHub 的记录**,带两组**正交**状态:

- **triage**:`open` → `keep` / `dismiss`(用户裁决;剔除可附 `dismissReason`,复审时注入以抑制同类)。剔除**只写 triage 与理由**,标题/正文/suggestion 原样保留 —— agent 在讨论里提出的剔除同走这条路径,见 [discussion-proposals](discussion-proposals.md)
- **submission**:`unsubmitted` → `submitted`(记录 GitHub 链接)

只有 `keep` 进提交集;`submitted` 后内容锁定只读,不因 triage 变化而回退(唯一例外是复核追评,见 [findings-submit](findings-submit.md))。

另有一组随复审轮次演进的字段:`round`(首报轮次)/ `lastSeenRound` / `resolution` / `autoClosed`,语义见 [rerun](rerun.md)。

对抗档另加两组:`originTurn`(由哪一类 turn 报出 —— 没有它,自检轮补报的条目与首扫的混在一起,「补报的最终被剔除多少」根本问不出来)与 `verdict` / `verdictNote` / `verdictTurn` / `verdictRound`(自检轮的裁决、判据与出自哪一轮 —— 按轮判定是否仍代表当前结论,正文被改写时四列一并清空)。**裁决是标注不是动作**:它不改 `severity`、不改 `triage`、也不刷 `bodyRound`,理由见 [architecture](architecture.md#审核强度)。本列之前的存量行一律留 NULL 且**不回填** —— 那时 selfcheck 与 scan 在库里没有任何区分痕迹,硬猜只会造出假数据,分析起点就是该迁移落地那天。

可编辑字段(提交前):`severity` / `title` / `body` / `suggestion`;`category` 与 `file:line` 由 agent 定。`suggestion` 是**给 author 的建议代码**(提交时渲染为 GitHub suggestion 块),Duetlens 不落地执行。`origin: agent | manual | promoted` 区分 agent 上报 / 用户手动新增 / 由 user-discussion 提升而来 —— 三者同 schema、同提交路径。

## 历史保留

**保留 30 天,按最后更新时间算,启动时清一次。** 过期判据是 `updated_at` 而非 `created_at` —— 一次审核只要还在被追问 / 复审就一直续命。**不看状态**:未完成、未提交的会话同样过期,否则一次失败的扫描会永久占位。清理放在建窗前(此时无活跃会话),删 review 经 FK 级联带走全部子表。写死常量,没做成设置项 —— 但**对用户可见**:历史屏底部常驻一句策略说明,剩余不足 7 天的条目在行上标出还剩几天。常量落在 `shared/domain`,后端清理与前端说明必须是同一个数。

> **给后续改动的硬约束**(代码里没有任何东西会强制它):消息、finding 的编辑 / 裁决 / 提交写的都是**子表**,**新增任何代表「用户还在用这条审核」的子表写路径,都要走 `ReviewStore.withReviewTouch` 把父 review 的 `updated_at` 一并推上去**(冒泡与子表写入同事务),否则「旧扫描 + 新追问」会被按最后一次改状态的时间误删。判断标准是「算不算内容活动」:滚动位置、已看标记、复审去重命中有意**不**算。
