import { Fragment, useMemo, type RefObject } from 'react';
import type { DiffFile, FileStatus } from '@shared/diff';
import type { Finding } from '@shared/domain';
import { containsHits, matchFilePath, parseFileQuery } from './file-filter';

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
  /** 检索词由屏持有:换 review 要清掉,`/` 也要能把焦点甩进来 */
  query: string;
  onQueryChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement>;
}

interface Hit {
  file: DiffFile;
  /** 命中字符在完整路径中的下标;未过滤时为 null */
  hits: Set<number> | null;
}

interface DirGroup {
  /** 目录相对路径;根目录文件为空串,不渲染目录头 */
  dir: string;
  files: Hit[];
}

/** 按父目录把文件分组,保留目录与组内文件的首次出现顺序。 */
function groupByDir(hits: Hit[]): DirGroup[] {
  const groups: DirGroup[] = [];
  const index = new Map<string, DirGroup>();
  for (const h of hits) {
    const dir = dirname(h.file.path);
    let g = index.get(dir);
    if (!g) {
      g = { dir, files: [] };
      index.set(dir, g);
      groups.push(g);
    }
    g.files.push(h);
  }
  return groups;
}

/**
 * 左栏文件树:检索框 + 按目录分组的文件行(仅 basename)。
 * 每行:状态标记 + 文件名 + finding 徽标 + diffstat + viewed tick。树头显示「N 改动 · M 已看」。
 * 过滤只收窄这棵树,中栏 diff 仍是全量 —— 否则过滤态下会误判改动规模,右栏计数也跟着对不上。
 */
export function FileTree({
  files,
  findings,
  activePath,
  onSelect,
  viewed,
  onToggleViewed,
  query,
  onQueryChange,
  inputRef,
}: FileTreeProps) {
  // 按文件聚合 open finding 数(triage!=dismiss),用于徽标
  const findingCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of findings) {
      if (f.triage === 'dismiss') continue;
      m.set(f.file, (m.get(f.file) ?? 0) + 1);
    }
    return m;
  }, [findings]);

  const terms = useMemo(() => parseFileQuery(query), [query]);
  const filtering = terms.length > 0;
  const shown = useMemo<Hit[]>(() => {
    if (!filtering) return files.map((file) => ({ file, hits: null }));
    const out: Hit[] = [];
    for (const file of files) {
      const hits = matchFilePath(file.path, terms);
      if (hits) out.push({ file, hits });
    }
    return out;
  }, [files, terms, filtering]);
  const groups = useMemo(() => groupByDir(shown), [shown]);
  // 已看进度是整份 review 的,不随过滤缩水
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  // 检索框内的移动键:↵ 跳首个筛选结果,↑/↓ 在筛选结果间挪选中(手不离键盘也能翻过一串候选)
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (query) onQueryChange('');
      else e.currentTarget.blur();
      return;
    }
    if (shown.length === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(shown[0].file.path);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = shown.findIndex((h) => h.file.path === activePath);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : shown.length - 1) : at + step;
    if (next >= 0 && next < shown.length) onSelect(shown[next].file.path);
  };

  return (
    <div className={`tree pane${filtering ? ' filtering' : ''}`}>
      <div className="tree-top">
        <div className="head">
          <h3>Files</h3>
          <span className="count">
            {filtering ? (
              <>
                <span className="mn">{shown.length}</span> / {files.length} 匹配
              </>
            ) : (
              <>
                {files.length} 改动 · <span className="vn">{viewedCount}</span> 已看
              </>
            )}
          </span>
        </div>
        <div className="ffind">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="过滤文件 · ⌘⇧F"
            spellCheck={false}
            aria-label="过滤文件"
          />
          {query && (
            <button className="fx" onClick={() => onQueryChange('')} title="清空 (Esc)">
              ✕
            </button>
          )}
        </div>
      </div>
      {filtering && shown.length === 0 && <div className="tree-empty">没有匹配的文件</div>}
      {groups.map((g) => {
        const dirHits = filtering ? containsHits(g.dir, terms) : null;
        return (
          <div className="group" key={g.dir || '/'}>
            {g.dir && (
              <div className="dir" title={g.dir}>
                <FolderIcon />
                <span className="dir-path">
                  <Marked text={g.dir} hits={dirHits} offset={0} />
                </span>
              </div>
            )}
            {g.files.map(({ file: f, hits }) => {
              const count = findingCount.get(f.path) ?? 0;
              const isViewed = viewed.has(f.path);
              const name = basename(f.path);
              return (
                <div
                  key={f.path}
                  className={`file${f.path === activePath ? ' active' : ''}${isViewed ? ' viewed' : ''}`}
                  onClick={() => onSelect(f.path)}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <span className={`tag st-${f.status}`}>{STATUS_TAG[f.status]}</span>
                  <span className="name">
                    <Marked text={name} hits={hits} offset={f.path.length - name.length} />
                  </span>
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
        );
      })}
    </div>
  );
}

/** 高亮命中字符。hits 的下标以完整路径为基准,offset 是本段文本在路径中的起点。 */
function Marked({
  text,
  hits,
  offset,
}: {
  text: string;
  hits: Set<number> | null;
  offset: number;
}) {
  if (!hits || hits.size === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < text.length; ) {
    const on = hits.has(offset + i);
    let j = i + 1;
    while (j < text.length && hits.has(offset + j) === on) j++;
    const chunk = text.slice(i, j);
    out.push(on ? <mark key={i}>{chunk}</mark> : <Fragment key={i}>{chunk}</Fragment>);
    i = j;
  }
  return <>{out}</>;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
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
