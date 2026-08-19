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
  judgeFindingSchema,
  reportFindingSchema,
  RESOLUTIONS_REQUIRING_NOTE,
  resolveFindingSchema,
  restoreFindingSchema,
  SUMMARY_FILES_LIMIT,
  updateFindingSchema,
  writeSummarySchema,
  type ProposalKind,
  type ProposalPatch,
  type TurnKind,
} from '@shared/domain';
import type { CodeSearchInput, CodeSearchResult } from '../source/source';
import { APP_VERSION } from '@shared/version';
import { MCP_ARG, MCP_TOOL } from '@shared/mcp-contract';

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

/** 按 turn 类型查表,而不是记一个布尔:新增 turn 类型时,每处闸门都被编译器逼着表态。 */
const WRITE_MODE: Record<TurnKind, McpWriteMode> = {
  scan: 'apply',
  selfcheck: 'apply',
  followup: 'propose',
};

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
  /** 缺省表示本 source 搜不了(如 github-pr 无本地代码树),此时 search_code 不会被声明。 */
  searchCode?: (input: CodeSearchInput) => Promise<CodeSearchResult>;
  /**
   * 按 id 取该 finding 锚定的文件路径,供 judge_finding 的取证闸判断「本轮读过它没有」。
   * 走库而不是本 server 的 findings 数组:复审轮要裁决的是上一轮报的条目,不在本次内存里。
   */
  findingFile?: (findingId: string) => string | null;
}

