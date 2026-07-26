# Duetlens 设计文档

Duetlens 是 [better-review](https://github.com/xieziyu/better-review) 的 **2.0 全重写**(另起新仓库,不是增量升级)。

better-review 1.0 是 **单向、一次性** 的:一次 `codex exec` 跑完机审、写出 `findings.json` 就结束,人只能消费结果,与 agent 之间没有对话通道。2.0 要解决的是:**让 review 从「人消费 agent 的结果」变成「人和 agent 协同地做 review」** —— 就某条 finding 追问、自己框选一段代码发起讨论、让 agent 解释逻辑。这要求 agent 会话**常驻**,也正是采用 codex **app-server** 而非 `codex exec` 的根本原因。

分水岭在流程后半段:findings 不再是终点,而是对话的锚点;每条 finding 背后挂着一个可继续追问的 **discussion**,用户也可在 diff 上任意框选新建 discussion。核心实体因此是「锚定在某个代码位置(或 finding)上的对话线程」,findings 只是其中一类由 agent 主动发起的 discussion。

> 这里只写**目标与已拍板的决策**及其理由。实现细节、视觉与进度以代码和 `git log` 为准。工程约定见 [CLAUDE.md](../CLAUDE.md)。

## 命名约定(易踩)

codex app-server 把「一次常驻会话」本身称作 `thread`。为避免冲突,Duetlens 把自己「锚定代码的讨论线程」统一叫 **discussion**;`thread` / `conversation` 只指 codex 的会话实体。

## 文档地图

| 文档 | 内容 | 何时看 |
| --- | --- | --- |
| [architecture.md](design/architecture.md) | 技术栈选型与代价、后端分层、前端状态分层与 UI 持久化、保留自 1.0 的能力 | 动结构 / 加模块前 |
| [data-model.md](design/data-model.md) | review / round / discussion / finding 的结构与状态,历史保留策略 | 改 schema / 数据流前 |
| [codex-integration.md](design/codex-integration.md) | app-server 协议的实测结论、MCP HTTP 注入、elicitation / sandbox / 审批 | 碰 codex 集成前 |
| [rerun.md](design/rerun.md) | 多轮复审:轮次模型、三态表态、剔除抑制、PR 协作上下文、失败留证 | 碰复审 / 轮次 / 去重前 |
| [findings-submit.md](design/findings-submit.md) | findings 筛选与提交 PR review / 导出 Markdown,422 失效锚点 | 碰提交流程 / finding 状态前 |
| [ui.md](design/ui.md) | 各屏的锚点决策与易踩约束 | 做界面前 |
| [design-system.md](design/design-system.md) | tokens 语义、表面与文字阶梯、对比度规则、品牌标记 | 改配色 / 抽组件前 |
| [release.md](design/release.md) | 出包 / 签名 / 公证 / 自动更新的形态与理由,证书与 secrets 准备 | 发版前 |
| [open-questions.md](design/open-questions.md) | 尚未收口的风险与空缺 | 排优先级时 |

## 已拍板决策

每条注明详述所在分册;**被否决的方向记在各分册里,别再重提**。

1. **全重写**(方案 A),另起新仓库,代号 Duetlens。
2. **Electron + Node/TS 主进程后端 + codex app-server + 外部 `gh` CLI**,先做 macOS。选 Electron 是为渲染与 Chrome 一致。→ [architecture](design/architecture.md)
3. **findings 走 MCP 工具回传**(`report_finding` / `update_finding` / `resolve_finding`),不再 watch 文件。→ [data-model](design/data-model.md) · [codex-integration](design/codex-integration.md)
4. **一轮机审 = 一个 codex thread**(轮内全局视野),**跨轮换新会话**,上一轮结论靠结构化 prompt 注入。→ [rerun](design/rerun.md)
5. **MCP 走 in-process HTTP + per-thread config 注入**,不写全局 `~/.codex/config.toml`;**elicitation 处理器是架构必需件**(对自建受信工具自动 accept,否则 turn 卡死)。→ [codex-integration](design/codex-integration.md)
6. **只 review,不改代码**:sandbox 锁 read-only,没有「让 codex 给修法」;`suggestion` 只作提给 author 的 GitHub suggestion 块。→ [findings-submit](design/findings-submit.md)
7. **多 agent 暂不做**,只在 `ConversationalAgent` 接口层留抽象 —— 先把一个真实实现磨对。→ [architecture](design/architecture.md)
8. **多轮重跑复审**:每轮新 thread + 全量重扫;agent 必须对上一轮 findings 三态表态(`fixed` / `wont_fix` / `still_present`),被剔除项经 prompt + 去重双层抑制。→ [rerun](design/rerun.md)
9. **提示词分「可配置口径」与「锁定契约」**:描述 MCP 工具契约的段落不进分层模型、不下发 renderer、设置页不可见,并首尾夹住用户内容。→ [ui](design/ui.md#审核规则提示词--三层编辑器)
10. **入口只分 GitHub PR / 本地仓库两档**,本地这档按 HEAD 自动判普通分支还是 GitButler 虚拟分支;落库的 `SourceKind` 仍是三值。→ [ui](design/ui.md#主入口--launcher)
11. **审核强度两档(标准 / 对抗),只做 L1 只读对抗推理**;L2「拉 worktree 写并执行对抗测试」已明确否决。→ [architecture](design/architecture.md#审核强度)
12. **审核历史保留 30 天**,按 `updated_at`、启动清一次、不豁免未完成会话。→ [data-model](design/data-model.md#历史保留)
13. **UI:diff review 是主场**,三栏 + 内联 discussion;duet 双声道(agent 天蓝 / human 琥珀);明暗与配色是两个正交轴。→ [ui](design/ui.md) · [design-system](design/design-system.md)
