/**
 * 审核规则提示词的分层解析与合并(见 [[docs/design/ui.md]] 三层编辑器)。
 * 固定几节,每节独立取「project ▸ global ▸ builtin」里最高优先且有定义的层;
 * 合并结果 + 操作性前言 = 注入 codex `baseInstructions` 的文本。
 * 层文件:project = `<cwd>/.duetlens/review.md`,global = `~/.duetlens/review.md`。
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FINDING_CATEGORIES } from '@shared/domain';
import {
  type PromptLayer,
  type PromptLayerSection,
  type PromptSectionKey,
  type ResolvedPromptSection,
  type ReviewPromptView,
} from '@shared/prompt';

/** 操作性前言(builtin,不进分节覆盖):角色 + MCP 用法 + 只读约束。 */
export const BUILTIN_PREAMBLE = `你是 Duetlens 的代码审核 agent。审核本次改动,把发现的每个问题通过 duetlens MCP 的 report_finding 上报。
- 先调用 get_diff 查看改动,需要上下文时用 get_file 读取。
- 每个问题调用一次 report_finding,锚定 file 与新侧 line,给出 severity(high/medium/low)、category、title、body。
- 只审核、不修改代码。审完给一句话总结。`;

interface SectionDef {
  key: PromptSectionKey;
  title: string;
  builtin: string;
}

/** 分节覆盖的固定几节 + builtin 默认;context 无内置默认,由 project 补充仓库背景。 */
export const BUILTIN_SECTIONS: readonly SectionDef[] = [
  {
    key: 'focus',
    title: '审核重点',
    builtin: `按以下类别审查改动,只报告需要修复的真实问题;把偏离分为有理由的改进 / 可接受的差异 / 有问题的偏离,只标最后一种。
- Scope 范围对齐:PR 描述之外夹带的无关改动;body 承诺但 diff 未实现的缺失部分。
- Correctness 正确性:绕过类型检查的逃生口(as any / @ts-ignore / 无依据的非空断言 / 骗过运行时形状的 cast);null / undefined 缺保护;资源泄漏(未关的 stream / 连接 / 句柄、未移除的监听、未清的 timer);竞态(共享状态并发无同步、请求路径未 await 的 promise);逻辑错误(off-by-one、比较写反、参数顺序、漏掉某分支)。
- Security 安全:注入(SQL / NoSQL / XSS / command / 路径穿越,源于未净化输入);新 endpoint 缺 authn / authz / 租户隔离;secret / token / PII 落日志或 response;新增或升级依赖的已知漏洞与可疑来源。
- Architecture 架构:分层边界(route / application / domain / infra 不互相渗透);新类经构造器 / DI 接依赖,避免业务代码里 new 或隐藏全局;重复逻辑(先查仓库是否已有同类实现);契约一致性(input 类型对齐 entity 存储字段,标 dead field)。
- Performance 性能:N+1 与循环内可批量的 DB / RPC;热路径不必要的分配;真实数据规模下的算法低效;可增长数据集上无 limit 的读取。
- Naming / Complexity / Error handling:命名自描述且与相邻文件一致(单复数、词序);深嵌套 / 超长函数 / 上帝类,建议抽 helper 或 early return,魔法值挪常量;被吞的错误(空 catch、\`.catch(() => {})\` 不 rethrow 不 log),错误带定位上下文,API 边界用领域错误类型、不外泄堆栈 / 内部路径。
- 超出 diff 的架构隐患以 off-diff finding 提出,并说明为何 off-diff。`,
  },
  {
    key: 'severity',
    title: '严重度判定',
    builtin:
      'high = 崩溃 / 数据损坏 / 安全问题;\nmed = 边界 / 健壮性 / 可维护性隐患;\nlow = 风格 / 命名 / 可读性。',
  },
  {
    key: 'ignore',
    title: '忽略范围',
    builtin: '忽略纯格式化、生成文件、lockfile、无语义的行重排。',
  },
  {
    key: 'tone',
    title: '输出与语气',
    builtin:
      'finding 正文用简体中文,代码标识符 / 路径 / category 用英文;\n' +
      `category 取以下之一:${FINDING_CATEGORIES.join(' / ')};\n` +
      '每条给出 file:line 锚点与可选 suggestion 块;\n' +
      'suggestion 是可直接套用的字面补丁(会逐字替换锚定行),不是示意片段。',
  },
  { key: 'context', title: '项目上下文', builtin: '' },
];

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

/** 按节合并三层:每节独立取 project ▸ global ▸ builtin。返回编辑器视图 + 解析后的生效值。 */
export function mergeLayers(
  project: Partial<Record<PromptSectionKey, string>>,
  global: Partial<Record<PromptSectionKey, string>>,
): { sections: PromptLayerSection[]; resolved: ResolvedPromptSection[] } {
  const sections: PromptLayerSection[] = [];
  const resolved: ResolvedPromptSection[] = [];
  for (const s of BUILTIN_SECTIONS) {
    const p = project[s.key] ?? null;
    const g = global[s.key] ?? null;
    const source: PromptLayer = p != null ? 'project' : g != null ? 'global' : 'builtin';
    sections.push({ key: s.key, title: s.title, builtin: s.builtin, global: g, project: p, winner: source });
    resolved.push({ key: s.key, title: s.title, text: p ?? g ?? s.builtin, source });
  }
  return { sections, resolved };
}

/** 前言 + 各节(空节略去)拼成 baseInstructions;节以 `## 标题` 分隔。 */
export function composeBaseInstructions(resolved: readonly ResolvedPromptSection[]): string {
  const body = resolved
    .filter((s) => s.text.trim())
    .map((s) => `## ${s.title}\n${s.text.trim()}`)
    .join('\n\n');
  return body ? `${BUILTIN_PREAMBLE}\n\n${body}` : BUILTIN_PREAMBLE;
}

/** 无任何层文件时的 baseInstructions(前言 + builtin 各节);直调 session 的兜底。 */
export const BUILTIN_BASE_INSTRUCTIONS = composeBaseInstructions(mergeLayers({}, {}).resolved);

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
}

/** 读 project + global 两层文件,与 builtin 合并,返回编辑器视图 + 注入用 baseInstructions。 */
export async function loadReviewPrompt(opts: LoadReviewPromptOptions = {}): Promise<ReviewPromptView> {
  const projectMd = opts.cwd ? await readLayerFile(path.join(opts.cwd, PROJECT_PROMPT_RELPATH)) : null;
  const globalMd = await readLayerFile(globalPromptPath(opts.homeDir));
  const { sections, resolved } = mergeLayers(
    projectMd ? parseReviewMarkdown(projectMd) : {},
    globalMd ? parseReviewMarkdown(globalMd) : {},
  );
  return { sections, baseInstructions: composeBaseInstructions(resolved) };
}
