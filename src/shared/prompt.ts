/**
 * 审核规则提示词的分层模型:project ▸ global ▸ builtin,**按节独立覆盖**。
 * 合并结果注入 codex `thread/start · baseInstructions`(见 docs/design/ui.md 三层编辑器、
 * codex-integration.md)。类型放 shared:后端做合并、renderer 三层编辑器消费。
 *
 * 可配置面只覆盖「审核口径」;与 MCP 工具契约相关的段落(角色/工具流程/上报字段协议)
 * 是**锁定段**,既不进本模型、也不下发给 renderer —— 见 backend/prompt/review-prompt.ts。
 */
import { SEVERITIES, type Severity } from './domain';

export const PROMPT_SECTION_KEYS = ['focus', 'severity', 'ignore', 'tone', 'context'] as const;
export type PromptSectionKey = (typeof PROMPT_SECTION_KEYS)[number];

export const PROMPT_LAYERS = ['project', 'global', 'builtin'] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

/**
 * free = 整节一块自由文本;
 * structured = 字段集固定(字段名锁死、不可增删改名),只有每个字段的正文可改。
 * severity 走 structured:`high/medium/low` 是 MCP ingress 的枚举,改名即导致上报被拒。
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
  /** structured 节(severity)的值为 serializeSeverityLevels 的产物。 */
  sections: Partial<Record<PromptSectionKey, string>>;
}

// ---- structured 节的字段编解码(renderer 与 backend 共用,保证落盘格式单一来源)----

/**
 * severity 节正文 ⇄ 逐档判定标准。落盘形如 `- high: 崩溃 / 数据损坏`。
 * 兼容旧的 `high = ...` 写法(2.0 早期 builtin 的格式)与 `med` 简写,免得升级后旧文件整节失效。
 */
export function parseSeverityLevels(text: string): Partial<Record<Severity, string>> {
  const out: Partial<Record<Severity, string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*(high|medium|med|low)\s*[:=:]\s*(.+?)[;;。]?\s*$/i.exec(raw);
    if (!m) continue;
    const level = (m[1].toLowerCase() === 'med' ? 'medium' : m[1].toLowerCase()) as Severity;
    const body = m[2].trim();
    if (body && !out[level]) out[level] = body;
  }
  return out;
}

/** 逐档判定标准 → 节正文。按 SEVERITIES 固定顺序,空档略去;正文压成单行(逐行=逐档)。 */
export function serializeSeverityLevels(levels: Partial<Record<Severity, string>>): string {
  return SEVERITIES.map((s) => {
    const text = levels[s]?.replace(/\s*\n\s*/g, ' ').trim();
    return text ? `- ${s}: ${text}` : null;
  })
    .filter((l): l is string => l != null)
    .join('\n');
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
}

/**
 * 可覆盖的固定几节 + builtin 默认。
 * context 无内置默认,由 project 补充仓库背景;severity 是 structured —— 档位名锁死,只开放判定标准。
 */
export const BUILTIN_SECTIONS: readonly SectionDef[] = [
  {
    key: 'focus',
    title: '审核重点',
    kind: 'free',
    hint: '优先看什么、按哪些维度过一遍改动。',
    builtin: `按以下类别审查改动,只报告需要修复的真实问题;把偏离分为有理由的改进 / 可接受的差异 / 有问题的偏离,只标最后一种。
- Scope 范围对齐:PR 描述之外夹带的无关改动;body 承诺但 diff 未实现的缺失部分。
- Correctness 正确性:绕过类型检查的逃生口(as any / @ts-ignore / 无依据的非空断言 / 骗过运行时形状的 cast);null / undefined 缺保护;资源泄漏(未关的 stream / 连接 / 句柄、未移除的监听、未清的 timer);竞态(共享状态并发无同步、请求路径未 await 的 promise);逻辑错误(off-by-one、比较写反、参数顺序、漏掉某分支)。
- Security 安全:注入(SQL / NoSQL / XSS / command / 路径穿越,源于未净化输入);新 endpoint 缺 authn / authz / 租户隔离;secret / token / PII 落日志或 response;新增或升级依赖的已知漏洞与可疑来源。
- Architecture 架构:分层边界(route / application / domain / infra 不互相渗透);新类经构造器 / DI 接依赖,避免业务代码里 new 或隐藏全局;重复逻辑(先查仓库是否已有同类实现);契约一致性(input 类型对齐 entity 存储字段,标 dead field)。
- Performance 性能:N+1 与循环内可批量的 DB / RPC;热路径不必要的分配;真实数据规模下的算法低效;可增长数据集上无 limit 的读取。
- Naming / Complexity / Error handling:命名自描述且与相邻文件一致(单复数、词序);深嵌套 / 超长函数 / 上帝类,建议抽 helper 或 early return,魔法值挪常量;被吞的错误(空 catch、\`.catch(() => {})\` 不 rethrow 不 log),错误带定位上下文,API 边界用领域错误类型、不外泄堆栈 / 内部路径。`,
  },
  {
    key: 'severity',
    title: '严重度判定',
    kind: 'structured',
    hint: '每一档收什么问题。档位名由 Duetlens 固定,只能改判定标准。',
    builtin: '',
    fields: [
      { id: 'high', label: 'high', builtin: '崩溃 / 数据损坏 / 安全问题' },
      { id: 'medium', label: 'medium', builtin: '边界 / 健壮性 / 可维护性隐患' },
      { id: 'low', label: 'low', builtin: '风格 / 命名 / 可读性' },
    ],
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


/**
 * structured 节的一层原文 → 规范化文本(只保留识别得出的字段)。
 * 无法解析出任何字段的正文一律当**未覆盖**:老版本手写的自由文本不会以"覆盖了却什么也没说"的
 * 形式卡在中间层,把 builtin 判定标准整段吞掉。
 */
export function normalizeSeverityText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const levels = parseSeverityLevels(raw);
  const text = serializeSeverityLevels(levels);
  return text || null;
}

function fieldOf(raw: string | null, id: string): string | null {
  if (raw == null) return null;
  return parseSeverityLevels(raw)[id as Severity] ?? null;
}

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
      const p = normalizeSeverityText(project[def.key]);
      const g = normalizeSeverityText(global[def.key]);
      const fields: PromptFieldSection[] = [];
      const resolvedFields: NonNullable<ResolvedPromptSection['fields']> = [];
      const resolvedLevels: Partial<Record<Severity, string>> = {};
      for (const f of def.fields ?? []) {
        const fp = fieldOf(p, f.id);
        const fg = fieldOf(g, f.id);
        const winner = pickLayer(fp, fg);
        fields.push({ id: f.id, label: f.label, builtin: f.builtin, global: fg, project: fp, winner });
        const text = fp ?? fg ?? f.builtin;
        resolvedFields.push({ id: f.id, label: f.label, text, source: winner });
        resolvedLevels[f.id as Severity] = text;
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
        builtin: serializeSeverityLevels(
          Object.fromEntries((def.fields ?? []).map((f) => [f.id, f.builtin])),
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
        text: serializeSeverityLevels(resolvedLevels),
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

