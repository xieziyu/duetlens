/**
 * 机审期「agent 在做什么」的活动流(纯函数)—— 进度条的实时行、展开区的动作流、
 * 右栏扫描空态三处共用同一份派生,免得三处对「它刚干了什么」各说一套。
 *
 * 只由 agent 已上报的事件派生:工具调用的参数、codex 自己解析好的命令动作、web 检索。
 * **不臆造后端没有的粒度** —— 推理摘要在实测里拿不到(见 docs/design/codex-integration.md),
 * 所以这里报的一律是动作,不是意图。
 */
import type { AgentEvent, CommandAction } from '@shared/agent-events';
import { MCP_ARG, MCP_TOOL } from '@shared/mcp-contract';

export type ActivityKind =
  | 'read'
  | 'search'
  | 'list'
  | 'diff'
  | 'finding'
  | 'web'
  | 'shell'
  | 'tool'
  /** 不是 agent 的动作,是编排层的一句交代(如「对抗档跳过了自检轮」) */
  | 'note';

export interface Activity {
  kind: ActivityKind;
  /** 展示对象:文件路径 / 检索式 / finding 摘要 */
  text: string;
  /** 动作开始的时刻(renderer 侧收到 started 时);动作流的时标按它排 */
  at: number;
  /**
   * 动作收到终局的时刻。与 {@link at} 必须分开存:
   * 收尾后要报的是「空转了多久」,拿 `at` 算会把一条跑了 30s 的命令,
   * 在它刚结束的瞬间显示成「思考中 00:30」—— 正好把慢调用误报成静默。
   */
  endedAt?: number;
  /** 同一动作连着重复的次数;1 表示没有重复 */
  count: number;
  /** agent 上报的本次动作耗时;未完成时为空 */
  durationMs?: number;
  /** 涉及的仓库文件,供覆盖计量求交;非文件动作为空 */
  path?: string;
  /** 已收到终局(completed / failed);未完成的那条就是「正在做」的 */
  done: boolean;
}

/**
 * 展示历史的上限。实测每轮动作 median 17 / p99 67 / max 77(212 次真实机审),
 * 取 200 是让「回看一整轮」在尾部轮次也成立,而不是刚好卡在观测最大值上。
 * 截断只影响展示 —— 累计覆盖走 {@link ActivityLog.paths},不受它影响。
 */
export const ACTIVITY_LIMIT = 200;

/**
 * 一轮的活动状态。展示历史有上限,累计取证路径没有 ——
 * 两者合在一个数组里的话,列表一截断,覆盖计量就会**倒退**(已取证的文件重新变成未取证)。
 */
export interface ActivityLog {
  items: Activity[];
  /** 本轮取证过的路径全集;只增不减,不随 items 截断丢失 */
  paths: ReadonlySet<string>;
}

export const EMPTY_ACTIVITY_LOG: ActivityLog = { items: [], paths: new Set() };

const ACTIVITY_VERB: Record<ActivityKind, string> = {
  read: '读',
  search: '检索',
  list: '列目录',
  diff: '取改动',
  finding: '上报',
  web: '联网查',
  shell: '执行',
  tool: '调用',
  note: '',
};

export const activityVerb = (k: ActivityKind): string => ACTIVITY_VERB[k];