const TOOLS: Tool[] = [
  {
    name: MCP_TOOL.reportFinding,
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
        suggestion: {
          type: 'string',
          description: '可选:给 author 的建议代码,会逐字替换锚定行 —— 须带该行的前导缩进',
        },
      },
      required: ['severity', 'title', 'body', 'file', 'line'],
    },
  },
  {
    name: MCP_TOOL.updateFinding,
    description:
      '更正一条已上报 finding 的可编辑字段(改严重度 / 改写正文 / 换标题 / 调整 suggestion)。' +
      '讨论中一旦认定原来写的不准,就调用它,不必等用户开口 —— 讨论期间它不会立即改动 finding,' +
      '只会在对话里生成一张待确认卡片,由 reviewer 一键采纳。只传要改的字段。' +
      '注意:若结论是「这条根本不成立」,请用 dismiss_finding,不要把剔除理由写进 body。' +
      '改写 body 会作废本轮 resolve_finding 写下的复核说明与原有 suggestion —— 新 body 要自足,' +
      '补丁若仍成立请在同一次调用里一并给出。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.findingId]: { type: 'string', description: 'report_finding 返回的 id' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        // 可清空的两个字段声明成 string|null:领域侧 null 就是「清空」,只写 string 的话,
        // 会校验 JSON Schema 的 client 会把 null 挡掉,已有的 category / suggestion 再也删不掉
        category: { type: ['string', 'null'], description: `${CATEGORY_HINT};传 null 清空分类` },
        title: { type: 'string' },
        body: { type: 'string' },
        suggestion: {
          type: ['string', 'null'],
          description: '建议代码,须带锚定行的前导缩进;传 null 删掉原有 suggestion',
        },
      },
      required: [MCP_ARG.findingId],
    },
  },
  {
    name: MCP_TOOL.dismissFinding,
    description:
      '剔除一条 finding:讨论后认定它不成立(误报 / 前提不存在 / 代码不可达 / 属可接受差异)时调用。' +
      '只写剔除理由,finding 的标题与正文原样保留 —— 不要改用 update_finding 把理由覆盖进 body。' +
      '讨论期间同样只生成待确认卡片,由 reviewer 决定是否采纳。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.findingId]: { type: 'string', description: 'report_finding 返回的 id' },
        reason: {
          type: 'string',
          minLength: 1,
          description:
            '为什么这条不成立。会存为剔除理由并注入下一轮复审,需自足 —— 写清判据(在哪看到、凭什么),不要只写「误报」。',
        },
      },
      required: [MCP_ARG.findingId, 'reason'],
    },
  },
  {
    name: MCP_TOOL.restoreFinding,
    description:
      '恢复一条已被剔除的 finding:讨论后确认它其实成立(剔除依据不完整 / 另有路径可达)时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.findingId]: { type: 'string' },
        reason: { type: 'string', minLength: 1, description: '为什么它其实成立;原剔除理由错在哪。' },
      },
      required: [MCP_ARG.findingId, 'reason'],
    },
  },
  {
    name: MCP_TOOL.resolveFinding,
    description:
      '复审轮次专用:对上一轮的一条 finding 表态 —— 在最新代码里它是否仍然存在。' +
      '复审时给出的每条待确认 finding 都要调用一次;这不是新问题上报,新问题仍走 report_finding。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.findingId]: { type: 'string', description: '复审指令里给出的 finding id' },
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
      required: [MCP_ARG.findingId, MCP_ARG.status],
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
    name: MCP_TOOL.writeSummary,
    description:
      '写下本次审核的总结,收尾时调用一次(复审 / 自检轮同样在收尾时重写,整份取代上一次)。' +
      '总结呈现在 Summary 屏供 reviewer 判断(不会自动发给 PR 作者);' +
      'files 是你判断值得人工重点复核的文件 —— 只挑真正需要人眼的,不要把改动文件列表誊一遍。',
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            '总结正文(Markdown)。讲改动做了什么、整体判断、以及最需要作者注意的地方;' +
            '不要罗列已上报的 finding —— 它们在别处逐条呈现。',
        },
        files: {
          type: 'array',
          description:
            `值得人工重点复核的文件,最多 ${SUMMARY_FILES_LIMIT} 条,按重要性排序;没有就给空数组。` +
            '一个文件只给一条(同一路径要说的话合成一句 note,重复路径只有第一条生效)。' +
            '这里放的是**没有变成 finding、但人眼该过一遍**的地方:' +
            '改动面大到难以静态判断、时序 / 并发要靠人推、需要实机或数据验证、外部契约变更影响面未知。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对仓库根的路径,与 diff 里一致' },
              note: { type: 'string', description: '一句话:为什么需要人工看、具体看什么' },
            },
            required: ['path', 'note'],
          },
        },
      },
      required: ['body'],
    },
  },
  {
    name: MCP_TOOL.getDiff,
    description: '获取本次审核的完整 diff。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: MCP_TOOL.getFile,
    description:
      '按相对路径读取被审文件内容(只读)。' +
      '核实某一处时请给 start/end 只取那一段 —— 逐条全文件重读会把上下文顶到 auto-compact,' +
      '而 compact 摘要掉的正是你要用来判断的原文。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start: { type: 'number', description: '起始行(1 起,含);省略则从头' },
        end: { type: 'number', description: '结束行(含);省略则到尾' },
      },
      required: ['path'],
    },
  },
  {
    name: MCP_TOOL.searchCode,
    description:
      '在被审代码树里做**字面量**搜索(非正则,大小写敏感),返回 file:line 与命中行本体。' +
      '用它核实 finding 里引用的符号、调用点、guard 是否真的存在 —— 拿到行号后用 get_file 取那一段读上下文。' +
      '注意:文本搜索命中不了动态调用、重导出与字符串拼接出来的引用,0 命中不能当作「不存在」的证据。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.query]: { type: 'string', minLength: 1, description: '要搜的字面量原文' },
        path_prefix: { type: 'string', description: '可选:限定在某个目录/路径前缀内搜' },
      },
      required: [MCP_ARG.query],
    },
  },
  {
    name: MCP_TOOL.judgeFinding,
    description:
      '自检轮专用:对一条**已上报**的 finding 下裁决,说明它到底站不站得住。' +
      '这是标注不是动作 —— 不会改动 finding 的严重度或去留(剔除权在 reviewer 手里),' +
      '只把你的判据挂到它旁边给人看。' +
      '调用前必须先用 get_file / search_code 重新取回该 finding 引用的原文:凭印象下的裁决会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        [MCP_ARG.findingId]: { type: 'string', description: '要裁决的 finding id' },
        [MCP_ARG.verdict]: {
          type: 'string',
          enum: ['confirmed', 'refuted', 'cannot_verify'],
          description:
            'confirmed=重读原文后反例仍然成立;' +
            'refuted=不成立(前提不存在 / 已有 guard / 路径不可达 / 属可接受差异);' +
            'cannot_verify=取证不足以判定。**查无实据不等于成立**,拿不准就选它,不要凑成 confirmed',
        },
        note: {
          type: 'string',
          minLength: 1,
          description:
            '判据,必须自足:逐字引用你刚读回的关键行(带 file:line),说明它为什么支持这个裁决。' +
            'refuted 要指出保证这条不成立的那处代码在哪;cannot_verify 要说清缺的是哪一段证据。',
        },
      },
      required: [MCP_ARG.findingId, MCP_ARG.verdict, 'note'],
    },
  },
];

