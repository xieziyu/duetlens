/**
 * 审核规则提示词的分层解析与合并(见 [[docs/design/ui.md]] 三层编辑器)。
 *
 * prompt 分两类段落,只有前一类进入分层覆盖模型:
 *   - **可配置节**(审核重点 / 严重度判定 / 忽略范围 / 输出与语气 / 项目上下文):
 *     每节独立取「project ▸ global ▸ builtin」里最高优先且有定义的层。
 *   - **锁定段**(角色与工具流程、上报字段协议):不可覆盖、不下发 renderer、不出现在设置页。
 *     这些文字描述的是 MCP 工具契约本身 —— severity 枚举、category 规范集、行锚定的是新侧、
 *     suggestion 会被逐字套用 —— 被改写不是口径变化,而是 finding 直接被 ingress 拒收
 *     (`reportFindingSchema` 的 `z.enum(SEVERITIES)`)或提交到 GitHub 时补丁错位。
 *
 * 锁定段拆成首尾两块:角色在最前(身份),字段协议在最末(硬契约),
 * 让用户节里万一写了冲突的话也压不过后面的协议。
 *
 * 层文件:project = `<cwd>/.duetlens/review.md`,global = `~/.duetlens/review.md`。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FINDING_CATEGORIES,
  SEVERITIES,
  SUMMARY_FILES_LIMIT,
  type ReviewIntensity,
} from '@shared/domain';
import {
  BUILTIN_SECTIONS,
  mergeLayers,
  normalizeStructuredText,
  type EditablePromptLayer,
  type PromptSectionKey,
  type ResolvedPromptSection,
  type ReviewPromptView,
} from '@shared/prompt';

/** 锁定段之一:角色 + MCP 用法 + 只读约束。注入在最前。 */
export const BUILTIN_ROLE = `你是 Duetlens 的代码审核 agent。审核本次改动,把发现的每个问题通过 duetlens MCP 的 report_finding 上报。
- 先调用 get_diff 查看改动,需要上下文时用 get_file 读取。
- 每个问题调用一次 report_finding,一条 finding 只讲一个问题。
- 只审核、不修改代码。审完调用一次 write_summary 写下总结与需要人工重点复核的文件。
- 先判断改动属于哪类代码(前端 UI / 后端服务 / 库 / CLI / 基础设施 / 脚本 等),按「审核重点」里与之相符的类别过一遍,不要生搬不适用的检查项。
- 只报告需要修复的真实问题:把偏离分为有理由的改进 / 可接受的差异 / 有问题的偏离,只标最后一种。`;

/**
 * 对抗强度专用立场段(仅 adversarial 档注入,紧跟角色段之后)。
 * 是审核**方法论**而非字段口径,故归属锁定的角色一侧、不进可配置分层 —— 避免被用户节 override 掉。
 * 只读约束不变:不写盘、不执行代码,反例靠推理构造与手推。
 */
export const BUILTIN_ADVERSARIAL = `## 对抗式审核立场
本次以对抗强度审核,默认假设这段代码在某个输入下是错的,你的任务是找到那个输入。
- 不要满足于"看起来没问题" —— 那只说明你还没构造出反例。逐个函数/分支问:什么输入、什么并发时序、什么边界(空 / 越界 / 溢出 / null / 并发 / 部分失败)能让它出错?
- 主动构造具体反例并手推执行路径,把推演过程写进 finding 的 body,而不是泛泛断言"可能有问题"。
- 同时审"没写的代码":缺失的校验、未处理的错误分支、被静默吞掉的失败。
- 找不到反例不必硬凑;宁可少报也不要报凑数的猜测。真实、可复现的问题才上报。`;

/**
 * 锁定段之二:report_finding 的字段契约。注入在最末 —— 用户节若写了冲突口径,以本段为准。
 * 这里的每一条都对应一处机械消费:severity 走 zod enum、category 决定 Findings 栏分组、
 * line 锚新侧决定提交到 GitHub 的位置、suggestion 会被逐字替换进代码。
 */
