# pi coding agent 接入

> 返回 [文档索引](../README.md)
>
> 对应 [README](../README.md) 的**已拍板决策 7**。`ConversationalAgent` 先被 codex 一家磨过,
> pi 是第二个实现,接它的过程把接口里剩下的 codex 假设挤了出去。
> codex 侧的协议事实仍以 [codex-integration](codex-integration.md) 为准,本文不复述。

## 目标与边界

**目标**:让一次 review 可以选 codex 或 pi 来跑,两者在 UI 上是同一套交互。

**不在范围内**:

- 不做「同一次 review 里多个 agent 协同」—— 一次 review 仍只有一个 agent。
- 不做 provider / API key 的托管。pi 用它自己的凭证体系,Duetlens 只探测就绪与否。
- 不把 codex 那条链路重构成「pi 也能用」的形状。两条链路各自直连接口层,**不共享中间件** ——
  共享层会被两边的差异撑成一堆条件分支,而差异恰恰是本文要如实承认的东西。

## 为什么是子进程 RPC,不是 SDK

pi 有两个接入面:`pi --mode rpc` 子进程(JSONL over stdio),或把 `@earendil-works/pi-coding-agent`
当库 import 进主进程用 `createAgentSession()`。

**选子进程**,理由按分量排:

- **与现有架构同形**。codex 也是子进程,进程生命周期、清理钩子、`before-quit` 那套兜底可以照搬同一种形状。
- **绕开 Electron ABI 与 ESM 打包**。pi 是 `"type": "module"`,且依赖树里 `pi-tui` 带 prebuilt `.node`。
  SDK 路径要把这些塞进 main bundle,而 CLAUDE.md 那条「ABI 二选一」的纪律已经够难守了。
- **版本解耦**。子进程只认 wire 协议,pi 升级不会把 Duetlens 的构建拖下水。

**代价,已接受**:自定义工具只能经 extension 文件注册,所以要多分发一个文件(见下节)。
SDK 路径的 `customTools` 本可以省掉这一层。

## finding 回传:extension 桥,不是 MCP

pi **有意不做 MCP**。它的等价物是 extension 里的 `pi.registerTool()`。

**决定**:保留现有的 in-process HTTP MCP server **原样不动**,另写一个薄 extension,
把 pi 侧的工具调用转成 HTTP 请求打回来。

- 工具名、参数名、schema 仍只有 [`mcp-contract.ts`](../../src/shared/mcp-contract.ts) 一份。
  extension 不自带 schema,**启动时从 server 拉**,否则就是第二份真相源。
- 令牌只经环境变量注入子进程,不落命令行(命令行对同机其他进程可见)。
- extension 是写给 pi 的胶水,**不含业务判断** —— 落库、校验、提案模式全在 server 那侧,与 codex 链路共用。

**桥挂在 agent 这侧,不挂进 MCP server**(P2 定,推翻了 spike 里「挪进 server」的设想)。
extension 回调的是 `PiAgent` 自己起的一个本机 HTTP 端点:握手就地收下,工具的列举与调用
经 MCP client 转给同一个 server。理由:握手报的是**这个 pi 进程**的生效工具集,只读校验要在
起会话那一刻拿到它;挂在 server 上就得再绕一圈事件把它送回 agent。多出的那一跳是本机回环,
换来的是 server 对 pi 一无所知,两条链路认同一份 MCP 契约。

**由此消失的一整类失败**:codex 那条链路要靠 `MCP_UNDELIVERED_CODE` 兜住「调用被 codex 自己拒掉、
turn 却照常 completed」,表现为界面上与「真的没问题」无从区分的 0 findings。pi 这侧工具调用是
extension 进程内的直接执行,拒不掉;桥断了是 HTTP 错误,会作为工具返回值回到模型面前。
**不要为 pi 链路移植那条兜底**,它在这里没有对应的失败模式。

## 只读保证换了一种性质

codex 那侧是 OS 级 sandbox + 回显证实 + 失败关闭(见 [codex-integration](codex-integration.md))。
**pi 没有内置沙箱**,官方文档明说真正的隔离得来自操作系统或容器。