/**
 * 按 1 起、两端含的行区间截取。越界与倒置一律夹到合法范围(不报错):
 * agent 拿 search_code 的行号 ±N 算区间,边界附近必然算出 0 或超尾的值,
 * 为此回一个错误只会让它重试一次拿到同样的内容。
 *
 * 截出来的片段带上原始行号,否则 agent 读到的第 1 行其实是文件第 320 行,
 * 它据此写进 finding 的锚点就会整体偏移。
 */
function sliceLines(text: string, start?: number, end?: number): string {
  if (start == null && end == null) return text;
  const lines = text.split('\n');
  const from = Math.max(1, Math.floor(start ?? 1));
  const to = Math.min(lines.length, Math.floor(end ?? lines.length));
  if (from > lines.length || to < from) {
    return `(请求的行区间 ${from}-${to} 超出文件范围:该文件共 ${lines.length} 行)`;
  }
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join('\n');
}

/** search_code 只在 source 搜得了时声明(见 Source.searchCode 的注释)。 */
function toolsFor(providers: McpContentProviders): Tool[] {
  return providers.searchCode ? [...TOOLS] : TOOLS.filter((t) => t.name !== MCP_TOOL.searchCode);
}

/**
 * 搜索结果 → 给模型读的文本。**护栏做在返回值里,不做在 prompt 里** ——
 * prompt 层的告诫隔几万 token 就衰减了,返回值里的告诫在它做判断的那一刻被读到。
 *
 * 三件事必须回显:搜了什么(让 agent 看见自己的 typo)、总命中 vs 展示数(截断不能被
 * 误读成「就这么多」)、以及 0 命中时的免责句 —— 「没有调用点 ⇒ dead code」这个推理
 * 要在它发生的那一刻被拦住。
 */
function formatSearchResult(query: string, r: CodeSearchResult): string {
  const head = `search_code "${query}"(字面量,大小写敏感)`;
  if (r.total === 0) {
    return (
      `${head} — 0 命中。\n` +
      '注意:文本搜索命中不了动态调用、重导出、字符串拼接出来的引用,也可能是拼写或大小写不一致。' +
      '不能据此断言该符号不存在、该分支不可达或这段是 dead code。'
    );
  }
  const shown = r.files.reduce((n, f) => n + f.hits.length, 0);
  const capped = r.files.some((f) => f.hasMore) || r.moreFiles;
  // 命中数在 git 侧就按每文件截过,说「共 N 处」是假的 —— 截断过就只报展示数,
  // 别让 agent 把一个被截断的结果集当成全集去推「只有这几个调用点」。
  const lines = [
    capped ? `${head} — 以下 ${shown} 处(结果已截断,不是全部):` : `${head} — 共 ${shown} 处命中:`,
  ];
  for (const f of r.files) {
    lines.push(`\n${f.path}`);
    for (const h of f.hits) lines.push(`  ${h.line}: ${h.text}`);
    if (f.hasMore) lines.push('  …本文件还有更多命中未展示');
  }
  if (r.moreFiles) lines.push('\n…还有更多文件命中,读到上限就停了,请用 path_prefix 缩小范围');
  return lines.join('\n');
}

