# 数据模型

> 返回 [文档索引](../README.md)

一次 review 的核心结构:

```
Review (一次审核会话)
  ├─ 1 个 codex thread            ← codex 侧的常驻会话;单会话,全局视野(见下)
  ├─ source (github-pr | local-branch | gitbutler-vbranch)
  ├─ diff / 源码树
  └─ discussions[]               ← 挂在代码锚点上的对话线程
        ├─ finding-discussion     (agent 主动通过 MCP report_finding 上报的一类特殊 discussion)
        └─ user-discussion        (用户框选代码发起的讨论)
```

关键决策:

- **单 codex thread,全局视野。** 一次 review 只开一个 codex thread,所有 discussion 的追问都在同一会话里通过引用锚点进行,而不是每个 discussion 各开独立 thread。理由:让 agent 始终拥有整个 PR 的全局上下文,同时节省 token(不必给每个 discussion 重复喂 diff)。若某个讨论确需隔离上下文,codex 原生的 `thread/fork` 是已知备选手段,但默认不用。
- **findings 通过 MCP 工具回传,不再 watch 文件。** Duetlens 作为 app 向 codex 暴露一个 **MCP server**,提供 `report_finding` / `get_file` / `get_diff` / `resolve_finding` 之类工具。agent 通过调用这些工具实时、结构化地上报 findings,并可在对话中随时补充或修正。这取代了 1.0 用 chokidar 盯 `findings.json` 的做法——数据实时、有明确 schema、天然契合多轮对话。**已端到端验证**,机制见 [codex-integration](codex-integration.md)。

> 具体字段 schema(discussion 锚点结构、finding 严重度枚举、message 存储)待骨架期定稿后补入本页。
