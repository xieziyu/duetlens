import { Fragment, useMemo, useState, type RefObject } from 'react';
import type { DiffFile, FileStatus } from '@shared/diff';
import type { Finding, UiSettings } from '@shared/domain';
import { imeComposing } from '../../keys';
import { containsHits, matchFilePath, parseFileQuery } from './file-filter';
import { buildTreeRows, subtreeDirs, type FileHit, type TreeRow } from './file-tree-model';

/** 文件状态字母标记(对齐 GitHub 惯例:A/D/M/R)。 */
const STATUS_TAG: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

type FileListView = UiSettings['fileListView'];

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
  /** 平铺 / 目录树;全局偏好,切换即写回设置 */
  view: FileListView;
  onViewChange: (view: FileListView) => void;
}

interface DirGroup {
  /** 目录相对路径;根目录文件为空串,不渲染目录头 */
  dir: string;
  files: FileHit[];
}

/** 按父目录把文件分组,保留目录与组内文件的首次出现顺序。 */
function groupByDir(hits: FileHit[]): DirGroup[] {
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
 * 左栏文件列表:检索框 + 两种视图(平铺分组 / 可逐级折叠的目录树)。
 * 每行:状态标记 + 文件名 + finding 徽标 + diffstat + viewed tick。树头显示「N 改动 · M 已看」。
 * 过滤只收窄这份列表,中栏 diff 仍是全量 —— 否则过滤态下会误判改动规模,右栏计数也跟着对不上。
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
  view,
  onViewChange,
}: FileTreeProps) {
  // 收起的目录。per-review 的临时态:换 review 由 key 重挂载清掉,不落库
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

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
  const shown = useMemo<FileHit[]>(() => {
    if (!filtering) return files.map((file) => ({ file, hits: null }));
    const out: FileHit[] = [];
    for (const file of files) {
      const hits = matchFilePath(file.path, terms);
      if (hits) out.push({ file, hits });
    }
    return out;
  }, [files, terms, filtering]);
  const rows = useMemo(
    () =>
      view === 'tree'
        ? buildTreeRows({ hits: shown, collapsed, expandAll: filtering, findingCount, viewed })
        : [],
    [view, shown, collapsed, filtering, findingCount, viewed],
  );
  // 已看进度是整份 review 的,不随过滤缩水
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  const toggleDir = (path: string, deep: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (prev.has(path)) {
        next.delete(path);
        if (deep) for (const p of prev) if (p.startsWith(`${path}/`)) next.delete(p);
      } else {
        next.add(path);
        if (deep) for (const p of subtreeDirs(rows, path)) next.add(p);
      }
      return next;
    });
  };

  // 检索框内的移动键:↵ 跳首个筛选结果,↑/↓ 在筛选结果间挪选中(手不离键盘也能翻过一串候选)
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (query) onQueryChange('');
      else e.currentTarget.blur();
      return;
    }
    // 树模式下按**可见**文件行走:收起的分支不可达,否则会跳进看不见的文件
    const reachable =
      view === 'tree' && !filtering
        ? rows.flatMap((r) => (r.kind === 'file' ? [r.hit] : []))
        : shown;
    if (reachable.length === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(reachable[0].file.path);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = reachable.findIndex((h) => h.file.path === activePath);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : reachable.length - 1) : at + step;
    if (next >= 0 && next < reachable.length) onSelect(reachable[next].file.path);
  };

  const row = (h: FileHit, depth: number) => (
    <FileRow
      key={h.file.path}
      hit={h}
      depth={depth}
      active={h.file.path === activePath}
      viewed={viewed.has(h.file.path)}
      findings={findingCount.get(h.file.path) ?? 0}
      onSelect={onSelect}
      onToggleViewed={onToggleViewed}
    />
  );

  return (
    <div className={`tree pane tv-${view}${filtering ? ' filtering' : ''}`}>
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
        <div className="ffind-row">
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
          <div className="tvsw" role="group" aria-label="文件列表视图">
            <button
              className={view === 'flat' ? 'on' : ''}
              onClick={() => onViewChange('flat')}
              title="平铺"
              aria-pressed={view === 'flat'}
            >
              <ListIcon />
            </button>
            <button
              className={view === 'tree' ? 'on' : ''}
              onClick={() => onViewChange('tree')}
              title="目录树"
              aria-pressed={view === 'tree'}
            >
              <TreeIcon />
            </button>
          </div>
        </div>
      </div>
      {filtering && shown.length === 0 && <div className="tree-empty">没有匹配的文件</div>}
      {view === 'tree'
        ? rows.length > 0 && (
            <div className="group">
              {rows.map((r) =>
                r.kind === 'file' ? (
                  row(r.hit, r.depth)
                ) : (
                  <DirRow
                    key={r.path}
                    row={r}
                    terms={filtering ? terms : null}
                    filtering={filtering}
                    onToggle={toggleDir}
                  />
                ),
              )}
            </div>
          )
        : groupByDir(shown).map((g) => (
            <div className="group" key={g.dir || '/'}>
              {g.dir && (
                <div className="dir" title={g.dir}>
                  <FolderIcon />
                  <span className="dir-path">
                    <Marked text={g.dir} hits={filtering ? containsHits(g.dir, terms) : null} offset={0} />
                  </span>
                </div>
              )}
              {g.files.map((h) => row(h, 0))}
            </div>
          ))}
    </div>
  );
}