/**
 * Duetlens 对 codex 暴露的 in-process HTTP MCP server(StreamableHTTP)。
 * findings 经 report_finding 实时回传落进 app 状态,取代 1.0 watch 文件。
 *
 * 写 finding 的四个工具(report / update / dismiss / restore)在 `propose` 模式下不落库,
 * 改发 'finding-proposal';语义与模式切换见 {@link McpWriteMode}。
 *
 * 事件:'finding' (ReportedFinding) · 'finding-update' (ReportedFindingUpdate)
 * · 'finding-resolution' (ReportedFindingResolution) · 'finding-proposal' (ProposedFindingChange)
 * · 'finding-verdict' (JudgeFindingInput) · 'summary' (WriteSummaryInput) · 'tool-call' (name, args)。
 */
export class DuetlensMcpServer extends EventEmitter {
  private httpServer?: http.Server;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  readonly findings: ReportedFinding[] = [];
  /** 本 server 的 bearer 令牌;codex 经 bearer_token_env_var 携带,隔离本地其他进程。 */
  readonly token: string;
  private turn: TurnKind = 'scan';
  /**
   * 本 turn 内已实际取证过的文件。**由工具调用记账,不听 agent 自述** ——
   * 模型可以在散文里伪造一段引用,但伪造不了一次被后端记下的工具调用。
   * verdict 的硬闸就建在这上面(见 update_finding 的 verdict 分支)。
   */
  private readonly evidence = new Set<string>();

  private get writeMode(): McpWriteMode {
    return WRITE_MODE[this.turn];
  }

  constructor(private readonly providers: McpContentProviders, token: string = randomUUID()) {
    super();
    this.token = token;
  }

