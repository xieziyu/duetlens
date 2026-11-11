import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

type LocalFileResult =
  | { ok: true; path: string; realPath: string | null }
  | { ok: false; message: string };

export async function resolveLocalReviewFile(repoPath: string | null, filePath: string): Promise<LocalFileResult> {
  if (!repoPath) return { ok: false, message: '此审核未关联本地仓库' };
  if (typeof filePath !== 'string' || isAbsolute(filePath) || filePath.includes('\0')) {
    return { ok: false, message: '无效的仓库相对路径' };
  }
  const segments = filePath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) {
    return { ok: false, message: '无效的仓库相对路径' };
  }

  const path = resolve(repoPath, filePath);
  const root = await realpath(repoPath).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) {
    return { ok: false, message: '找不到本地仓库目录' };
  }

  try {
    let realPath = root;
    for (const [i, segment] of segments.entries()) {
      const candidate = join(realPath, segment);
      // lstat 区分已删除的路径与失效的符号链接，以便复制已删除文件的路径。
      const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!entry) return { ok: true, path, realPath: null };

      realPath = await realpath(candidate);
      const fromRoot = relative(root, realPath);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        return { ok: false, message: '文件路径指向本地仓库之外' };
      }
      const target = entry.isSymbolicLink() ? await stat(realPath) : entry;
      const last = i === segments.length - 1;
      if (last ? !target.isFile() : !target.isDirectory()) {
        return { ok: false, message: '路径未指向可用的本地文件' };
      }
    }
    return { ok: true, path, realPath };
  } catch {
    return { ok: false, message: '无法访问本地文件路径' };
  }
}
