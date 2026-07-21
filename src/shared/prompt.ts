/**
 * 审核规则提示词的分层模型:project ▸ global ▸ builtin,**按节独立覆盖**。
 * 合并结果注入 codex `thread/start · baseInstructions`(见 docs/design/ui.md 三层编辑器、
 * codex-integration.md)。类型放 shared:后端做合并、renderer 三层编辑器消费。
 */

export const PROMPT_SECTION_KEYS = ['focus', 'severity', 'ignore', 'tone', 'context'] as const;
export type PromptSectionKey = (typeof PROMPT_SECTION_KEYS)[number];

export const PROMPT_LAYERS = ['project', 'global', 'builtin'] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

/** 合并后某一节的生效值 + 来源层(provenance)。 */
export interface ResolvedPromptSection {
  key: PromptSectionKey;
  title: string;
  text: string;
  source: PromptLayer;
}

/** 三层编辑器视图:一节的三层原文 + 当前 winner(project 有则 project,否则 global,否则 builtin)。 */
export interface PromptLayerSection {
  key: PromptSectionKey;
  title: string;
  builtin: string;
  global: string | null;
  project: string | null;
  winner: PromptLayer;
}

export interface ReviewPromptView {
  sections: PromptLayerSection[];
  /** 分节合并后注入 baseInstructions 的最终文本(含操作性前言)。 */
  baseInstructions: string;
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
  sections: Partial<Record<PromptSectionKey, string>>;
}