function FileRow({
  hit: { file: f, hits },
  depth,
  active,
  viewed,
  findings,
  onSelect,
  onToggleViewed,
}: {
  hit: FileHit;
  depth: number;
  active: boolean;
  viewed: boolean;
  findings: number;
  onSelect: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const name = basename(f.path);
  return (
    <div
      className={`file${active ? ' active' : ''}${viewed ? ' viewed' : ''}`}
      style={{ ['--d' as string]: depth }}
      onClick={() => onSelect(f.path)}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <span className={`tag st-${f.status}`}>{STATUS_TAG[f.status]}</span>
      <span className="name">
        <Marked text={name} hits={hits} offset={f.path.length - name.length} />
      </span>
      {findings > 0 && <span className="badge f">{findings}</span>}
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
        title={viewed ? '取消已看' : '标记已看'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleViewed(f.path);
        }}
      >
        ✓
      </span>
    </div>
  );
}

/**
 * 目录行 = 折叠开关(真 button:Enter / Space 与焦点由浏览器给,⌥+点递归)。
 * 汇总数字只在收起时出现:展开态里那一列数字纯属噪音,结构本身已经说清了。
 *
 * 过滤态整体禁用:那时行是被 expandAll 强行摊开的,点它屏上什么都不会变,却会偷偷改写
 * collapsed —— 清空过滤后目录状态与过滤前对不上,违背「过滤不动折叠集合」。
 */
function DirRow({
  row,
  terms,
  filtering,
  onToggle,
}: {
  row: Extract<TreeRow, { kind: 'dir' }>;
  terms: string[] | null;
  filtering: boolean;
  onToggle: (path: string, deep: boolean) => void;
}) {
  const hits = terms ? containsHits(row.name, terms) : null;
  const allViewed = row.files > 0 && row.viewed === row.files;
  return (
    <button
      type="button"
      className={`dir${row.open ? ' open' : ''}${allViewed ? ' all-viewed' : ''}`}
      style={{ ['--d' as string]: row.depth }}
      title={row.path}
      aria-expanded={row.open}
      disabled={filtering}
      onClick={(e) => onToggle(row.path, e.altKey)}
    >
      <CaretIcon />
      <FolderIcon />
      <span className="dir-path">
        <Marked text={row.name} hits={hits} offset={0} />
      </span>
      {!row.open && (
        <>
          {row.findings > 0 && <span className="badge f">{row.findings}</span>}
          <span className="dsum">{row.files}</span>
        </>
      )}
    </button>
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

function CaretIcon() {
  return (
    <svg
      className="caret"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h6M8 5v14M8 12h10M8 19h10M13 5h7" />
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
