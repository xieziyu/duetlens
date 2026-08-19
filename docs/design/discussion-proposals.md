# 讨论里的回写提案

一条 finding 报出来之后,真正把它打磨准的地方是 discussion。但「谈定了」与「改了」之间原本隔着一道人工搬运:
agent 谈出结论,却要 reviewer 再说一句「回写 finding」,它才动手。这一节交代为什么把那句话换成一个按钮。

## 为什么是提案,不是直接改

finding 是要提交给 author 的东西,**改动权归 reviewer**。所以两个极端都不成立:

- 让 agent 谈完直接改 —— review 的结论会在 reviewer 没看的时候悄悄变形;
- 让 agent 只在被明确要求时才改 —— 就是原来的样子:每次都要人把已经达成的共识再复述一遍。

取中间:**追问轮里写 finding 的工具调用不落库,落成一条待确认的提案**,在 agent 那条回复下方渲染成卡片,
reviewer 一键采纳。判断权没变,搬运没了。

工具面因此**不分叉**:agent 用的仍是 `report_finding` / `update_finding` 这些工具,是我们按 turn 的性质
决定它们的语义(见 `McpWriteMode`)——

| turn | 语义 | 理由 |
| --- | --- | --- |
| 机审扫描 / 对抗自检 | 直接落库 | reviewer 不在场,拦下来只会卡死这一轮。但 `dismiss_finding` / `restore_finding` 在这两轮**照旧拒收** —— 剔除是 reviewer 的判断;自检轮要表达「这条不成立」走 `judge_finding` 判 refuted,那是挂在 finding 旁边的标注,不替人做决定。自检轮另外**拒收 `update_finding`**:改 severity / 正文是绕开取证闸改动待提交内容,见 [architecture](architecture.md#审核强度) |
| 追问 | 记成提案 | reviewer 在场,由他点头 |

另开一套 `propose_*` 工具与之并存的方案**已否决**:让模型在「做」和「提议做」两套工具之间选,选错的概率
是白送的;而这个区分我们自己完全知道。

提案的工具应答必须说清「尚未生效、在等 reviewer」。只说「已记录」的话,agent 会在同一条回复里宣称改好了,
而屏上的 finding 一个字没动。

模式挂在**串行执行的 turn 内部**,不是队列外的一个标志位。挂在外面的话:排队期间跑着的扫描 turn 会把它的
`report_finding` 记成这条讨论的提案;而扫描收尾时的复位又会让排在后面的那一问退回直接落库 ——
一次绕过 reviewer 确认的静默改动。本轮提案 id 的收集篮同理由调用方持有:同一线程可以并发追问,
记在 session 上会被后一条清掉,提案就再也挂不上产生它的那句回复。

提案落库前照样过 ingress 校验(`reportFindingSchema` / `updateFindingSchema` 等),错误原样回给 agent。
直接落库那条路由 ReviewSession 兜着,提案这条没有 —— 不校验的话非法 severity 或缺字段会一路存进
`finding_proposals`,等到采纳那一刻才炸。

受理与否也要有回执。接收方会因 `finding_id` 不存在 / 不属于本 review 而丢弃提案,若照样答「卡片已呈现」,
agent 就会拿着这句话向 reviewer 复述,而界面上根本没有那张卡。`ProposalOutcome` 是个由发起方传入、
接收方就地填的可写对象(emit 是同步的),只有真的落库了才回 `PROPOSED`,否则以 `isError` 要求重来。

## 剔除是独立的一档,不是 update 的一种写法

`dismiss_finding` 是新增的工具,不是锦上添花 —— 在它之前,agent **没有任何表达「这条不成立」的手段**:
唯一能碰 finding 的 `update_finding` 只写得了 severity / title / body / suggestion,于是它只能把剔除理由
写进 `body`。后果是两条:原始 finding 正文被覆盖(库里也没了),以及一张已经没有意义的卡片继续占着待提交清单。

正确的落法是 `triage=dismiss` + `dismissReason`,**title / body / suggestion 一个字不动**。
理由与正文是两种东西,存两个字段,不能互相顶替。

剔除只在讨论里作为提案提出,机审轮直接回绝。理由同 [rerun](rerun.md):连 `wont_fix`(作者亲口说不改)
都不自动剔除,agent 自己更不该关掉自己报的问题。

采纳之后**不记 `autoClosed`**。那一格的语义是「复核判定代码里已经没有了」;而这里是 reviewer 看过论证后
点的头,属他自己的判断,下一轮的回归逻辑不该把它翻掉(见 `isAutoClosedFixed`)。

## 剔除态要看得见原文

剔除不动正文,但卡片收起态只剩一个划掉的标题 —— 「当初到底报的是什么」在屏上无处可查。
剔除态卡片因此给「展开原文」,不必先恢复再剔一遍。

## 卡片挂在消息上,落定之后也不消失

提案先于回复文本产生(工具调用在前,回复要等 turn 收尾才落库),所以落库时还不知道该挂哪条消息;
turn 收尾后回挂,不回挂就会排在解释它的那句话**上面**。挂不上的(turn 没给回复文本、消息被清空过)
接在线程末尾 —— 不渲染的话,一张待确认卡片会凭空消失,而它是唯一的确认入口。

applied / skipped 之后卡片折叠成一行,不删。它是「谁在什么时候把这条改成了什么」的唯一凭据;
applied 记下旧值快照,所以撤销是真的还原,而不是再猜一遍原来长什么样。

三个去向不能互相顶替:**已应用的只能撤销,不能直接标成已忽略**。后者会把改动留在 finding 里、
卡片却写着「已忽略」并给出「重新应用」,而那一下还会把已被它改过的当前值拍成新快照 ——
从此撤销回的是它自己写下的东西,留痕与撤销一起失真。

快照**只含该提案动过的字段**。拍全量的话,撤销会把应用之后 reviewer 自己的编辑一并回滚 ——
提案只降了个 severity,撤销却连带把他重写过的正文换回旧版。dismiss/restore 的撤销走
`restoreTriage` 而非 `setTriage`:后者会把 `autoClosed` 一律清零(手动裁决就该如此),于是复核自动结案的
条目撤销后会变成「reviewer 亲手剔的」,下一轮回归不再自动恢复,真问题就此被一直抑制。

`create`(由讨论新建 finding)不给撤销:新建出来的东西该留该删是 reviewer 的事,别在这里替他决定。

**已提交到 GitHub 的 finding,内容不可改**:`update` 的应用与撤销都在权威层拦下。UI 早按这条画
(卡片的 `writable` 排除 submitted),但提案是一条没有界面把关的写路径,只靠 UI 拦不住,
本地记录会与已发出去的评论对不上。只锁内容,不锁裁决 —— 已提交的追评项照样可以剔
(见 [findings-submit](findings-submit.md))。

## 过期只提醒,不拦

提案记下当时 finding 的 `updatedAt`;与当前值不同即说明这条在提案之后又被改过,直接套用会盖掉那次改动。
UI 就此提醒,但**照样让点** —— 判断权在 reviewer,我们只负责让他知道自己在盖什么。

判据逐档不同,因为各自会顶掉的东西不同:

- `update` 比 `updatedAt`:它覆盖的是正文字段,任何后续改动都可能与之冲突。
- `dismiss` 比**剔除理由**:它不只是翻一格 triage,还写理由 —— 这条已被剔除且理由与提案不同时,
  套用就是把 reviewer 自己写的那句顶掉。这里不能用 `updatedAt`,否则改个标题都会触发提醒。
- `restore` 不判:它把 triage 翻回 open 并清掉理由,而那正是「恢复」本来的语义(见 `setTriage`)。

`skipped` 与 `pending` 一样要判 —— 忽略过的提案仍给「重新应用」,那一下同样是覆盖;
只有 `applied` 不必判,当前值本就是它写的。

**撤销的方向反过来,而且是硬拦**:撤销写的是应用前的旧值,只有当前值**仍是这条提案写下的那些值**
时才成立。提案把 severity 降到 medium、reviewer 随后手动改成 low,再撤销就会把它顶回 high ——
既不是提案的功劳也不是他要的,所以直接不给撤(要回退就手动改,别替他做主)。
判据是逐字段比对而非 `updatedAt`:后者会被任何无关写入推高,一律拦下等于永远不给撤销。

## 四种意图

| kind | 落库路径 | 备注 |
| --- | --- | --- |
| `update` | `updateFinding` | 与 reviewer 就地编辑同一条路径 |
| `dismiss` | `setTriage('dismiss', reason)` | 正文保留;理由注入下一轮复审 |
| `restore` | `setTriage('open')` | dismiss 的镜像:讨论后确认它其实成立 |
| `create` | `promoteDiscussion` / `addFinding` | 提案出自哪条 user discussion 就落在哪条,不另起线程 —— 另建会把论证过程与 finding 拆散 |

`create` 的**锚点以提案为准**,不是 discussion 的。只在同文件时才提升(锚到别处的提案与这条讨论无关),
提升后若行号与提案不同,按提案改锚 —— agent 常会在框选范围内给出更准的一行,
而卡片上写的就是它;不对齐的话,采纳到手的锚点和看到的不是一个。

`update_finding` 的 `category` / `suggestion` 在公开 schema 里是 `string | null` —— 领域侧 `null` 就是
「清空」,只声明 `string` 的话,会校验 JSON Schema 的 client 会把 `null` 挡掉,已有的分类与补丁
再也删不掉,公开契约与实际接收形状对不上。

端到端验证在 `scripts/spike-proposals.ts`(`npm run spike:proposals`,需 `codex login`):真 codex 走一遍
「追问 → 提案 → 采纳 / 撤销」,并用桩 agent 经真实 MCP 端点复现「扫描在跑时插一条追问」的时序。
最后这条是回归用的 —— 把模式改回队列外设置,它会立刻失败在「扫描应落库一条真 finding」。

**改锚点(`file` / `line`)不在其中**。它决定提交到 GitHub 的落点,要先扩 `report_finding` 的 ingress schema,
与这条通道无关,单独再议。
