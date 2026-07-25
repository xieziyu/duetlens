# 数据模型

> 返回 [文档索引](../README.md)

一次 review 的核心结构:

```
Review (一次审核会话)
  ├─ rounds[]                    ← 首轮 + 每次重跑各一轮(见 rerun.md)
  │     └─ 每轮 1 个 codex thread ← 轮内单会话、全局视野(见下)
  ├─ source (github-pr | local-branch | gitbutler-vbranch)
  ├─ diff / 源码树               ← 每轮重跑时刷新为最新
  └─ discussions[]               ← 挂在代码锚点上的对话线程(跨轮次存活)
        ├─ finding-discussion     (agent 主动通过 MCP report_finding 上报的一类特殊 discussion)
        └─ user-discussion        (用户框选代码发起的讨论)
```

关键决策:

- **一轮一个 codex thread,轮内全局视野。** 同一轮内只开一个 thread,所有 discussion 的追问都在这个会话里通过引用锚点进行,而不是每个 discussion 各开独立 thread。理由:让 agent 始终拥有整个 PR 的全局上下文,同时节省 token(不必给每个 discussion 重复喂 diff)。**跨轮则换新会话** —— 复用会话会让新旧两份 diff 的行号在同一上下文里互相污染,故上一轮的结论改由结构化 prompt 注入,详见 [rerun](rerun.md)。若某个讨论确需隔离上下文,codex 原生的 `thread/fork` 是已知备选手段,但默认不用。
- **findings 通过 MCP 工具回传,不再 watch 文件。** Duetlens 作为 app 向 codex 暴露一个 **MCP server**,提供 `report_finding` / `update_finding` / `get_file` / `get_diff` 之类工具。agent 通过调用这些工具实时、结构化地上报 findings,并可在对话中随时补充或修正(`update_finding` 用于对话打磨后回写)。这取代了 1.0 用 chokidar 盯 `findings.json` 的做法——数据实时、有明确 schema、天然契合多轮对话。**已端到端验证**,机制见 [codex-integration](codex-integration.md)。

- **历史保留 30 天,按最后更新时间算,启动时清一次。** 过期判据是 `updated_at` 而非 `created_at` —— 一次审核只要还在被追问/复审就一直续命。这要求**子表活动冒泡到父 review**:消息、finding 的编辑/裁决/提交写的都是子表,不把 `reviews.updated_at` 一并推上去,一条昨天刚追问过的旧审核就会按「最后一次改状态」的时间被删(冒泡与子表写入同事务,见 `ReviewStore.withReviewTouch`)。**不看状态**:未完成、未提交的会话同样过期,否则一次失败的扫描会永久占位。清理放在建窗前(此时无活跃会话),删 review 经 FK 级联带走 discussions / findings / messages / ui_state / diffs / rounds。

## finding 的状态与字段

finding 是一类 discussion,但同时是一条**可提交到 GitHub 的记录**,带两组独立状态:

- **triage**:`open` → `keep` / `dismiss`(用户裁决保留/剔除;剔除可附 `dismissReason`,复审时注入以抑制同类)
- **submission**:`unsubmitted` → `submitted`(记录 GitHub 链接)

另有一组随复审轮次演进的字段:`round`(首报轮次)/ `lastSeenRound` / `resolution`(`fixed` | `still_present`,经 MCP `resolve_finding` 回写)。语义与轮次约定见 [rerun](rerun.md)。

可编辑字段(提交前):`severity` / `title` / `body` / `suggestion`;`category` 与 `file:line` 由 agent 定。`suggestion` 是**给 author 的建议代码**(提交时渲染为 GitHub suggestion 块),Duetlens 不落地执行 —— 只 review 不改代码。`source: agent | manual | promoted` 区分 agent 上报 / 用户手动新增 / 由 user-discussion 提升而来(同 schema、同提交路径)。对话经 MCP `update_finding` 回写字段是 finding 的打磨闭环。完整筛选与提交流程见 [findings-submit](findings-submit.md)。

> **已落地**:具体字段 schema 见代码 —— 领域类型与 zod ingress schema 在 `src/shared/domain.ts`,sqlite 建表(reviews / discussions / findings / messages / ui_settings / review_ui_state)在 `src/backend/db/schema.ts`,读写在 `ReviewStore`。finding id 由 MCP `report_finding` 生成回传、`update_finding` 据此回写(见 [implementation-status](implementation-status.md))。
