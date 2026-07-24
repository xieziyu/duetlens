/**
 * 审核规则提示词的分层模型:project ▸ global ▸ builtin,**按节独立覆盖**。
 * 合并结果注入 codex `thread/start · baseInstructions`(见 docs/design/ui.md 三层编辑器、
 * codex-integration.md)。类型放 shared:后端做合并、renderer 三层编辑器消费。
 *
 * 可配置面只覆盖「审核口径」;与 MCP 工具契约相关的段落(角色/工具流程/上报字段协议)
 * 是**锁定段**,既不进本模型、也不下发给 renderer —— 见 backend/prompt/review-prompt.ts。
 */
import { FINDING_CATEGORIES, type FindingCategory } from './domain';

export const PROMPT_SECTION_KEYS = ['focus', 'severity', 'ignore', 'tone', 'context'] as const;
export type PromptSectionKey = (typeof PROMPT_SECTION_KEYS)[number];

export const PROMPT_LAYERS = ['project', 'global', 'builtin'] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

/**
 * free = 整节一块自由文本;
 * structured = 字段集固定(字段名锁死、不可增删改名),只有每个字段的正文可改。
 * severity 与 focus 走 structured:severity 的档位 `high/medium/low` 是 MCP ingress 的枚举;
 * focus 的字段就是 FINDING_CATEGORIES —— 逐类别独立覆盖,类别集与 finding 分类同源、不会漂移。
 */
export type PromptSectionKind = 'free' | 'structured';

/** structured 节里的一个字段(如 severity 的 high 档)的三层原文 + winner。 */
export interface PromptFieldSection {
  id: string;
  label: string;
  builtin: string;
  global: string | null;
  project: string | null;
  winner: PromptLayer;
}

/** 合并后某一节的生效值 + 来源层(provenance)。 */
export interface ResolvedPromptSection {
  key: PromptSectionKey;
  title: string;
  kind: PromptSectionKind;
  text: string;
  /** structured 节取字段里最具体的那层;用于右栏整节徽标。 */
  source: PromptLayer;
  /** kind='structured' 时逐字段的生效值,供右栏逐档标来源。 */
  fields?: { id: string; label: string; text: string; source: PromptLayer }[];
}

/** 三层编辑器视图:一节的三层原文 + 当前 winner(project 有则 project,否则 global,否则 builtin)。 */
export interface PromptLayerSection {
  key: PromptSectionKey;
  title: string;
  kind: PromptSectionKind;
  /** 这一节控制什么(编辑器副标题),让用户不必猜 */
  hint: string;
  builtin: string;
  global: string | null;
  project: string | null;
  winner: PromptLayer;
  /** kind='structured' 时的字段三层原文;free 节为 undefined。 */
  fields?: PromptFieldSection[];
}

export interface ReviewPromptView {
  sections: PromptLayerSection[];
  /** project 层文件绝对路径;无 cwd(未选仓库)时为 null,此时 project 层不可编辑。 */
  projectPath: string | null;
  /** global 层文件绝对路径(`~/.duetlens/review.md`)。 */
  globalPath: string;
}

/** 可编辑的两层(builtin 只读);编辑器写回其一。 */
export type EditablePromptLayer = Exclude<PromptLayer, 'builtin'>;

/** 写回一层 review.md 的入参:sections 为该层的全部覆盖(缺/空节=不覆盖,整层重写)。 */
export interface PromptSaveInput {
  layer: EditablePromptLayer;
  /** project 层落 `<cwd>/.duetlens/review.md`;global 层忽略此字段。 */
  cwd?: string;
  /** structured 节(focus / severity)的值为 serializeKeyedFields 的产物。 */
  sections: Partial<Record<PromptSectionKey, string>>;
}

// ---- structured 节的字段编解码(renderer 与 backend 共用,保证落盘格式单一来源)----

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * structured 节正文 ⇄ 逐字段正文。落盘形如 `- <id>: <正文>`,一字段一行。
 * 字段 id 由节固定(SectionDef.fields),解析只认这些 id、认不出的行忽略 ——
 * 老版本或手写的自由文本因此不会以"覆盖了却什么也没说"的形式卡在中间层。
 * aliases 收编历史/简写写法(如 severity 的 `med`→`medium`),使旧 review.md 不失效;
 * 分隔符兼容 `:` `=` `:`(旧 `high = ...` 写法),不区分大小写。
 */
export function parseKeyedFields(
  text: string,
  ids: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const canon = new Map<string, string>();
  for (const id of ids) canon.set(id.toLowerCase(), id);
  for (const [k, v] of Object.entries(aliases)) canon.set(k.toLowerCase(), v);
  // 长 id 优先,避免 `med` 抢在 `medium` 前、或短类别名吃掉长类别名。
  const alt = [...canon.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const re = new RegExp(`^\\s*[-*]?\\s*(${alt})\\s*[:=:]\\s*(.+?)[;;。]?\\s*$`, 'i');
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const id = canon.get(m[1].toLowerCase());
    const body = m[2].trim();
    if (id && body && !(id in out)) out[id] = body;
  }
  return out;
}

