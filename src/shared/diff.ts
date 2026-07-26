/**
 * 结构化 diff:把 source 层拿到的 unified diff 原文解析成可渲染的文件/hunk/行模型,
 * 经 IPC 喂给 renderer 的 DiffPane。
 * 纯函数、无副作用,后端解析后把结果发给前端;renderer 只消费结构。
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 旧侧行号;add 行为 null */
  oldLine: number | null;
  /** 新侧行号;del 行为 null(finding/discussion 锚点用新侧行号) */
  newLine: number | null;
  /** 行内容,不含前缀 +/-/空格 */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** @@ 头之后的上下文(通常是所在函数签名),可空 */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** 展示与锚点用路径:新侧路径(deleted 用旧侧) */
  path: string;
  /** rename 时的旧路径,否则 null */
  oldPath: string | null;
  status: FileStatus;
  /** 二进制文件无逐行 diff(hunks 为空) */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** 解析 `@@ -a,b +c,d @@ section` 头;count 省略默认 1。 */
function parseHunkHeader(line: string): Omit<DiffHunk, 'lines'> | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    section: m[5].trim(),
  };
}

/** 去掉 git diff 路径前缀 a/ b/(--src-prefix 等特殊场景不处理)。 */
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

/**
 * 解析 git 风格 unified diff 原文为 DiffFile[]。
 * 支持:新增/删除/修改/重命名、二进制、多 hunk、\ No newline at end of file。
 * 未知/装饰行(index、mode、similarity 等)忽略;行号按 hunk 头累进。
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = (): void => {
    if (file) files.push(file);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      pushFile();
      const m = /^diff --git (.+) (.+)$/.exec(line);
      const oldP = m ? stripPrefix(m[1]) : '';
      const newP = m ? stripPrefix(m[2]) : '';
      file = {
        path: newP || oldP,
        oldPath: null,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = stripPrefix(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = stripPrefix(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== '/dev/null' && !file.oldPath) file.oldPath = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== '/dev/null') file.path = p;
      continue;
    }

    const header = parseHunkHeader(line);
    if (header) {
      hunk = { ...header, lines: [] };
      file.hunks.push(hunk);
      oldNo = header.oldStart;
      newNo = header.newStart;
      continue;
    }
    if (!hunk) continue;

    // \ No newline at end of file:注记行,不占行号
    if (line.startsWith('\\')) continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine: newNo++, text });
      file.additions++;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, text });
      file.deletions++;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text });
    }
    // 空串(末尾换行的 split 残留)与未知前缀忽略;context 空行在 git 里前导有空格,走上面分支
  }
  pushFile();
  return files;
}

/**
 * 两版 unified diff 之间发生改动的文件路径(复审用:上一轮 → 本轮哪些文件变了)。
 * 按「该文件的 diff 文本是否相同」判定,而非只看文件列表 —— 同一文件内容变了也要算进去。
 * 任一侧为空(首轮无上一版)时返回新版的全部文件。
 */
export function changedFilesBetween(prevRaw: string | null, nextRaw: string): string[] {
  const next = parseUnifiedDiff(nextRaw);
  if (!prevRaw) return next.map((f) => f.path);
  const prev = new Map(parseUnifiedDiff(prevRaw).map((f) => [f.path, fileFingerprint(f)]));
  const changed = next.filter((f) => prev.get(f.path) !== fileFingerprint(f)).map((f) => f.path);
  // 上一版有、本版没有的文件:该文件的改动被撤回了,同样值得 agent 知道
  const nextPaths = new Set(next.map((f) => f.path));
  for (const p of prev.keys()) if (!nextPaths.has(p)) changed.push(p);
  return changed;
}

/** 文件级指纹:状态 + 逐行内容;行号随上下文漂移也算变化,宁可多报不可漏报。 */
function fileFingerprint(f: DiffFile): string {
  const body = f.hunks
    .map((h) => `${h.newStart},${h.newCount}:${h.lines.map((l) => l.kind + l.text).join('\n')}`)
    .join('|');
  return `${f.status}:${f.binary ? 'bin' : body}`;
}