pi 这侧的只读靠**不给工具**:pi 的内置工具一个不开,只启用 Duetlens 声明的那几个。
`bash` / `edit` / `write` 不开是因为会写盘;`read` / `grep` / `find` / `ls` 也不开,理由有二:

- **不受仓库边界约束**。它们接受 `~` 与绝对路径,`cwd` 挡不住 `~/.ssh`。被审代码是不可信输入,
  里面的提示词注入可以诱导 agent 去读本机凭证,再写进 finding 正文 —— 提交一次就上了 PR。
- **读的是工作区,不是被审的那一版**。GitButler 下工作区是各 lane 合并后的样子,审 A 会读到 B 的改动;
  PR 来源下本地 checkout 也未必停在 PR 的 head。读到的内容与 diff 分了家,finding 就锚错了地方。

Duetlens 自己的 `get_file` / `search_code` 读的是钉住的 commit 树、词法上挡掉 `../` 与绝对路径、
不跟随符号链接(见 `gitbutler-source.ts`),两条链路由此共用同一道边界。

这比「声明一个策略再验证它回显」更硬 —— 工具没注册,模型的 tool list 里根本不存在它 ——
但**保证的对象变了**,要如实承认:

- 挡住的是 agent 通过工具写盘。与 pi 同权限跑的代码它管不到 —— 所以**一概不加载**:
  `--no-extensions` / `--no-skills` / `--no-prompt-templates` / `--no-approve`。
  最后一条尤其要紧:被审仓库里的 `.pi/` 是**别人写的代码**,审它不等于信任它。
  剩下管不到的只有 pi 本体与用户自己的 provider 配置。
  被审仓库的 `AGENTS.md` / `CLAUDE.md` 则**有意保留**(不加 `--no-context-files`):它们只是提示词文本、
  没有执行能力,项目约定对审核有用,codex 那侧同样会读 —— 两条链路在这一点上保持一致。
- 所以哨兵也要换:codex 那条校验的是 `sandbox` / `approvalPolicy` 回显,
  pi 这条校验的是**生效工具集**,拿不到一律判死(同样失败关闭)。判据是**白名单**
  (只有 Duetlens 声明的工具),不是写工具黑名单 —— 黑名单挡不住叫不出名字的工具。
  错误码 `PI_TOOLSET_NOT_READ_ONLY_CODE`、归因档 `toolset-not-read-only`,
  不要复用 `SANDBOX_NOT_APPLIED_CODE`,两者校验的不是同一件事、处置建议也不同。

**连带损失**:codex 链路上那些 rg / sed / cat 取证动作在 pi 这侧没有对应物,
pi 不产出 `command` 事件,取证只以 `get_file` / `search_code` 的 `tool-call` 出现;
列目录的能力也没了。取证够不够由 P0-S3 回答:够 —— 那一轮 agent 本来就几乎只用这两个工具。

## 能力对照(已实测部分)

零 token 探测(`get_state` / `get_available_models`)已跑通,下列为实测或文档明载:

| 接口层需要 | pi 的对应物 | 差异 |
| --- | --- | --- |
| start / resume | `--session-id` / `--resume` | 对得上 |
| sendMessage + 流式 | `prompt` + `message_update` | 对得上 |
| interrupt | `abort` | **session 级,无 turn id** |
| 工具调用观测 | `tool_execution_start` 带 `args` | 不需要 deferred 检索 |
| token / 上下文占用 | `contextUsage{tokens, contextWindow, percent}` | 直接可用,不必扣 reasoning |
| 模型列表 | `get_available_models` | 元数据带 `contextWindow` 与 `cost` |
| 追问排队 | `steer` / `follow_up` | pi 自带队列 |
| 压缩 | 内建 auto-compact + 事件 | 对得上 |

**`interrupt` 少一个 turn id** 是接口层唯一的形状冲突。会话内 turn 本就串行化,
「当前在跑的那轮」唯一,故 session 级 abort 够用。

