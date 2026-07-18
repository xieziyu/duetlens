# 待解决 / 风险点

> 返回 [文档索引](../README.md)
>
> 开发中复审。关键技术假设已在 [codex-integration](codex-integration.md) 验证通过,以下为验证后仍需在骨架期打磨的项。

- **codex app-server API 稳定性**:仍标 experimental,可能无预告 breaking change → `ConversationalAgent` 薄封装 + `generate-json-schema` 导出做回归。
- **上下文 / token 膨胀**:单会话多轮追问会持续增长,长 PR 尤甚。已有 `thread/compact/start` 原语,但**何时触发压缩、压缩后锚点 / discussion 引用如何保持**仍需设计。
- **per-thread MCP 注入的鲁棒性**:端口 / 令牌分配、codex 多次 `initialize` 的幂等、HTTP server 生命周期与 review 生命周期对齐,待在骨架期打磨。
- **审批面收敛**:除 MCP elicitation 外,`execCommandApproval` / `applyPatchApproval` 等在只读 sandbox 下应基本不出现,但需实测确认哪些反向请求仍会冒出来。
- **持久化 schema**:discussion 锚点、finding、message 的本地存储结构待定稿(见 [data-model](data-model.md))。
