# 定位与核心变革

> 返回 [文档索引](../README.md)

## 1. 定位与背景

Duetlens 是 [better-review](https://github.com/xieziyu/better-review) 的 **2.0 全重写**,不是增量升级——打破原有架构,另起新仓库。

better-review 1.0 的本质是:Node daemon + React SPA,通过一次性 `codex exec` 让 agent 跑完一轮机审、写出 `findings.json` 就结束。它是 **单向、一次性** 的:agent 吐出 findings,人来消费,二者之间没有对话通道。

Duetlens 2.0 要解决的核心问题:**让 review 从"人消费 agent 的结果"变成"人和 agent 协同地做 review"。** 用户可以就某条 finding 追问 agent、可以自己框选一段代码发起讨论、可以让 agent 解释代码逻辑或给出意见。这要求 agent 会话必须 **常驻**,而不是跑完即弃——这正是采用 codex **app-server** 而非 `codex exec` 的根本原因。

## 2. 核心变革:协同对话式 review

流程的前半段和 1.0 一致:通过 `gh` 拉取 PR/diff、准备源码树、渲染提示词、让 agent 先做一轮机审产出 findings。

分水岭在后半段:

- findings **不再是终点**,而是对话的锚点。每条 finding 背后挂着一个可以继续追问的 **discussion**。
- 用户可以在 diff 上 **任意框选代码新建 discussion**,向 agent 提问("这段逻辑为什么这样写?""这里有没有并发问题?")。
- 因此 2.0 的核心实体是 **"锚定在某个代码位置(或 finding)上的对话线程 discussion"**;findings 只是其中一类由 agent 主动发起的 discussion。

数据结构见 [data-model](data-model.md)。

## 命名约定

codex app-server 把"一次常驻会话"本身称作 `thread`(见 [codex-integration](codex-integration.md))。为避免全程冲突,我们把自己"锚定代码的讨论线程"统一命名为 **discussion**,把 `thread` / `conversation` 一词留给 codex 的会话实体。