**P1 的处置:turn id 由实现给出,不改接口形状**。协议只有会话级打断的,适配层自己编号,
`interrupt` 收到的 id 不是当前那轮就不动手 —— 叫停是对当时那轮取的快照,会话级 abort
不核对 id 会误杀紧随其后的下一轮(比如扫描自然收尾后立刻开跑的排队追问)。
这样 `review-session` 的打断与归属逻辑两条链路共用、一行不改;空 id 从「可选形态」
降格为「协议漂移时的降级」。

接口上原本的 `approve` 一并删掉:它是 codex 反向审批的应答口子,从来没有调用方,
pi 也没有审批闸。`approval` 事件照留,标为仅 codex 产出。

## 实测结论(P0-S1 / S2)

判据是 `npm run spike:pi` 真跑出来的,不是文档上写着就算数。**这些坑没有一个会报错**,
全都长成别的样子,故逐条记下。

- **extension 可以零运行时依赖**。只用 `node:` 内置与全局 fetch,pi 的类型做本地最小声明;
  jiti 会擦掉纯类型 import。故这个文件不需要 node_modules,分发时只要它自己。
- **`--tools` 白名单同时过滤 extension 注册的工具**。不点名的自定义工具**注册成功但不生效**,
  `getActiveTools()` 里根本没有它。工具清单 Duetlens 侧本来就有(它自己就是 server),
  先拉清单再拼白名单,不存在先后矛盾。
- **裸 JSON Schema 能直接喂给 `registerTool`**,含 `type: ["string","null"]` 这种联合类型也过。
  不必为 pi 另做一份 typebox schema —— 那会变成第二份真相源。
- **extension 加载失败会让整个 pi 不可用,而 stderr 说得很清楚**。桥在**加载期**断掉
  (端点 404 / 500、令牌错、server 没起来),pi 直接拒绝启动:stderr 是
  `Failed to load extension "<path>": ...`,stdout **一个字节都没有** —— 连 `get_state` 都不应答。
  两条推论:**必须接 pi 的 stderr**(诊断信息只在那儿,RPC 通道上什么都没有);
  以及不必防「带半截 extension 往下跑」—— pi 要么全有要么全无。
  **运行期**断掉是另一回事:extension 已经加载,工具调用返回 isError,模型看得见、会重试或改道。
- **模型名对不上时是一次静默空跑**。`--list-models` 列的是 catalog 而非 provider 实际可用集
  (`claude-haiku-4-5` 在本机 provider 上就不存在)。名字错了 provider 回 400,
  但 pi 在 RPC 模式下**不发任何错误事件**:事件序列与正常轮次逐条一致,只是全程没有正文、
  没有工具调用。判据只能是结构性的 —— 一轮跑完既无正文也无工具调用即判失败。
- **终局是 `agent_settled`,不是 `agent_end`**。后者之后还可能有自动重试与排队的 follow-up。
- **pi 的 `turn` 不是 Duetlens 的 turn**。pi 的 turn 是「一次 assistant 响应 + 它引发的工具调用」,
  Duetlens 的一轮对话对应的是 `agent_start` → `agent_settled` 整段。映射时别被同名骗了。
- `abort` 在空闲时也回 `success: true`,不必先判忙。
- 子进程 `kill` 后干净退出,不残留。

### S3 / S4 补充

- **禁 bash 之后取证能力够用 —— S3 判是**。一轮真实机审(sonnet-5,素材是本接入自己的 diff),
  agent 全程用 `get_file`(带行区间)+ `search_code` 反复核实,8 条 finding 条条锚定到具体行,
  没有一次因为缺 shell 停下。**那条「放开 bash 再逐条 block 写类命令」的退路不用走了** ——
  它本来就是 codex 那侧明确拒绝过的泥潭。
- **一轮机审是分钟级的**,第一次跑满 600 秒还没收尾,放宽到 20 分钟才走完。
  比 codex 那侧追问轮的量级大得多,故 pi 链路上「在途状态可见」比 codex 链路更要紧,
  而且 P2 的超时不能照抄 codex 的数。