  /**
   * 切到某一类 turn(写语义、闸门与取证记账都随它)。由 ReviewSession 在每个 turn 前后设置;
   * turn 是串行的(见 ReviewSession.turnChain),故单个字段够用,不会有两个 turn 互相看到对方的语义。
   */
  setTurn(kind: TurnKind): void {
    this.turn = kind;
    // 取证记账按 turn 重置:自检轮要的是「**本轮**重新读过原文」,
    // 沿用上一轮的记录等于默许凭记忆写引用,硬闸就白设了。
    this.evidence.clear();
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

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolsFor(this.providers),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      this.emit('tool-call', name, args);

      if (name === MCP_TOOL.reportFinding) {
        const input = args as Omit<ReportedFinding, 'id'>;
        if (this.writeMode === 'propose') {
          // 提案同样要过 ingress 校验:直接落库那条路由 ReviewSession 兜着,提案这条没有 ——
          // 不校验的话非法 severity / 缺字段会一路存进 finding_proposals,采纳时才炸。
          const parsed = reportFindingSchema.safeParse(input);
          if (!parsed.success) return reject(MCP_TOOL.reportFinding, parsed.error);
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
      if (name === MCP_TOOL.updateFinding) {
        // 自检轮不得改动 finding 本体。取证硬闸设在 judge_finding 上,而这条路能改 severity /
        // 正文 / suggestion —— 不拦的话,「降个级」「在 body 里补一句存疑」就是一道绕开取证的侧门,
        // 而且直接改变了 reviewer 待处置与待提交的内容。那正是「裁决是标注不是动作」要护住的东西。
        //
        // resolve_finding 有意不在此列:它写的是本轮表态,是复审 turn 的正常产物,
        // 自检轮补一条漏掉的表态是合理的(note 必填且要求自足),它不碰 finding 本体。
        if (this.turn === 'selfcheck') {
          return {
            content: [
              {
                type: 'text',
                text: `自检轮不改动 finding 本体。判它不成立请用 ${MCP_TOOL.judgeFinding}(判据会挂在它旁边给 reviewer 看);发现的是**新**问题就用 ${MCP_TOOL.reportFinding} 另报一条。`,
              },
            ],
            isError: true,
          };
        }
        const a = args as Record<string, unknown>;
        const update: ReportedFindingUpdate = {
          findingId: String(a[MCP_ARG.findingId] ?? ''),
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
          if (!parsed.success) return reject(MCP_TOOL.updateFinding, parsed.error);
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
      if (name === MCP_TOOL.dismissFinding || name === MCP_TOOL.restoreFinding) {
        const a = args as Record<string, unknown>;
        const kind = name === MCP_TOOL.dismissFinding ? 'dismiss' : 'restore';
        // 剔除/恢复始终是 reviewer 的判断,只在他在场的讨论里作为提案提出。机审轮没有人可确认,
        // 就地放行等于让 agent 自己关掉自己报的问题(rerun.md:连 wont_fix 都不自动剔除)。
        if (this.writeMode !== 'propose') {
          return {
            content: [
              {
                type: 'text',
                text: `${name} 只能在与 reviewer 的讨论中使用(剔除是 reviewer 的判断)。自检轮请改用 ${MCP_TOOL.judgeFinding} 判 refuted 并写清判据 —— 它会把你的结论挂在 finding 旁边给人看,而不是替人做决定。`,
              },
            ],
            isError: true,
          };
        }
        // 理由是这两个动作的**全部**内容(剔除不改正文,恢复不改任何字段),空理由等于什么也没提;
        // 且它会注入下一轮复审,静默收下只会让下一轮拿到一条没有依据的抑制项。
        const schema = kind === 'dismiss' ? dismissFindingSchema : restoreFindingSchema;
        const parsed = schema.safeParse({
          findingId: String(a[MCP_ARG.findingId] ?? ''),
          reason: String(a.reason ?? '').trim(),
        } satisfies ReportedFindingTriage);
        if (!parsed.success) return reject(name, parsed.error);
        return this.propose(
          { kind, findingId: parsed.data.findingId, patch: { reason: parsed.data.reason } },
          kind === 'dismiss' ? '剔除这条 finding' : '恢复这条 finding',
        );
      }
      if (name === MCP_TOOL.resolveFinding) {
        const a = args as Record<string, unknown>;
        const resolution: ReportedFindingResolution = {
          findingId: String(a[MCP_ARG.findingId] ?? ''),
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
      if (name === MCP_TOOL.writeSummary) {
        // 总结是机审那一轮的收尾结论,记着它写于第几轮;讨论轮放行会让一句追问顶掉
        // 本轮的总结,还把轮次刷成"已重写"。这一轮的看法说进回复即可。
        if (this.writeMode === 'propose') {
          return {
            content: [
              {
                type: 'text',
                text: 'write_summary 只在机审收尾时调用。讨论中请把结论写进回复,由 reviewer 决定是否改总结。',
              },
            ],
            isError: true,
          };
        }
        const parsed = writeSummarySchema.safeParse(args);
        if (!parsed.success) return reject(MCP_TOOL.writeSummary, parsed.error);
        this.emit('summary', parsed.data);
        const n = parsed.data.files.length;
        return {
          content: [{ type: 'text', text: `summary recorded${n ? `, ${n} file(s) flagged` : ''}` }],
        };
      }
      if (name === MCP_TOOL.judgeFinding) {
        // 裁决只在自检轮成立。首轮放行的话,agent 会给自己刚写的 finding 盖一个 confirmed ——
        // 自我确认的墨水会把「裁决过的条目最终被 reviewer 怎么处置」这份数据整个稀释掉。
        if (this.turn !== 'selfcheck') {
          return {
            content: [
              {
                type: 'text',
                text: `${MCP_TOOL.judgeFinding} 只在对抗自检轮可用。首轮请专心上报;讨论轮请用 dismiss_finding / update_finding。`,
              },
            ],
            isError: true,
          };
        }
        const a = args as Record<string, unknown>;
        const parsed = judgeFindingSchema.safeParse({
          findingId: String(a[MCP_ARG.findingId] ?? ''),
          verdict: a[MCP_ARG.verdict],
          note: a.note,
        });
        if (!parsed.success) return reject(MCP_TOOL.judgeFinding, parsed.error);
        // 取证硬闸。散文里的引用可以是编的,一次被记账的 get_file / search_code 不能 ——
        // 工具错误会回到模型手里,它下一步就会真的去读原文,这正是我们要的。
        // 解析限定在本 review 内(见 McpContentProviders.findingFile)。查不到就是查不到 ——
        // 从前这里把「不存在」与「无需取证」都折叠成放行,于是未知 id 既绕过取证闸、又拿到一句
        // recorded;而**别的 review** 的有效 id 更会一路写到那条 finding 上去。
        const file = this.providers.findingFile?.(parsed.data.findingId) ?? null;
        if (!file) {
          return {
            content: [
              {
                type: 'text',
                text: `裁决未记录:本次审核里没有 id=${parsed.data.findingId} 这条 finding。请从自检指令给出的清单里取 id。`,
              },
            ],
            isError: true,
          };
        }
        if (!this.evidence.has(file)) {
          return {
            content: [
              {
                type: 'text',
                text: `裁决未记录:本轮还没有对 ${file} 取证。请先 get_file(带行区间)或 search_code 重新读回该 finding 引用的原文,再下裁决 —— 不要凭首轮的印象。`,
              },
            ],
            isError: true,
          };
        }
        this.emit('finding-verdict', parsed.data);
        return {
          content: [
            { type: 'text', text: `verdict recorded: ${parsed.data.verdict}, id=${parsed.data.findingId}` },
          ],
        };
      }
      if (name === MCP_TOOL.getDiff) {
        return { content: [{ type: 'text', text: await this.providers.getDiff() }] };
      }
      if (name === MCP_TOOL.getFile) {
        const a = args as { path?: string; start?: number; end?: number };
        const path = String(a.path ?? '');
        let full: string;
        try {
          full = await this.providers.getFile(path);
        } catch (e) {
          // 读不到就别记账:取证闸问的是「你真读到原文了吗」,一次失败的读取回答不了这个。
          return {
            content: [{ type: 'text', text: `读取失败:${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
        this.evidence.add(path);
        return { content: [{ type: 'text', text: sliceLines(full, a.start, a.end) }] };
      }
      if (name === MCP_TOOL.searchCode) {
        const search = this.providers.searchCode;
        // 工具本就不声明(toolsFor),真调到这里说明 agent 在凭想象调用 —— 说清搜不了,
        // 别让它把这次失败读成「搜过了,没有」。
        if (!search) {
          return {
            content: [
              {
                type: 'text',
                text: '本次审核的代码来源不支持搜索(无本地代码树)。这不是「没搜到」——请改用 get_diff / get_file 取证,不要据此推断符号不存在。',
              },
            ],
            isError: true,
          };
        }
        const a = args as Record<string, unknown>;
        const query = String(a[MCP_ARG.query] ?? '').trim();
        if (!query) {
          return {
            content: [{ type: 'text', text: 'search_code 需要非空的 query。' }],
            isError: true,
          };
        }
        const prefix = typeof a.path_prefix === 'string' ? a.path_prefix : undefined;
        let result: CodeSearchResult;
        try {
          result = await search({ query, pathPrefix: prefix });
        } catch (e) {
          // 搜索**没跑成**与「搜了没有」必须分开告诉 agent,否则它会拿一次失败当作
          // 「代码里没有」的证据 —— 那正是这个工具要拦的反向幻觉。
          return {
            content: [
              {
                type: 'text',
                text: `${e instanceof Error ? e.message : String(e)}。这不是「没搜到」—— 请用 path_prefix 缩小范围或换更具体的字面量重试,不要据此推断符号不存在。`,
              },
            ],
            isError: true,
          };
        }
        // 命中的文件计入取证:闸门问的是「本轮是否真去查过原文」,不是「读没读全」。
        // 覆盖面计量是另一回事,在 renderer 的 ActivityLog.paths,那边只认 get_file。
        for (const f of result.files) this.evidence.add(f.path);
        return { content: [{ type: 'text', text: formatSearchResult(query, result) }] };
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
