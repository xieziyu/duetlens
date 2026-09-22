/**
 * pi 侧的 Duetlens 胶水。**运行时源文件** —— pi 经 jiti 直接读它,不参与 main bundle。
 *
 * 只用 `node:` 内置与全局 fetch,**不 import pi 自己的包**:值 import 会把 node_modules 解析
 * 拖进来,而这个文件跑在 pi 的进程里、不在我们的依赖树里。故 pi 的 API 在这里是本地最小声明,
 * 只覆盖用到的那几个成员;等价的完整类型在 pi 的 `docs/extensions.md`。
 *
 * 职责只有「把 pi 侧的事实报回 Duetlens」与「把工具调用转发回去」,**不含业务判断** ——
 * 工具清单、schema、落库、校验、提案模式全在 Duetlens 那侧,与 codex 链路共用同一份
 * (见 docs/design/pi-integration.md)。这里连工具名都不写死,照拉回来的清单注册。
 */

/** pi 工具的返回形状(对齐 MCP 的 content 块,pi 侧原样透传给模型)。 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

/** pi 注入的扩展 API 的最小切面。 */
interface ExtensionAPI {
  on(event: 'session_start', handler: () => void | Promise<void>): void;
  /** 本次会话**实际**生效的工具名。只读保证的唯一证据来源 —— RPC 协议查不到它。 */
  getActiveTools(): string[];
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<ToolResult>;
  }): void;
}

/** Duetlens 下发的工具定义(MCP `Tool` 的子集,原样取自同一份声明)。 */
interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** 回传端点与令牌经环境变量注入:命令行对同机其他进程可见,令牌不能走那条路。 */
export const PI_ENDPOINT_ENV = 'DUETLENS_PI_ENDPOINT';
export const PI_TOKEN_ENV = 'DUETLENS_PI_TOKEN';

export const PI_HANDSHAKE_PATH = '/pi/handshake';
export const PI_TOOLS_PATH = '/pi/tools';
export const PI_CALL_PATH = '/pi/call';

export default async function duetlensExtension(pi: ExtensionAPI): Promise<void> {
  const endpoint = process.env[PI_ENDPOINT_ENV];
  const token = process.env[PI_TOKEN_ENV];
  // 没注入就什么都不做:让 pi 保持独立可用。缺失由 Duetlens 侧的握手超时定性,
  // 在这里抛错只会把原因埋进 pi 的 stderr。
  if (!endpoint || !token) return;

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return res.json();
  };

  // 工厂返回的 Promise 会被 pi await 在 session_start 之前,故这里注册的工具
  // 对第一轮就可见 —— 不能挪进 session_start。
  const { tools } = (await post(PI_TOOLS_PATH, {})) as { tools: RemoteTool[] };
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
      execute: async (_toolCallId, params) => {
        try {
          return (await post(PI_CALL_PATH, { name: tool.name, arguments: params })) as ToolResult;
        } catch (e) {
          // 桥断了要让模型看见,而不是静默变成一次没结果的调用:它会重试或改道,
          // 而 Duetlens 侧另有超时与事件流兜底。
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text', text: `Duetlens 回传失败:${msg}` }],
            details: {},
            isError: true,
          };
        }
      },
    });
  }

  // 工具注册之后再报:activeTools 这时才是完整的,只读校验要的就是这份完整清单。
  pi.on('session_start', async () => {
    await post(PI_HANDSHAKE_PATH, { activeTools: pi.getActiveTools() });
  });
}