- **用量没有事件,只能问**。`get_session_stats` 给 `contextUsage{tokens, contextWindow, percent}`
  (实测 119130 / 1000000),但 pi 不主动推送 —— 状态栏那枚环在 pi 链路上要靠轮询,
  轮询节奏是 P2 要定的东西。
- **事件映射:11 个 `AgentEvent` kind 里 8 个派生得出**。派生不出的三个各有性质:
  `web-search` pi 没有这个能力;`approval` 不适用(只读靠工具集,不靠审批闸);
  **`turn-failed` 没有对应事件**,只能用结构性判据(见上面那条静默空跑)。
- **agent 会去读项目文档并据此改判**。观测到它读 `pi-integration.md` 之后
  `dismiss_finding` 撤回了自己刚报的一条。这是真实且合理的行为,但意味着
  **cwd 与可读范围直接影响结论** —— P3 定 cwd 时要意识到这一点,不是随便给个路径。

### P2 实测补充

`npm run spike:pi`(零 token 部分)与 `-- scan` / `-- stop` 走的是公开入口 `PiAgent` + `ReviewSession`。

- **`--session-id` 找不到会话时静默新建一个空的**,stderr 只留一句 Warning。续接要是照单全收,
  就是「续接成功、上下文全丢」。判据是续接后 `get_state.messageCount` 为 0 即拒绝。
- **extension 加载失败在起会话时一百多毫秒内就报出来**:pi 直接退出,握手与进程退出赛跑,
  不必等满握手超时。
- **叫停**:扫描首个动作之后 `stopScan`,自编号的 turn id 点名、会话级 `abort`,
  从应答到收轮 14ms,本轮记为已停止而不是失败。
- **用量在 `turn_end` 之后问一次**,节奏跟着上下文真正变化的时刻走,不另起定时器。
  压缩刚结束时 `contextUsage.tokens` 为 null,这时不报,免得环归零。
- **不指定模型时跑的是用户 pi 设置里的默认模型**(本机是 opus 档)。走 API key 的 provider 按量计费,
  但 P3 仍定为允许「随 pi」,与 codex 的账号默认同一种语义(见 P3 节)。
- **错误归因按特征串认**。pi 给的是 provider 的英文原句不是错误码,`piErrorKind` 按特征归档,
  认不出就是 `other`,不硬猜;「空跑」认不出原因时归 `bad-request`,它已知的成因就是请求被 provider 拒了。
- **打包**:pi 在自己的 Node 进程里读 extension,读不了 asar。经 `extraResources` 落成
  `Resources/pi/duetlens-extension.ts`,实测从签过名的 `.app` 里加载、握手通过,签名校验不受影响。

### P3 装配与选择

- **agent 按 review 选,建行即定死**。发起表单里选,设置里只存预填值;复审、追问、PR 内的子范围
  一律沿用这条 review 的 agent。会话 id 只在产生它的那一家那里有意义,中途换家等于拿 codex 的 thread id 去问 pi。
  会话 id 列同一次 migration 改成中立的 `agent_session_id`,`agent` 列的 DEFAULT 回填存量行为 codex。
- **不指定模型 = 用 pi 设置里的默认**,与 codex 的「账号默认」同一种语义。两家的模型名互不通用,
  故预填值各存一份,切 agent 时模型跟着换。pi 的模型标识带 provider 前缀(`provider/id`):
  同一个 id 可能挂在两家下面,回填到 review 上的也是这个全名,续接时原样传回。
- **模型列表与就绪判定是同一次零 token 探测**:`get_available_models` 只列配好凭证的 provider
  (没配凭证的 google 就不在里面),列表非空即至少有一家能跑。但**列表里有 ≠ 能用**:
  实测经第三方中转的 provider 会把列表里的模型直接 400 拒掉(「该模式不支持当前模型」),
  这只能在跑的时候才知道,归因落 `bad-request`。