export const BUILTIN_PROTOCOL = `## 上报协议(固定,不随以上偏好改变)
以上各节是审核口径;本节是 report_finding 的字段契约,Duetlens 会机械消费这些字段,必须严格遵守。
- severity 只能取 ${SEVERITIES.join(' / ')} 三者之一,小写原词;每档的判定标准见「严重度判定」。
- category 只能取:${FINDING_CATEGORIES.join(' / ')};用英文原词,不要自造、缩写或翻译。
- file 用相对仓库根的路径;line 锚**新侧**行号。
- suggestion 可选;给出时必须是能直接套用的字面补丁(会逐字替换锚定行),不是示意片段 —— 拿不准就不要给。
- 超出 diff 范围的隐患照常 report_finding,并在正文里说明为何 off-diff。
- 收尾必须调用一次 write_summary:body 是总结正文,呈现在 Summary 屏供 reviewer 判断;
  只写在对话回复里不算 —— 那段文字不会进入总结,屏上仍是「尚未生成」。
- write_summary 的 files 挑**没有变成 finding、但人眼该过一遍**的文件(至多 ${SUMMARY_FILES_LIMIT} 条,
  按重要性排序,path 同 file 的路径口径,一个文件只给一条)。已有 finding 覆盖的问题不必在此重复;真没有就给空数组。`;

/** review.md 里 H2 标题(节标题或英文 key 皆可)→ 节 key,便于人手写与编辑器输出两种写法。 */
const HEADING_TO_KEY: ReadonlyMap<string, PromptSectionKey> = new Map(
  BUILTIN_SECTIONS.flatMap((s) => [
    [s.title, s.key],
    [s.key, s.key],
  ]),
);

export const PROJECT_PROMPT_RELPATH = path.join('.duetlens', 'review.md');

export function globalPromptPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.duetlens', 'review.md');
}

/** project 层文件路径;未选仓库(无 cwd)时为 null,此时 project 层不可编辑。 */
export function projectPromptPath(cwd?: string): string | null {
  return cwd ? path.join(cwd, PROJECT_PROMPT_RELPATH) : null;
}

/**
 * 解析一层 review.md 为「节 key → 正文」。按 H2 分节,正文取到下一个 H1/H2 前;
 * 空正文的节视为**未覆盖**(不计入,让下层生效)。未识别的标题忽略。
 */
export function parseReviewMarkdown(md: string): Partial<Record<PromptSectionKey, string>> {
  const out: Partial<Record<PromptSectionKey, string>> = {};
  let key: PromptSectionKey | undefined;
  let buf: string[] = [];
  const flush = (): void => {
    if (key) {
      const text = buf.join('\n').trim();
      if (text) out[key] = text;
    }
    buf = [];
  };
  for (const line of md.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      key = HEADING_TO_KEY.get(h2[1].trim());
      continue;
    }
    if (/^#\s+/.test(line)) {
      flush();
      key = undefined;
      continue;
    }
    if (key) buf.push(line);
  }
  flush();
  return out;
}

/** 各节(空节略去)拼成可配置部分的文本;节以 `## 标题` 分隔。不含锁定段。 */
function composeMergedRules(resolved: readonly ResolvedPromptSection[]): string {
  return resolved
    .filter((s) => s.text.trim())
    .map((s) => `## ${s.title}\n${s.text.trim()}`)
    .join('\n\n');
}

/**
 * 锁定角色段(+ 对抗立场段,仅对抗档)+ 可配置各节 + 锁定协议段 = 注入 codex 的 baseInstructions。
 * 立场段紧跟角色、在用户可配置节之前,保证用户口径压不过它,也压不过末尾的字段协议。
 */
export function composeBaseInstructions(
  resolved: readonly ResolvedPromptSection[],
  intensity: ReviewIntensity = 'standard',
): string {
  const rules = composeMergedRules(resolved);
  const stance = intensity === 'adversarial' ? BUILTIN_ADVERSARIAL : '';
  return [BUILTIN_ROLE, stance, rules, BUILTIN_PROTOCOL].filter((b) => b.trim()).join('\n\n');
}

