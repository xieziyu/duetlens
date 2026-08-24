/**
 * 与本机 codex 的版本契约。放 shared:backend 起会话时据此校验,renderer 出错时据此给结论。
 *
 * app-server **没有版本协商**:initialize 里的 capabilities 是客户端单向声明能力,
 * 不回告服务端支持什么;版本只在 userAgent 串与 thread/start 应答的 `thread.cliVersion` 里。
 * 所以「对不对得上」只能事后从失败里认,认不出就会以裸 JSON-RPC 错误码糊到用户脸上。
 */

/** 手写协议子集(backend/agent/codex/protocol.ts)对齐的 codex 版本。 */
export const CODEX_TARGET_VERSION = '0.149.1';

/**
 * JSON-RPC 错误码的尾巴。只由 jsonrpc.ts 拼接 codex 的错误应答时产生,来源唯一 ——
 * 但**不足以**定性:codex 把 -32600 也用在业务条件上(如「no active turn to interrupt」)。
 */
const RPC_REJECTED = /\(code -3260[01]\)/;

/**
 * serde 反序列化失败的措辞。单看同样**不足以**定性:`Invalid request` / `missing field`
 * 这类词满世界都是 —— GitHub 的 400、git 的报错都可能带。
 */
const SERDE_SHAPE = /Invalid request|missing field|unknown variant|unknown field|invalid type/i;

/**
 * 本机 codex 与这版 Duetlens 的协议对不上:少了必填字段、方法改了名、枚举换了值。
 *
 * **两个条件缺一不可** —— 各自都会误伤,而且是相反方向的误伤:光认措辞会把 gh / git 的
 * 报错打成版本不匹配,光认错误码会把 codex 自己的业务拒绝打成版本不匹配。两类误判的代价
 * 一样:真实原因被盖掉,还给用户扣一个不可重试的「去升级 codex」。
 */
export function isCodexProtocolError(message: string): boolean {
  return RPC_REJECTED.test(message) && SERDE_SHAPE.test(message);
}

/**
 * 本机 codex 不认我们请求的审批策略。用来决定「换个说法重试」还是「照抛」——
 * 这两版 codex 表达只读且静默的说法不同,见 backend 侧 `READ_ONLY_APPROVAL`。
 *
 * 认两类:0.149 起点名 granular / experimentalApi 的能力门,以及**任何** serde 形状拒绝。
 * 后半段是有意放宽的 —— 更早的 codex 可能只回一句通用的 `invalid type`,收窄到点名那两个
 * 词就会漏掉它们。代价是形状错若出在别的字段(如 baseInstructions 改名)也会白退一次;
 * 但那次退回用的是更保守的说法,同一个原因会再失败一次并显式抛出,**不会伪装成成功**。
 *
 * 不认的是「任何错误都退」:真退错了,拿到的会是最难查的那种失败 —— 会话建得起来、
 * turn 跑得完、一条 finding 都回不来。
 */
export function isApprovalPolicyUnsupported(message: string): boolean {
  return /granular|experimentalApi/i.test(message) || isCodexProtocolError(message);
}
