/**
 * 左栏「目录树」视图的行模型:把扁平的文件列表折成目录层级,再按折叠状态摊回一串可见行。
 * 纯函数、不碰 React —— 渲染只负责画行,展开/收起与命中高亮的判定都在这里收敛。
 *
 * 顺序:同级内目录在前、文件在后,各自保持传入顺序(VSCode / GitHub 文件树的惯例)。
 * 因此左栏与中栏 diff **不是逐行同序** —— 任何按目录分组的呈现都做不到,平铺视图同样如此;
 * 这是分组的代价,不是排序 bug。要逐行对齐就只能不分组。
 */
import type { DiffFile } from '@shared/diff';

/** 一条文件命中;`hits` 是命中字符在完整路径中的下标,未过滤时为 null。 */
export interface FileHit {
  file: DiffFile;
  hits: Set<number> | null;
}

export interface TreeDirRow {
  kind: 'dir';
  /** 完整相对路径,同时是折叠状态的 key */
  path: string;
  /** 显示名;单链压缩后会是 `backend/store` 这样的多段 */
  name: string;
  depth: number;
  open: boolean;
  /** 子树内的文件数 / open finding 数 / 已看数 */
  files: number;
  findings: number;
  viewed: number;
}

export interface TreeFileRow {
  kind: 'file';
  depth: number;
  hit: FileHit;
}

export type TreeRow = TreeDirRow | TreeFileRow;

export interface TreeRowsInput {
  hits: FileHit[];
  collapsed: ReadonlySet<string>;
  /** 过滤态:强制展开命中路径,但不动 collapsed —— 清空过滤后原样恢复 */
  expandAll: boolean;
  /** path → open finding 数 */
  findingCount: ReadonlyMap<string, number>;
  viewed: ReadonlySet<string>;
}

interface Node {
  path: string;
  name: string;
  dirs: Map<string, Node>;
  files: FileHit[];
  sum: { files: number; findings: number; viewed: number };
}

function node(path: string, name: string): Node {
  return { path, name, dirs: new Map(), files: [], sum: { files: 0, findings: 0, viewed: 0 } };
}

/**
 * 把可见行摊平成数组。折叠的目录只出一行,子树整段不进结果 —— 键盘上下键遍历的就是这个数组,
 * 收起的分支必须真的不可达,否则会跳进看不见的文件。
 */
export function buildTreeRows({
  hits,
  collapsed,
  expandAll,
  findingCount,
  viewed,
}: TreeRowsInput): TreeRow[] {
  const root = node('', '');
  for (const hit of hits) {
    const parts = hit.file.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = cur.dirs.get(seg);
      if (!next) {
        next = node(parts.slice(0, i + 1).join('/'), seg);
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(hit);
  }
  compact(root);
  summarize(root, findingCount, viewed);

  const rows: TreeRow[] = [];
  const walk = (n: Node, depth: number) => {
    for (const dir of n.dirs.values()) {
      const open = expandAll || !collapsed.has(dir.path);
      rows.push({ kind: 'dir', path: dir.path, name: dir.name, depth, open, ...dir.sum });
      if (open) walk(dir, depth + 1);
    }
    for (const hit of n.files) rows.push({ kind: 'file', depth, hit });
  };
  walk(root, 0);
  return rows;
}

/**
 * 单链目录合并成一行(`src` → `backend` → `store` 折成 `src/backend/store` 的两层)。
 * 左栏默认只有 236px,每省一级缩进就是文件名多认出两三个字符。
 */
function compact(n: Node): void {
  for (const [key, child] of n.dirs) {
    let cur = child;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    n.dirs.set(key, cur);
    compact(cur);
  }
}

function summarize(
  n: Node,
  findingCount: ReadonlyMap<string, number>,
  viewed: ReadonlySet<string>,
): Node['sum'] {
  const sum = { files: 0, findings: 0, viewed: 0 };
  for (const dir of n.dirs.values()) {
    const s = summarize(dir, findingCount, viewed);
    sum.files += s.files;
    sum.findings += s.findings;
    sum.viewed += s.viewed;
  }
  for (const { file } of n.files) {
    sum.files += 1;
    sum.findings += findingCount.get(file.path) ?? 0;
    if (viewed.has(file.path)) sum.viewed += 1;
  }
  n.sum = sum;
  return sum;
}

/**
 * ⌥+点递归收起时要一并收起的目录路径。只看得见已展开的分支 —— 反方向(递归展开)不需要它:
 * 把 collapsed 里带该前缀的条目删掉即可,不必先知道子树长什么样。
 */
export function subtreeDirs(rows: TreeRow[], path: string): string[] {
  const prefix = `${path}/`;
  return rows
    .filter((r): r is TreeDirRow => r.kind === 'dir' && (r.path === path || r.path.startsWith(prefix)))
    .map((r) => r.path);
}