/** 无任何层文件时的 baseInstructions(锁定段 + builtin 各节);直调 session 的兜底。 */
export const BUILTIN_BASE_INSTRUCTIONS = composeBaseInstructions(mergeLayers({}, {}).resolved);

/**
 * 把一层的覆盖节序列化为 review.md:按 BUILTIN_SECTIONS 固定顺序、H2 用节标题,
 * 只写有正文的节(空/缺=不覆盖)。structured 节先规范化,防止手写脏文本落盘。
 * 可被 parseReviewMarkdown 无损回读。
 */
export function serializeLayer(sections: Partial<Record<PromptSectionKey, string>>): string {
  const blocks: string[] = [];
  for (const def of BUILTIN_SECTIONS) {
    const raw = sections[def.key];
    const text =
      def.kind === 'structured'
        ? normalizeStructuredText(raw, (def.fields ?? []).map((f) => f.id), def.aliases)
        : (raw?.trim() ?? null);
    if (text) blocks.push(`## ${def.title}\n${text}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

export interface SaveReviewLayerOptions {
  /** project 层落 `<cwd>/.duetlens/review.md`;缺省则 project 层无处可写。 */
  cwd?: string;
  /** 覆盖 home(测试隔离用);缺省 os.homedir()。 */
  homeDir?: string;
}

/** 整层重写某一可编辑层的 review.md(自动建 `.duetlens/` 目录)。 */
export async function saveReviewLayer(
  layer: EditablePromptLayer,
  sections: Partial<Record<PromptSectionKey, string>>,
  opts: SaveReviewLayerOptions = {},
): Promise<void> {
  const file = layer === 'project' ? projectPromptPath(opts.cwd) : globalPromptPath(opts.homeDir);
  if (!file) throw new Error('project 层需要仓库目录(cwd)才能写入');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeLayer(sections), 'utf8');
}

async function readLayerFile(p: string): Promise<string | null> {
  // 层文件是附加增强:缺失(ENOENT)或读失败一律降级为「该层未覆盖」,绝不阻断 review。
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface LoadReviewPromptOptions {
  /** 被审代码树目录(project 层从 `<cwd>/.duetlens/review.md` 读);缺省则无 project 层。 */
  cwd?: string;
  /** 覆盖 home(测试隔离用);缺省 os.homedir()。 */
  homeDir?: string;
  /** 审核强度;对抗档在 baseInstructions 里追加对抗立场段(编辑器视图不受影响)。 */
  intensity?: ReviewIntensity;
}

async function resolvePrompt(
  opts: LoadReviewPromptOptions,
): Promise<{ view: ReviewPromptView; baseInstructions: string }> {
  const projectPath = projectPromptPath(opts.cwd);
  const globalPath = globalPromptPath(opts.homeDir);
  const projectMd = projectPath ? await readLayerFile(projectPath) : null;
  const globalMd = await readLayerFile(globalPath);
  const { sections, resolved } = mergeLayers(
    projectMd ? parseReviewMarkdown(projectMd) : {},
    globalMd ? parseReviewMarkdown(globalMd) : {},
  );
  return {
    view: { sections, projectPath, globalPath },
    baseInstructions: composeBaseInstructions(resolved, opts.intensity),
  };
}

/** 读 project + global 两层文件与 builtin 合并,返回**编辑器视图**(不含锁定段)。 */
export async function loadReviewPrompt(opts: LoadReviewPromptOptions = {}): Promise<ReviewPromptView> {
  return (await resolvePrompt(opts)).view;
}

/** 注入 codex 的完整 baseInstructions(锁定段 + 合并后的可配置节)。 */
export async function loadBaseInstructions(opts: LoadReviewPromptOptions = {}): Promise<string> {
  return (await resolvePrompt(opts)).baseInstructions;
}
