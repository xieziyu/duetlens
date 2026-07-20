import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/** report_finding 上报的一条 finding(对齐 docs/design/data-model.md 可编辑字段)。 */
export interface ReportedFinding {
  /** MCP server 生成并回传给 agent,后续 update_finding 用它定位 */
  id: string;
  severity: 'high' | 'medium' | 'low';
  category?: string;
  title: string;
  body: string;
  file: string;
  line: number;
  suggestion?: string;
}

/** update_finding 的部分更新(对话打磨后回写)。 */
export interface ReportedFindingUpdate {
  findingId: string;
  severity?: 'high' | 'medium' | 'low';
  category?: string;
  title?: string;
  body?: string;
  suggestion?: string | null;
}

/** 供 agent 读取源码/diff 的回调;由 review 会话注入真实数据。 */
export interface McpContentProviders {
  getDiff: () => string | Promise<string>;
  getFile: (path: string) => string | Promise<string>;
}

const TOOLS = [
  {
    name: 'report_finding',
    description:
      '上报一条 code review finding。发现的每个问题都调用一次;锚定到具体文件与行号。',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        category: { type: 'string', description: '如 correctness / security / perf' },
        title: { type: 'string' },
        body: { type: 'string', description: '问题说明与影响' },
        file: { type: 'string', description: '相对仓库根的路径' },
        line: { type: 'number', description: '新侧行号' },
        suggestion: { type: 'string', description: '可选:给 author 的建议代码' },
      },
      required: ['severity', 'title', 'body', 'file', 'line'],
    },
  },
  {
    name: 'update_finding',
    description:
      '更新一条已上报 finding 的可编辑字段(对话打磨后回写)。finding_id 用 report_finding 的返回值。',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'report_finding 返回的 id' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        category: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        suggestion: { type: 'string' },
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'get_diff',
    description: '获取本次审核的完整 diff。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_file',
    description: '按相对路径读取被审文件的完整内容(只读)。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
] satisfies Tool[];

/**
 * Duetlens 对 codex 暴露的 in-process HTTP MCP server(StreamableHTTP)。
 * findings 经 report_finding 实时回传落进 app 状态,取代 1.0 watch 文件。
 * 事件:'finding' (ReportedFinding) · 'finding-update' (ReportedFindingUpdate) · 'tool-call' (name, args)。
 */
export class DuetlensMcpServer extends EventEmitter {
  private httpServer?: http.Server;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  readonly findings: ReportedFinding[] = [];

  constructor(private readonly providers: McpContentProviders) {
    super();
  }

  /** 监听在 127.0.0.1 上;端口 0 = 系统分配,返回 codex 用的 url。 */
  async listen(port = 0): Promise<string> {
    this.httpServer = http.createServer((req, res) => this.onRequest(req, res));
    await new Promise<void>((resolve) => this.httpServer!.listen(port, '127.0.0.1', resolve));
    const { port: actual } = this.httpServer!.address() as AddressInfo;
    return `http://127.0.0.1:${actual}/mcp`;
  }

  async close(): Promise<void> {
    for (const t of this.transports.values()) await t.close();
    this.transports.clear();
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'POST') {
      this.readBody(req)
        .then((body) => this.handlePost(req, res, body))
        .catch((e) => {
          res.writeHead(400).end(String(e));
        });
      return;
    }
    // GET(SSE 流)/ DELETE(结束会话)按 session 路由
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const transport = sid ? this.transports.get(sid) : undefined;
    if (!transport) {
      res.writeHead(400).end('未知会话');
      return;
    }
    transport.handleRequest(req, res);
  }

  private async handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? this.transports.get(sid) : undefined;

    if (!transport && isInitializeRequest(body)) {
      // 每个会话独立 Server + transport,tool 处理器闭包共享本实例状态,
      // 规避 codex 多次 initialize 时单 Server 连多 transport 的冲突。
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) this.transports.delete(transport!.sessionId);
      };
      await this.buildMcpServer().connect(transport);
    }

    if (!transport) {
      res.writeHead(400).end('缺少会话或非 initialize 请求');
      return;
    }
    await transport.handleRequest(req, res, body);
  }

  private buildMcpServer(): Server {
    const server = new Server(
      { name: 'duetlens', version: '2.0.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      this.emit('tool-call', name, args);

      if (name === 'report_finding') {
        const f: ReportedFinding = { id: randomUUID(), ...(args as Omit<ReportedFinding, 'id'>) };
        this.findings.push(f);
        this.emit('finding', f);
        // 回传 id,供后续 update_finding 定位
        return { content: [{ type: 'text', text: `finding recorded, id=${f.id}` }] };
      }
      if (name === 'update_finding') {
        const a = args as Record<string, unknown>;
        const update: ReportedFindingUpdate = {
          findingId: String(a.finding_id ?? ''),
          severity: a.severity as ReportedFindingUpdate['severity'],
          category: a.category as string | undefined,
          title: a.title as string | undefined,
          body: a.body as string | undefined,
          suggestion: a.suggestion as string | undefined,
        };
        this.emit('finding-update', update);
        return { content: [{ type: 'text', text: `finding updated, id=${update.findingId}` }] };
      }
      if (name === 'get_diff') {
        return { content: [{ type: 'text', text: await this.providers.getDiff() }] };
      }
      if (name === 'get_file') {
        const path = String((args as { path?: string }).path ?? '');
        return { content: [{ type: 'text', text: await this.providers.getFile(path) }] };
      }
      return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
    });

    return server;
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }
}
