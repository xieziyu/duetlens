/**
 * 与本机 codex 的版本契约。放 shared:backend 起会话时据此校验,renderer 出错时据此给结论。
 *
 * app-server **没有版本协商**:initialize 只在 userAgent 串里带版本,没有 capabilities 列表,
 * 而 thread/start 的应答里有 `thread.cliVersion`。所以「对不对得上」只能事后从失败里认,
 * 认不出就会以裸 JSON-RPC 错误码糊到用户脸上。
 */

/** 手写协议子集(backend/agent/codex/protocol.ts)对齐的 codex 版本。 */
export const CODEX_TARGET_VERSION = '0.145.0';

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
