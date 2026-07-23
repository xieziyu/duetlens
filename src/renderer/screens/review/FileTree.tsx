import { useMemo } from 'react';
import type { DiffFile, FileStatus } from '@shared/diff';
import type { Finding } from '@shared/domain';

/** 文件状态字母标记(对齐 GitHub 惯例:A/D/M/R)。 */
const STATUS_TAG: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

export interface FileTreeProps {
  files: DiffFile[];
  findings: Finding[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /** per-file 已看集合;tick 标记同步折叠 diff */
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
}

interface DirGroup {
  /** 目录相对路径;根目录文件为空串,不渲染目录头 */
  dir: string;
  files: DiffFile[];
}

/** 按父目录把文件分组,保留目录与组内文件的首次出现顺序。 */
function groupByDir(files: DiffFile[]): DirGroup[] {
  const groups: DirGroup[] = [];
  const index = new Map<string, DirGroup>();
  for (const f of files) {
    const dir = dirname(f.path);
    let g = index.get(dir);
    if (!g) {
      g = { dir, files: [] };
      index.set(dir, g);
      groups.push(g);
    }
    g.files.push(f);
  }
  return groups;
}

/**
 * 左栏文件树:按目录分组,每组一个目录头 + 组内文件(仅 basename)。
 * 每行:状态标记 + 文件名 + finding 徽标 + diffstat + viewed tick。树头显示「N 改动 · M 已看」。
 */
export function FileTree({ files, findings, activePath, onSelect, viewed, onToggleViewed }: FileTreeProps) {
  // 按文件聚合 open finding 数(triage!=dismiss),用于徽标
  const findingCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of findings) {
      if (f.triage === 'dismiss') continue;
      m.set(f.file, (m.get(f.file) ?? 0) + 1);
    }
    return m;
  }, [findings]);
  const groups = useMemo(() => groupByDir(files), [files]);
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  return (
    <div className="tree pane">
      <div className="head">
        <h3>Files</h3>
        <span className="count">
          {files.length} 改动 · <span className="vn">{viewedCount}</span> 已看
        </span>
      </div>
      {groups.map((g) => (
        <div className="group" key={g.dir || '/'}>
          {g.dir && (
            <div className="dir" title={g.dir}>
              <FolderIcon />
              <span className="dir-path">{g.dir}</span>
            </div>
          )}
          {g.files.map((f) => {
            const count = findingCount.get(f.path) ?? 0;
            const isViewed = viewed.has(f.path);
            return (
              <div
                key={f.path}
                className={`file${f.path === activePath ? ' active' : ''}${isViewed ? ' viewed' : ''}`}
                onClick={() => onSelect(f.path)}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span className={`tag st-${f.status}`}>{STATUS_TAG[f.status]}</span>
                <span className="name">{basename(f.path)}</span>
                {count > 0 && <span className="badge f">{count}</span>}
                {f.binary ? (
                  <span className="stat dim">bin</span>
                ) : (
                  <span className="stat">
                    <span className="a">+{f.additions}</span>
                    <span className="d">−{f.deletions}</span>
                  </span>
                )}
                <span
                  className="vtick"
                  title={isViewed ? '取消已看' : '标记已看'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleViewed(f.path);
                  }}
                >
                  ✓
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