/** 事件归一出的一条待并入项;`done` 决定它是新起一条还是给在跑的那条收尾。 */
interface Derived {
  kind: ActivityKind;
  text: string;
  path?: string;
  durationMs?: number;
  done: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const isDone = (status: string): boolean => status !== 'inProgress' && status !== 'in_progress';

/** MCP 工具调用 → 活动。参数里那半才是信息:光说「调用了 get_file」等于没说。 */
function fromTool(ev: Extract<AgentEvent, { kind: 'tool-call' }>): Derived | null {
  const a = (ev.args ?? {}) as Record<string, unknown>;
  const done = isDone(ev.status);
  const base = { durationMs: ev.durationMs, done };
  switch (ev.tool) {
    case MCP_TOOL.getFile: {
      const path = str(a[MCP_ARG.path]);
      return { ...base, kind: 'read', text: path ?? '(未指名文件)', path };
    }
    case MCP_TOOL.getDiff:
      return { ...base, kind: 'diff', text: '本次改动全量 diff' };
    case MCP_TOOL.reportFinding:
    case MCP_TOOL.updateFinding: {
      const sev = str(a[MCP_ARG.severity]);
      // update_finding 没有 file 字段(见 duetlens-mcp-server 的 TOOLS),故只能回落到通名
      const title = str(a[MCP_ARG.title]) ?? str(a[MCP_ARG.file]) ?? '一条 finding';
      // **不设 path**:上报是产出,不是取证。diff 是整份给的,agent 没读过原文也报得出 finding,
      // 算进覆盖就会把「零取证却下了结论」的文件显示成已取证 —— 那恰恰是最该被看见的情况。
      return { ...base, kind: 'finding', text: sev ? `${sev} · ${title}` : title };
    }
    case MCP_TOOL.resolveFinding:
    case MCP_TOOL.dismissFinding:
    case MCP_TOOL.restoreFinding: {
      // 复审轮真正值得看的是表态本身,故 status 排在 id 前面
      const parts = [ev.tool, str(a[MCP_ARG.status]), str(a[MCP_ARG.findingId])].filter(Boolean);
      return { ...base, kind: 'finding', text: parts.join(' · ') };
    }
    case MCP_TOOL.searchCode: {
      const q = str(a[MCP_ARG.query]);
      return { ...base, kind: 'search', text: q ? `代码里搜「${q}」` : '代码检索' };
    }
    case MCP_TOOL.judgeFinding: {
      // 裁决本身才是信息(哪条被判不成立);id 排在后面,截断时先丢它
      const parts = ['裁决', str(a[MCP_ARG.verdict]), str(a[MCP_ARG.findingId])].filter(Boolean);
      return { ...base, kind: 'finding', text: parts.join(' · ') };
    }
    case MCP_TOOL.writeSummary:
      return { ...base, kind: 'tool', text: '写入本轮总结' };
    default:
      return { ...base, kind: 'tool', text: `${ev.server}/${ev.tool}` };
  }
}

/**
 * 一条命令可能解析出好几段动作(管道)。取**第一个认得出的**那段来讲 ——
 * 讲全会把一行变成一段话,而进度条只有一行的位置;全不认得就退回原始命令。
 */
function fromCommand(ev: Extract<AgentEvent, { kind: 'command' }>): Derived {
  const done = isDone(ev.status);
  const base = { durationMs: ev.durationMs, done };
  const known = ev.actions.find((a: CommandAction) => a.type !== 'other');
  if (known?.type === 'read') return { ...base, kind: 'read', text: known.path, path: known.path };
  if (known?.type === 'search') {
    const where = known.path ? ` ${known.path}` : '';
    // path 要透传进覆盖计量:检索范围是目录时(如 `rg foo src/`)后缀匹配自然对不上任何
    // 改动文件,不会误增;点名到具体文件时才计入,与 title 说的「被检索命中」一致
    return { ...base, kind: 'search', text: `${known.query ?? ev.command}${where}`, path: known.path };
  }
  if (known?.type === 'list') return { ...base, kind: 'list', text: known.path ?? ev.command };
  return { ...base, kind: 'shell', text: ev.command };
}

function derive(ev: AgentEvent): Derived | null {
  if (ev.kind === 'tool-call') return fromTool(ev);
  if (ev.kind === 'command') return fromCommand(ev);
  if (ev.kind === 'web-search')
    return { kind: 'web', text: ev.query || '(未指名检索词)', done: isDone(ev.status) };
  return null;
}

/**
 * 把一条 agent 事件并进活动流。返回新数组(未产生变化时返回原数组,省掉一次重渲染)。
 *
 * 每个动作会来两次(item/started 与 item/completed),所以 `done` 的那次要去**给在跑的那条收尾**,
 * 而不是再追加一条 —— 否则每个动作在流里都是双份,且「正在做」永远指着已经做完的事。
 */
/**
 * 追加一条编排层的注记。走同一条流是因为用户在那里看「这一轮发生了什么」——
 * 该发生却没发生的事(跳过的自检轮)不摆在这里,就成了一段无从解释的空白。
 */
export function appendNote(log: ActivityLog, text: string, now: number): ActivityLog {
  const item: Activity = { kind: 'note', text, at: now, endedAt: now, count: 1, done: true };
  const next = [...log.items, item];
  return {
    items: next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next,
    paths: log.paths,
  };
}

export function pushActivity(log: ActivityLog, ev: AgentEvent, now: number): ActivityLog {
  const d = derive(ev);
  if (!d) return log;

  const list = log.items;
  // 覆盖是累计的,所以路径在这里就并进去 —— 晚于下面的截断收集就会漏掉被截走的那些
  const paths = d.path && !log.paths.has(d.path) ? new Set(log.paths).add(d.path) : log.paths;
  const wrap = (items: Activity[]): ActivityLog => (items === list && paths === log.paths ? log : { items, paths });

  if (d.done) {
    // 倒着找同一动作里还没收尾的那条:批量取文件是并发的,末条不一定就是它
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i];
      if (x.done || x.kind !== d.kind || x.text !== d.text) continue;
      const next = list.slice();
      next[i] = { ...x, done: true, endedAt: now, durationMs: d.durationMs ?? x.durationMs };
      return wrap(next);
    }
  } else {
    // 同一条重复上报(started 收到两次)不追加,只是还没结束
    const last = list[list.length - 1];
    if (last && !last.done && last.kind === d.kind && last.text === d.text) return wrap(list);
  }

  // 连着做同一件事(如反复读同一文件)折成计数,不刷屏
  const last = list[list.length - 1];
  if (last && last.kind === d.kind && last.text === d.text) {
    const next = list.slice();
    next[next.length - 1] = {
      ...last,
      count: last.count + 1,
      at: now,
      done: d.done,
      endedAt: d.done ? now : undefined,
      durationMs: d.durationMs ?? last.durationMs,
    };
    return wrap(next);
  }

  const item: Activity = {
    kind: d.kind,
    text: d.text,
    path: d.path,
    at: now,
    endedAt: d.done ? now : undefined,
    count: 1,
    durationMs: d.durationMs,
    done: d.done,
  };
  const next = [...list, item];
  return wrap(next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next);
}