- **模型下拉标出 endpoint 域名**。同一个模型经官方直连与第三方中转,延迟能差一个数量级(见下条),
  Duetlens 判断不了哪家是中转,只能把线路摆在选模型的人眼前。
- **onboarding 两家有一家就绪就放行**。另一家已就绪时,这一家缺失只标「可选 · 未配置」,不用红色。
- **pi 的会话放在 Duetlens 自己的目录**(`userData/pi-sessions`):审核会话不该混进用户在 pi 里的
  会话列表,续接也只认这一处。
- 实测(`npm run spike:agents`):同一个仓库两家各跑一轮,findings 进同一张表;新 manager
  指向同一份库续接,两家都答得上追问。
- **pi 与 codex 的速度差来自 provider 线路,不来自 pi**。同一分支、同为 `gpt-5.6-sol` medium:
  pi 走第三方中转一轮 698s,走 `openai-codex`(与 codex 同一个 chatgpt 后端)205s;
  上下文与缓存命中相当时,中转单次请求 17–135s,直连 3–40s。工具执行与桥两边都近乎 0。
  小请求测不出这个差距(两条线都约 6s),要看带着真实上下文的请求。
  早先记过的「pi(haiku)222s vs codex 40s」同样走的中转,不能当作两家 agent 的对比。

## 成本模型与凭证

codex 走订阅账号;pi 走各 provider 的凭证 —— 订阅登录(`/login`)或 API key,后者按量计费,
模型元数据里直接带单价。这影响用户可见的几处:`unauthorized` / `usage-limit` / `connection` 的处置建议、
onboarding 的引导命令、模型下拉里的单价。
**两套文案分叉,不要合并成一句中立的废话。** 失败处置以 codex 的写法为底表,pi 只覆盖处置不同的那几档。

## 阶段与验收判据

每阶段的判据是「拿什么证据算过」,不是「做完了几个文件」。

### P0 调研 spike(不改现有代码)

| | 验什么 | 算过的判据 |
| --- | --- | --- |
| S1 | RPC 生命周期 | 拉起 / 握手 / `get_state` / `abort` / 退出全走通,子进程不残留;零 token |
| S2 | extension 桥端到端 | 模型调 `report_finding`,经 extension → HTTP server → 落进 `ReviewStore`,断言查得到 |
| S3 | 禁 bash 后的取证能力 | 对一份真实 diff 跑完一轮,agent 能用 `grep`/`find` + 自建工具核实引用,不因缺 shell 卡住 |
| S4 | 事件面映射 | 录一份完整事件流,逐条对照 `AgentEvent` 的每个 kind,标出派生得出 / 派生不出的 |

S3 与 S4 要烧 token,合并成同一轮跑,别分两次。

### P1 接口层去 codex 化

把 `ConversationalAgent` / `AgentEvent` 里从 codex 约束推出来的论断改写成中立表述,
codex 专有的失败种类标明适用范围。**判据**:codex 链路的现有 spike 全绿,行为零变化。

### P2 pi 适配层

RPC 客户端(JSONL 帧)、事件映射、extension 桥文件与它的分发、只读工具集校验。
**判据**:新增 `spike:pi` 走完一轮真实机审并落库;只读校验有正反两条用例(缺写工具 / 混入写工具)。

### P3 装配与选择

`createSession` 的分叉点、环境自检分叉、agent 种类落库、设置与 onboarding 的两套文案。
**判据**:同一个仓库分别用两个 agent 各跑一轮,结果都进同一套界面;app 重启后两条链路都能续接。

### P4 收口

提示词措辞中立化、文档更新(本文 + README 决策 7 + codex-integration 的指向)、回归。
**判据**:改过共享契约,故 codex 侧 spike 要重跑一遍(没有 `spike:all`,按契约影响面点名跑)。

## 未决问题

- **pi 版本契约**。codex 那侧有 `CODEX_TARGET_VERSION` 与协议错误判据。pi 的 RPC 协议是否需要同等对待仍未定;目前只探测版本号供设置与 onboarding 展示,不做对齐判据。