/** 逐字段正文 → 节正文。按给定 id 顺序,空字段略去;正文压成单行(逐行=逐字段)。 */
export function serializeKeyedFields(
  values: Readonly<Record<string, string | undefined>>,
  ids: readonly string[],
): string {
  return ids
    .map((id) => {
      const text = values[id]?.replace(/\s*\n\s*/g, ' ').trim();
      return text ? `- ${id}: ${text}` : null;
    })
    .filter((l): l is string => l != null)
    .join('\n');
}

/**
 * structured 节的一层原文 → 规范化文本(只保留识别得出的字段)。
 * 无法解析出任何字段的正文一律当**未覆盖**,返回 null,让下层生效。
 */
export function normalizeStructuredText(
  raw: string | null | undefined,
  ids: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  if (raw == null) return null;
  const text = serializeKeyedFields(parseKeyedFields(raw, ids, aliases), ids);
  return text || null;
}
// ---- 内置基线与合并(纯函数;backend 做 IO,renderer preview 直接复用同一份)----

interface SectionDef {
  key: PromptSectionKey;
  title: string;
  kind: PromptSectionKind;
  /** 编辑器副标题:这一节控制什么 */
  hint: string;
  /** free 节的内置默认;structured 节留空,默认值放 fields */
  builtin: string;
  /** structured 节的固定字段(id 锁死,用户只能改正文) */
  fields?: readonly { id: string; label: string; builtin: string }[];
  /** structured 节解析时收编的历史/简写别名(如 severity 的 `med`→`medium`);free 节无。 */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * focus 逐类别的内置审核要点。字段 id 直接取 FINDING_CATEGORIES ——
 * Record<FindingCategory> 让编译器强制每个类别都有要点,focus 类别集与 finding 分类同源、不会漂移。
 * 要点与语言、框架无关;举例前后端各给一种形态,套用贴合实际代码的那种。
 * 「先判断改动属于哪类代码、只报真实问题」等总则不在此,由锁定的角色段统一交代(见 review-prompt.ts)。
 */
const FOCUS_GUIDANCE: Record<FindingCategory, string> = {
  Scope: '改动目标之外夹带的无关变更;需求 / PR 描述承诺、但 diff 未实现的缺失部分。',
  Correctness:
    '空值与边界缺保护(null / undefined / 空集合 / 越界 / 除零);资源未释放(连接 / 文件 / 句柄未关,监听 / 订阅 / 定时器未清,组件卸载后仍写状态);并发与时序(共享状态无同步、未 await 的异步、依赖渲染 / 回调 / 事件顺序的隐含假设);逻辑错误(off-by-one、条件写反、参数顺序、漏掉某分支)。',
  'Type Safety':
    '绕过静态检查的逃生口(类型断言 / 忽略告警 / 强制转型 / 无依据的非空断言,各语言形式不同);声明类型与实际数据形状不符;接口 / props / 数据模型的字段类型对不上消费方。动态类型代码看契约与运行期校验。',
  Security:
    '未净化输入导致的注入(SQL / NoSQL / command / 路径穿越,及前端 XSS / 危险 innerHTML / 动态 eval);鉴权与越权(后端 endpoint 缺 authn / authz / 租户隔离,前端把访问控制只做在 UI 层);敏感信息泄漏(secret / token / PII 落日志或响应体,或被打进前端产物 / 提交进仓库);依赖的已知漏洞与可疑来源。',
  Architecture:
    '边界与依赖方向(模块 / 分层 / 组件职责不互相渗透,依赖不反向、不绕过约定入口);重复逻辑(先查是否已有同类实现或工具);契约一致性(接口 / 事件 / 数据模型对齐存储或消费方,标 dead field 与不再走到的分支)。',
  Performance:
    '批量化远程调用(后端 N+1 与循环内可合并的 DB / RPC,前端瀑布式请求与缺失的缓存 / 复用);渲染与响应(前端不必要的重渲染 / 重排、过大的产物或资源,后端热路径的多余分配);真实数据规模下的算法复杂度,以及可增长数据集上无上限的读取。',
  Naming: '命名自描述且与相邻代码一致(单复数、词序、术语统一);避免误导性、过度缩写或与含义不符的名字。',
  Complexity:
    '深嵌套 / 超长函数 / 上帝模块,建议抽 helper 或 early return;魔法值挪常量;可直接删并的冗余分支与重复判断。',
  'Error Handling':
    '被吞的错误(空 catch、静默吞掉不 rethrow 不 log);错误缺定位上下文;对外边界返回结构化 / 领域化的错误,不外泄堆栈与内部细节。',
};

/**
 * 可覆盖的固定几节 + builtin 默认。
 * context 无内置默认,由 project 补充仓库背景;focus / severity 是 structured —— 字段名锁死,只开放各字段正文。
 */
export const BUILTIN_SECTIONS: readonly SectionDef[] = [
  {
    key: 'focus',
    title: '审核重点',
    kind: 'structured',
    hint: '每个类别看什么。',
    builtin: '',
    fields: FINDING_CATEGORIES.map((c) => ({ id: c, label: c, builtin: FOCUS_GUIDANCE[c] })),
  },
  {
    key: 'severity',
    title: '严重度判定',
    kind: 'structured',
    hint: '每一档收什么问题。',
    builtin: '',
    fields: [
      { id: 'high', label: 'high', builtin: '崩溃 / 数据损坏 / 安全问题' },
      { id: 'medium', label: 'medium', builtin: '边界 / 健壮性 / 可维护性隐患' },
      { id: 'low', label: 'low', builtin: '风格 / 命名 / 可读性' },
    ],
    aliases: { med: 'medium' },
  },
  {
    key: 'ignore',
    title: '忽略范围',
    kind: 'free',
    hint: '哪些改动不必上报,用来压掉噪声。',
    builtin: '忽略纯格式化、生成文件、lockfile、无语义的行重排。',
  },
  {
    key: 'tone',
    title: '输出与语气',
    kind: 'free',
    hint: 'finding 正文的语言与措辞;不影响字段结构。',
    builtin:
      'finding 正文用简体中文,代码标识符 / 路径 / category 名保留英文原词;\n' +
      '先说问题与影响,再说怎么改;不要写「建议优化」这类没有落点的结论。',
  },
  {
    key: 'context',
    title: '项目上下文',
    kind: 'free',
    hint: '本仓库的技术栈、约定与历史包袱。无内置默认,由你补充。',
    builtin: '',
  },
];


function pickLayer(project: string | null, global: string | null): PromptLayer {
  return project != null ? 'project' : global != null ? 'global' : 'builtin';
}

/** 按节合并三层:每节独立取 project ▸ global ▸ builtin;structured 节逐字段独立取。 */
export function mergeLayers(
  project: Partial<Record<PromptSectionKey, string>>,
  global: Partial<Record<PromptSectionKey, string>>,
): { sections: PromptLayerSection[]; resolved: ResolvedPromptSection[] } {
  const sections: PromptLayerSection[] = [];
  const resolved: ResolvedPromptSection[] = [];
  for (const def of BUILTIN_SECTIONS) {
    if (def.kind === 'structured') {
      const ids = (def.fields ?? []).map((f) => f.id);
      const aliases = def.aliases ?? {};
      const p = normalizeStructuredText(project[def.key], ids, aliases);
      const g = normalizeStructuredText(global[def.key], ids, aliases);
      const pFields = p ? parseKeyedFields(p, ids, aliases) : {};
      const gFields = g ? parseKeyedFields(g, ids, aliases) : {};
      const fields: PromptFieldSection[] = [];
      const resolvedFields: NonNullable<ResolvedPromptSection['fields']> = [];
      const resolvedValues: Record<string, string> = {};
      for (const f of def.fields ?? []) {
        const fp = pFields[f.id] ?? null;
        const fg = gFields[f.id] ?? null;
        const winner = pickLayer(fp, fg);
        fields.push({ id: f.id, label: f.label, builtin: f.builtin, global: fg, project: fp, winner });
        const text = fp ?? fg ?? f.builtin;
        resolvedFields.push({ id: f.id, label: f.label, text, source: winner });
        resolvedValues[f.id] = text;
      }
      // 整节 provenance 取字段里最具体的一层:任一档被 project 改过,整节就算 project 覆盖。
      const source: PromptLayer = resolvedFields.some((f) => f.source === 'project')
        ? 'project'
        : resolvedFields.some((f) => f.source === 'global')
          ? 'global'
          : 'builtin';
      sections.push({
        key: def.key,
        title: def.title,
        kind: def.kind,
        hint: def.hint,
        builtin: serializeKeyedFields(
          Object.fromEntries((def.fields ?? []).map((f) => [f.id, f.builtin])),
          ids,
        ),
        global: g,
        project: p,
        winner: source,
        fields,
      });
      resolved.push({
        key: def.key,
        title: def.title,
        kind: def.kind,
        text: serializeKeyedFields(resolvedValues, ids),
        source,
        fields: resolvedFields,
      });
      continue;
    }
    const p = project[def.key] ?? null;
    const g = global[def.key] ?? null;
    const source = pickLayer(p, g);
    sections.push({
      key: def.key,
      title: def.title,
      kind: def.kind,
      hint: def.hint,
      builtin: def.builtin,
      global: g,
      project: p,
      winner: source,
    });
    resolved.push({
      key: def.key,
      title: def.title,
      kind: def.kind,
      text: p ?? g ?? def.builtin,
      source,
    });
  }
  return { sections, resolved };
}