/**
 * 改动文件的取证覆盖:diff 里的文件被 agent 读过(或被检索点名)就算覆盖。
 *
 * 吃的是 {@link ActivityLog.paths} 而不是展示列表 —— 后者有上限,拿它算会让覆盖数倒退。
 * **这个数跑满不等于扫描结束**,它只是覆盖面,不是完成度(调用处的文案与 title 都必须这么说)。
 *
 * 匹配是**有意不对称的,别去"补齐"另一半**:
 * - 取证路径比 diff 路径长 → 认(`/abs/repo/src/x.ts` 对 `src/x.ts`)。diff 路径本身就是
 *   完整的仓库相对路径,能匹到它的整条尾巴,基本只可能是同一个文件。
 * - 取证路径比 diff 路径短 → **不认**。agent 在子目录里 `cat index.ts` 时取证路径是个裸文件名,
 *   反向后缀匹配会把 `src/index.ts`、`packages/a/index.ts` 一次性全标成已取证。
 *   宁可少算(覆盖面偏保守)也不能多算 —— 多算是在替 agent 声称它看过根本没看过的文件。
 */
export function coveredFiles(diffPaths: readonly string[], touched: ReadonlySet<string>): number {
  if (touched.size === 0) return 0;
  const seen = [...touched];
  return diffPaths.filter((f) => seen.some((t) => t === f || t.endsWith(`/${f}`))).length;
}

/** 当前正在做的那条(没有未完成项时退回最后一条);空流为 null。 */
export function currentActivity(list: readonly Activity[]): Activity | null {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].done) return list[i];
  return list.length ? list[list.length - 1] : null;
}
