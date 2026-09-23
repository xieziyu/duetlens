import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { APP_VERSION } from '@shared/version';
import { PI_CALL_PATH, PI_HANDSHAKE_PATH, PI_TOOLS_PATH } from './duetlens-extension';

/** extension 在 session_start 报回的事实。 */
export interface PiHandshake {
  activeTools: string[];
}

export interface PiBridge {
  /** 注入给 extension 的端点与令牌(令牌只走环境变量) */
  readonly url: string;
  readonly token: string;
  /** Duetlens 工具服务上声明的工具名 —— 拼 `--tools` 白名单要用 */
  readonly toolNames: readonly string[];
  readonly handshake: Promise<PiHandshake>;
  close(): Promise<void>;
}

/**
 * extension 的回传面:握手在这里就地收下,工具的列举与调用经 MCP client 转给 Duetlens 工具服务。
 *
 * 桥挂在 agent 这侧而不是工具服务里,是因为握手报的是**这个 pi 进程**的生效工具集,
 * 只读校验要在起会话的那一刻拿到它 —— 挂在工具服务上就得再绕一圈事件把它送回来。
 * 转发多出的那一跳是本机回环,换来的是工具服务对 pi 一无所知,两条链路认同一份 MCP 契约。
 */
export async function openPiBridge(mcpUrl?: string, mcpToken?: string): Promise<PiBridge> {
  let client: Client | undefined;
  let tools: Tool[] = [];
  if (mcpUrl) {
    client = new Client({ name: 'duetlens-pi-bridge', version: APP_VERSION });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: mcpToken ? { headers: { authorization: `Bearer ${mcpToken}` } } : undefined,
      }),
    );
    tools = (await client.listTools()).tools;
  }

  const token = randomUUID();
  let resolveHandshake!: (h: PiHandshake) => void;
  const handshake = new Promise<PiHandshake>((r) => (resolveHandshake = r));

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      void (async () => {
        const reply = (payload: unknown) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        try {
          const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          if (req.url === PI_HANDSHAKE_PATH) {
            const active = Array.isArray(body.activeTools) ? body.activeTools.map(String) : [];
            resolveHandshake({ activeTools: active });
            return reply({ ok: true });
          }
          if (req.url === PI_TOOLS_PATH) return reply({ tools });
          if (req.url === PI_CALL_PATH) {
            if (!client) throw new Error('本会话没有接工具服务');
            const res = await client.callTool({
              name: String(body.name),
              arguments: (body.arguments ?? {}) as Record<string, unknown>,
            });
            // pi 的 ToolResult 要 details;MCP 没这个字段,补空对象而不是让它 undefined
            return reply({ content: res.content, details: {}, isError: res.isError === true });
          }
          res.writeHead(404).end();
        } catch (e) {
          res.writeHead(500).end(e instanceof Error ? e.message : String(e));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    toolNames: tools.map((t) => t.name),
    handshake,
    close: async () => {
      // extension 的 fetch 走 keep-alive,不先掐连接的话 close 会一直等到空闲超时
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await client?.close().catch(() => undefined);
    },
  };
}
