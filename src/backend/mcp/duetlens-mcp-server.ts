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
import type { ZodError } from 'zod';
import {
  dismissFindingSchema,
  FINDING_CATEGORIES,
  reportFindingSchema,
  RESOLUTIONS_REQUIRING_NOTE,
  resolveFindingSchema,
  restoreFindingSchema,
  updateFindingSchema,
  type ProposalKind,
  type ProposalPatch,
} from '@shared/domain';
import { APP_VERSION } from '@shared/version';

const CATEGORY_HINT = `建议取值:${FINDING_CATEGORIES.join(' / ')}`;

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
  /** null = 清空分类(缺省才是「不改」) */
  category?: string | null;
  title?: string;
  body?: string;
  suggestion?: string | null;
}

/** resolve_finding 的表态(复审轮次里对上一轮 finding 的判定)。 */
export interface ReportedFindingResolution {
  findingId: string;
  status: 'fixed' | 'still_present' | 'wont_fix';
  note?: string;
}

/** dismiss_finding / restore_finding 的裁决意见(理由必填,会成为剔除理由 / 恢复依据)。 */
export interface ReportedFindingTriage {
  findingId: string;
  reason: string;
}

/**
 * 工具调用当下这一 turn 的语义。
 * - `apply`:机审/自检轮,写 finding 的工具直接落库(reviewer 不在场,拦下来只会卡死自检)。
 * - `propose`:追问轮,一律先记成待确认提案 —— 回给 agent 的文本也要说清「尚未生效」,
 *   否则它会在回复里宣称已经改好,而屏上根本没变。
 */
export type McpWriteMode = 'apply' | 'propose';

/** propose 模式下一次写 finding 的意图;由 ReviewSession 落成 finding_proposals 的一行。 */
export interface ProposedFindingChange {
  kind: ProposalKind;
  /** kind='create' 时为 null(finding 尚不存在) */
  findingId: string | null;
  patch: ProposalPatch;
}

/**
 * 提案的受理结果。EventEmitter 没有返回值,故由发起方传一个可写对象、接收方就地填 ——
 * emit 是同步的,回来即已定。
 *
 * 非要有这条回执:接收方会因 finding 不存在 / 不属于本 review 而丢弃提案,而 agent 那边
 * 收到的却是「卡片已呈现」。它随后会照此向 reviewer 宣称已提议,可界面上根本没有确认入口。
 */
export interface ProposalOutcome {
  accepted: boolean;
  /** 未受理的原因,原样回给 agent */
  reason: string;
}

/** ingress 校验失败的统一应答:把问题原样说给 agent,让它补齐重来,而不是静默丢掉。 */
const reject = (tool: string, error: ZodError) => ({
  content: [
    {
      type: 'text' as const,
      text: `${tool} 参数不合法,未记录:${error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join(';')}。请修正后重新调用。`,
    },
  ],
  isError: true,
});

/** 摘掉值为 undefined 的键(工具入参里「没给」与「给了 undefined」要一视同仁)。 */
function dropUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * 提案回给 agent 的应答。措辞要点:说清**没有生效**且**在等 reviewer** ——
 * 只说「已记录」的话,agent 会在同一条回复里宣称改好了,而屏上的 finding 一个字没动。
 */
