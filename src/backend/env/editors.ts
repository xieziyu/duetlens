import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EDITOR_IDS, type EditorId, type EditorInfo } from '@shared/editor';

const BUNDLES = {
  vscode: { app: 'Visual Studio Code.app', bin: 'code', icon: 'Code.icns' },
  cursor: { app: 'Cursor.app', bin: 'cursor', icon: 'Cursor.icns' },
} satisfies Record<EditorId, { app: string; bin: string; icon: string }>;

interface InstalledEditor extends EditorInfo {
  iconPath: string;
  executable: string;
}

async function findEditor(id: EditorId): Promise<InstalledEditor | undefined> {
  const bundle = BUNDLES[id];
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    const resources = join(dir, bundle.app, 'Contents', 'Resources');
    const executable = join(resources, 'app', 'bin', bundle.bin);
    try {
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return { id, iconPath: join(resources, bundle.icon), executable, icon: null };
    } catch {
      // 应用可能安装在另一个目录，或还没解压完成。
    }
  }
  return undefined;
}

export async function listInstalledEditors(): Promise<InstalledEditor[]> {
  if (process.platform !== 'darwin') return [];
  return (await Promise.all(EDITOR_IDS.map(findEditor))).filter((editor) => editor !== undefined);
}
