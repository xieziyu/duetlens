/**
 * duetlens MCP 的**线上契约**:工具名与参数名。backend 用它声明工具、解析入参,
 * renderer 用它认工具调用事件 —— 两侧必须同源。
 *
 * 为什么单拎出来:agent 事件里的 `args` 是 `unknown`,renderer 读参数名写错**不会有任何
 * 编译错误**,只在界面上体现为一段空文案(`resolve_finding ·` 后面什么都没有)。
 * 线上是 snake_case 而领域侧是 camelCase,两套拼法并存,靠记忆对齐迟早出错。
 *
 * 描述契约给模型看的那份散文在 `backend/prompt/review-prompt.ts` 的 `BUILTIN_PROTOCOL`,
 * 有意不做成模板 —— 那段是写给模型读的说明,拼接会毁掉可读性,且它已是锁定段。
 */

export const MCP_TOOL = {
  reportFinding: 'report_finding',
  updateFinding: 'update_finding',
  dismissFinding: 'dismiss_finding',
  restoreFinding: 'restore_finding',
  resolveFinding: 'resolve_finding',
  writeSummary: 'write_summary',
  getDiff: 'get_diff',
  getFile: 'get_file',
  searchCode: 'search_code',
  judgeFinding: 'judge_finding',
} as const;

export type McpToolName = (typeof MCP_TOOL)[keyof typeof MCP_TOOL];

/** 跨层被读到的参数名。只收录**两侧都碰**的那些,不做全字段镜像 —— 那会变成第二份 schema。 */
export const MCP_ARG = {
  findingId: 'finding_id',
  file: 'file',
  path: 'path',
  severity: 'severity',
  title: 'title',
  status: 'status',
  query: 'query',
  verdict: 'verdict',
} as const;
