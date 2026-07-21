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
}

/**
 * 左栏文件树(对齐 mockup .tree):每行文件名 + diffstat + 该文件的 finding 计数徽标。
 * 目录分组暂略,先扁平列表;viewed tick 归后续切片。
 */
export function FileTree({ files, findings, activePath, onSelect }: FileTreeProps) {
  // 按文件聚合 open finding 数(triage!=dismiss),用于徽标
  const findingCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of findings) {
      if (f.triage === 'dismiss') continue;
      m.set(f.file, (m.get(f.file) ?? 0) + 1);
    }
    return m;
  }, [findings]);

  return (
    <div className="tree pane">
      <div className="head">
        <h3>Files</h3>
        <span className="count">{files.length}</span>
      </div>
      <div className="group">
        {files.map((f) => {
          const count = findingCount.get(f.path) ?? 0;
          return (
            <div
              key={f.path}
              className={`file${f.path === activePath ? ' active' : ''}`}
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