const PROPOSED = (what: string): string =>
  `已把「${what}」作为待确认卡片呈现在讨论里,尚未生效,等 reviewer 采纳。` +
  `请在回复中说明你的判断与依据,不要声称已经改好。`;

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
        category: { type: 'string', description: CATEGORY_HINT },
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
      '更正一条已上报 finding 的可编辑字段(改严重度 / 改写正文 / 换标题 / 调整 suggestion)。' +
      '讨论中一旦认定原来写的不准,就调用它,不必等用户开口 —— 讨论期间它不会立即改动 finding,' +
      '只会在对话里生成一张待确认卡片,由 reviewer 一键采纳。只传要改的字段。' +
      '注意:若结论是「这条根本不成立」,请用 dismiss_finding,不要把剔除理由写进 body。',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'report_finding 返回的 id' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        // 可清空的两个字段声明成 string|null:领域侧 null 就是「清空」,只写 string 的话,
        // 会校验 JSON Schema 的 client 会把 null 挡掉,已有的 category / suggestion 再也删不掉
        category: { type: ['string', 'null'], description: `${CATEGORY_HINT};传 null 清空分类` },
        title: { type: 'string' },
        body: { type: 'string' },
        suggestion: { type: ['string', 'null'], description: '建议代码;传 null 删掉原有 suggestion' },
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'dismiss_finding',
    description:
      '剔除一条 finding:讨论后认定它不成立(误报 / 前提不存在 / 代码不可达 / 属可接受差异)时调用。' +
      '只写剔除理由,finding 的标题与正文原样保留 —— 不要改用 update_finding 把理由覆盖进 body。' +
      '讨论期间同样只生成待确认卡片,由 reviewer 决定是否采纳。',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'report_finding 返回的 id' },
        reason: {
          type: 'string',
          minLength: 1,
          description:
            '为什么这条不成立。会存为剔除理由并注入下一轮复审,需自足 —— 写清判据(在哪看到、凭什么),不要只写「误报」。',
        },
      },
      required: ['finding_id', 'reason'],
    },
  },
  {
    name: 'restore_finding',
    description:
      '恢复一条已被剔除的 finding:讨论后确认它其实成立(剔除依据不完整 / 另有路径可达)时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string' },
        reason: { type: 'string', minLength: 1, description: '为什么它其实成立;原剔除理由错在哪。' },
      },
      required: ['finding_id', 'reason'],
    },
  },
  {
    name: 'resolve_finding',
    description:
      '复审轮次专用:对上一轮的一条 finding 表态 —— 在最新代码里它是否仍然存在。' +
      '复审时给出的每条待确认 finding 都要调用一次;这不是新问题上报,新问题仍走 report_finding。',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: '复审指令里给出的 finding id' },
        status: {
          type: 'string',
          enum: ['fixed', 'still_present', 'wont_fix'],
          description:
            'fixed=已在最新代码中修复;' +
            'wont_fix=作者已在 PR 上回应说明不改(即使代码原样未变,也选这个,不要选 still_present);' +
            'still_present=代码未修复且作者没有给出不改的理由',
        },
        note: {
          type: 'string',
          minLength: 1,
          description:
            '判定依据。wont_fix 必填,摘录作者的原话;fixed 写清改在哪。' +
            'still_present 必填且必须**自足**:它会原样取代首轮正文发给作者,' +
            '需自带问题是什么、当前代码为何仍不成立,不能只写「仍存在」这类只有对照首轮正文才读得懂的话',
        },
      },
      required: ['finding_id', 'status'],
      // 条件必填只是给模型的提示(不少客户端会忽略 if/then);硬约束在 resolveFindingSchema
      allOf: [
        {
          if: { properties: { status: { enum: RESOLUTIONS_REQUIRING_NOTE } }, required: ['status'] },
          then: { required: ['note'] },
        },
      ],
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
 *
 * 写 finding 的四个工具(report / update / dismiss / restore)在 `propose` 模式下不落库,
 * 改发 'finding-proposal';语义与模式切换见 {@link McpWriteMode}。
 *
 * 事件:'finding' (ReportedFinding) · 'finding-update' (ReportedFindingUpdate)
 * · 'finding-resolution' (ReportedFindingResolution) · 'finding-proposal' (ProposedFindingChange)
 * · 'tool-call' (name, args)。
 */
export class DuetlensMcpServer extends EventEmitter {
  private httpServer?: http.Server;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  readonly findings: ReportedFinding[] = [];
  /** 本 server 的 bearer 令牌;codex 经 bearer_token_env_var 携带,隔离本地其他进程。 */
  readonly token: string;
  private writeMode: McpWriteMode = 'apply';

  constructor(private readonly providers: McpContentProviders, token: string = randomUUID()) {
    super();
    this.token = token;
  }

  /**
   * 切换写 finding 的语义。由 ReviewSession 在每个 turn 前后设置;turn 是串行的
   * (见 ReviewSession.turnChain),所以单个标志位够用,不会有两个 turn 同时读到对方的模式。
   */
  setWriteMode(mode: McpWriteMode): void {
    this.writeMode = mode;
  }

