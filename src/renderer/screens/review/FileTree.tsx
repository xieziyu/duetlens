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

/**
 * 左栏文件树(对齐 mockup .tree):每行文件名 + diffstat + finding 徽标 + viewed tick。
 * 目录分组暂略,先扁平列表。树头显示「N 改动 · M 已看」进度。
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
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  return (
    <div className="tree pane">
      <div className="head">
        <h3>Files</h3>
        <span className="count">
          {files.length} 改动 · <span className="vn">{viewedCount}</span> 已看
        </span>
      </div>
      <div className="group">
        {files.map((f) => {
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
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
