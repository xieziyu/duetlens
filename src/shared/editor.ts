export const EDITOR_IDS = ['vscode', 'cursor'] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

export const EDITOR_LABELS: Record<EditorId, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
};

export interface EditorInfo {
  id: EditorId;
  icon: string | null;
}

export function isEditorId(value: unknown): value is EditorId {
  return EDITOR_IDS.some((id) => id === value);
}

export function preferredEditor<T extends EditorInfo>(setting: EditorId | null, installed: readonly T[]): T | undefined {
  const candidates = setting === null ? EDITOR_IDS : [setting];
  for (const id of candidates) {
    const editor = installed.find((item) => item.id === id);
    if (editor) return editor;
  }
  return undefined;
}