  /**
   * 发一条提案并按**受理结果**作答。接收方会因 finding 不存在 / 不属于本 review 而丢弃它,
   * 那时必须以 isError 告诉 agent 重来 —— 否则它拿着一句「卡片已呈现」去向 reviewer 复述,
   * 而界面上根本没有那张卡。
   */
  private propose(change: ProposedFindingChange, what: string) {
    const outcome: ProposalOutcome = { accepted: false, reason: '没有可呈现提案的讨论上下文' };
    this.emit('finding-proposal', change, outcome);
    if (!outcome.accepted) {
      return {
        content: [{ type: 'text' as const, text: `提案未记录:${outcome.reason}。请核对后重新调用。` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: PROPOSED(what) }] };
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
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end('未授权');
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
      { name: 'duetlens', version: APP_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      this.emit('tool-call', name, args);

      if (name === 'report_finding') {
        const input = args as Omit<ReportedFinding, 'id'>;
        if (this.writeMode === 'propose') {
          // 提案同样要过 ingress 校验:直接落库那条路由 ReviewSession 兜着,提案这条没有 ——
          // 不校验的话非法 severity / 缺字段会一路存进 finding_proposals,采纳时才炸。
          const parsed = reportFindingSchema.safeParse(input);
          if (!parsed.success) return reject('report_finding', parsed.error);
          return this.propose(
            { kind: 'create', findingId: null, patch: parsed.data },
            '把它记为一条新 finding',
          );
        }
        const f: ReportedFinding = { id: randomUUID(), ...input };
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
          category: a.category as string | null | undefined,
          title: a.title as string | undefined,
          body: a.body as string | undefined,
          suggestion: a.suggestion as string | undefined,
        };
        if (this.writeMode === 'propose') {
          // 落库前先把没给的字段摘掉:zod 的 optional 会把显式 undefined 原样带过,
          // 留着既数不清「到底改了几个字段」,也会在 patch JSON 里存下一串空键。
          const parsed = updateFindingSchema.safeParse(dropUndefined(update));
          if (!parsed.success) return reject('update_finding', parsed.error);
          const { findingId, ...patch } = parsed.data;
          // 一个字段都没给 = 什么也没提;放行只会在对话里留一张「未改动任何字段」的空卡片
          if (Object.keys(patch).length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'update_finding 至少要给一个待改字段(severity / category / title / body / suggestion),未记录。',
                },
              ],
              isError: true,
            };
          }
          return this.propose({ kind: 'update', findingId, patch }, '更正这条 finding');
        }
        this.emit('finding-update', update);
        return { content: [{ type: 'text', text: `finding updated, id=${update.findingId}` }] };
      }
      if (name === 'dismiss_finding' || name === 'restore_finding') {
        const a = args as Record<string, unknown>;
        const kind = name === 'dismiss_finding' ? 'dismiss' : 'restore';
        // 剔除/恢复始终是 reviewer 的判断,只在他在场的讨论里作为提案提出。机审轮没有人可确认,
        // 就地放行等于让 agent 自己关掉自己报的问题(rerun.md:连 wont_fix 都不自动剔除)。
        if (this.writeMode !== 'propose') {
          return {
            content: [
              {
                type: 'text',
                text: `${name} 只能在与 reviewer 的讨论中使用。本轮请改用 update_finding 降级严重度或在 body 里标注存疑。`,
              },
            ],
            isError: true,
          };
        }
        // 理由是这两个动作的**全部**内容(剔除不改正文,恢复不改任何字段),空理由等于什么也没提;
        // 且它会注入下一轮复审,静默收下只会让下一轮拿到一条没有依据的抑制项。
        const schema = kind === 'dismiss' ? dismissFindingSchema : restoreFindingSchema;
        const parsed = schema.safeParse({
          findingId: String(a.finding_id ?? ''),
          reason: String(a.reason ?? '').trim(),
        } satisfies ReportedFindingTriage);
        if (!parsed.success) return reject(name, parsed.error);
        return this.propose(
          { kind, findingId: parsed.data.findingId, patch: { reason: parsed.data.reason } },
          kind === 'dismiss' ? '剔除这条 finding' : '恢复这条 finding',
        );
      }
      if (name === 'resolve_finding') {
        const a = args as Record<string, unknown>;
        const resolution: ReportedFindingResolution = {
          findingId: String(a.finding_id ?? ''),
          status: a.status as ReportedFindingResolution['status'],
          note: a.note as string | undefined,
        };
        // 唯一一处会把校验结果回给 agent 的入口:静默丢弃的话,漏了 note 的表态照样落库,
        // 而复核说明取代首轮正文的契约就此落空(下游只剩一句没有依据的结论)。
        const check = resolveFindingSchema.safeParse(resolution);
        if (!check.success) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `resolve_finding 参数不合法,未记录:${check.error.issues.map((i) => i.message).join(';')}。` +
                  `请补齐后重新调用。`,
              },
            ],
            isError: true,
          };
        }
        this.emit('finding-resolution', resolution);
        return {
          content: [{ type: 'text', text: `finding resolved as ${resolution.status}, id=${resolution.findingId}` }],
        };
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
