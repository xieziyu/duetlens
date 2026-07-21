import { useEffect, useMemo, useRef } from 'react';
import type { DiffFile, DiffHunk, DiffLine } from '@shared/diff';
import type { Finding, Triage } from '@shared/domain';
import type { FindingEditInput } from '@shared/ipc';
import { InlineCard } from './InlineCard';
import { highlightLine, langOf } from './highlight';

export type DiffView = 'unified' | 'split';

/** 文件锚点 id:供左栏点击滚动定位。路径里的非单词字符替换成 -。 */
export function fileAnchorId(path: string): string {
  return 'df-' + path.replace(/[^\w]+/g, '-');
}

export interface DiffPaneProps {
  files: DiffFile[];
  findings: Finding[];
  /** 左栏选中的文件路径;变化时滚动到对应 file-header */
  activePath: string | null;
  /** 右栏点选的 finding;变化时滚动到内联卡并高亮 */
  focusFindingId: string | null;
  /** finding 写路径:裁决 / 就地编辑,缺省则内联卡为只读 */
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
  /** unified / split 视图(全局,file-header segmented 驱动) */
  view: DiffView;
  onViewChange: (v: DiffView) => void;
  /** per-file 已看 / 折叠(本地态) */
  viewed: Set<string>;
  collapsed: Set<string>;
  onToggleViewed: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
}

/**
 * 中栏 diff 主场(对齐 mockup .diff):unified/split 双视图 + 锚定内联 finding 卡(view/edit/dismissed)。
 * split 与 unified 共用同一 InlineCard,锚点一律用新侧行号。框选发起 discussion 归后续切片。
 */
export function DiffPane(props: DiffPaneProps) {
  const { files, findings, activePath, focusFindingId } = props;
  const ref = useRef<HTMLDivElement>(null);

  // 按文件聚合 findings,便于每个 DiffFileView 只拿自己的
  const byFile = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of findings) {
      const arr = m.get(f.file) ?? [];
      arr.push(f);
      m.set(f.file, arr);
    }
    return m;
  }, [findings]);

  useEffect(() => {
    if (!activePath || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(fileAnchorId(activePath))}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [activePath]);

  useEffect(() => {
    if (!focusFindingId || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(`finding-${focusFindingId}`)}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusFindingId]);

  if (files.length === 0) {
    return (
      <div className="diff pane" ref={ref}>
        <p className="diff-empty">暂无 diff。扫描期会在拉取改动后显示。</p>
      </div>
    );
  }

  return (
    <div className="diff pane" ref={ref}>
      {files.map((f) => (
        <DiffFileView
          key={f.path}
          file={f}
          findings={byFile.get(f.path) ?? []}
          focusFindingId={focusFindingId}
          onTriage={props.onTriage}
          onUpdate={props.onUpdate}
          view={props.view}
          onViewChange={props.onViewChange}
          viewed={props.viewed.has(f.path)}
          collapsed={props.collapsed.has(f.path)}
          onToggleViewed={() => props.onToggleViewed(f.path)}
          onToggleCollapsed={() => props.onToggleCollapsed(f.path)}
        />
      ))}
    </div>
  );
}

function DiffFileView({
  file,
  findings,
  focusFindingId,
  onTriage,
  onUpdate,
  view,
  onViewChange,
  viewed,
  collapsed,
  onToggleViewed,
  onToggleCollapsed,
}: {
  file: DiffFile;
  findings: Finding[];
  focusFindingId: string | null;
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
  view: DiffView;
  onViewChange: (v: DiffView) => void;
  viewed: boolean;
  collapsed: boolean;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
}) {
  // 新侧存在的行号集合;锚点不在其中的 finding 归 off-diff
  const newLines = useMemo(() => {
    const s = new Set<number>();
    for (const h of file.hunks) for (const l of h.lines) if (l.newLine != null) s.add(l.newLine);
    return s;
  }, [file]);

  const lang = useMemo(() => langOf(file.path), [file.path]);
  const offDiff = findings.filter((f) => !newLines.has(f.line));
  // 锚定 findings 按新侧行号分组
  const byLine = new Map<number, Finding[]>();
  for (const f of findings) {
    if (!newLines.has(f.line)) continue;
    const arr = byLine.get(f.line) ?? [];
    arr.push(f);
    byLine.set(f.line, arr);
  }

  return (
    <section className={`diff-file${collapsed ? ' collapsed' : ''}`}>
      <div className="file-header" id={fileAnchorId(file.path)}>
        <span className="fp">
          {file.oldPath && file.oldPath !== file.path && (
            <span className="dim">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        <span className="chips">
          {!file.binary && file.hunks.length > 0 && (
            <span className="view-seg">
              {(['unified', 'split'] as DiffView[]).map((v) => (
                <button
                  key={v}
                  className={view === v ? 'on' : ''}
                  onClick={() => onViewChange(v)}
                >
                  {v === 'unified' ? 'Unified' : 'Split'}
                </button>
              ))}
            </span>
          )}
          {findings.length > 0 && <span className="mini fnd">{findings.length} finding</span>}
          {!file.binary && (
            <>
              <span className="mini add">+{file.additions}</span>
              <span className="mini del">−{file.deletions}</span>
            </>
          )}
          <button
            className={`icon-btn${viewed ? ' on' : ''}`}
            title="标记已看并折叠"
            onClick={onToggleViewed}
          >
            ✓
          </button>
          <button className="icon-btn" title="折叠 / 展开" onClick={onToggleCollapsed}>
            ⌄
          </button>
        </span>
      </div>

      {offDiff.length > 0 && (
        <div className="offdiff">
          <div className="offdiff-head">◇ {offDiff.length} 条 off-diff finding(锚点不在当前改动新侧)</div>
          {offDiff.map((f) => (
            <InlineCard
              key={f.id}
              finding={f}
              focused={f.id === focusFindingId}
              onTriage={onTriage}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}

      {collapsed ? (
        <div className="file-collapsed-bar" onClick={onToggleCollapsed}>
          <span className="cb-ic">✓</span>
          {viewed ? '已标记看过 · 内容已折叠' : '内容已折叠'}
          <span className="cb-x">点击展开</span>
        </div>
      ) : file.binary ? (
        <div className="diff-note">二进制文件,不显示逐行 diff。</div>
      ) : file.hunks.length === 0 ? (
        <div className="diff-note">无内容改动(仅重命名/模式变更)。</div>
      ) : (
        file.hunks.map((h, i) => (
          <HunkView
            key={i}
            hunk={h}
            lang={lang}
            byLine={byLine}
            focusFindingId={focusFindingId}
            view={view}
            onTriage={onTriage}
            onUpdate={onUpdate}
          />
        ))
      )}
    </section>
  );
}

interface CardSeg<T> {
  rows: T[];
  cardsAfter: Finding[];
}

/** 把行流按「命中锚点即断段」切成 [段, 卡, 段, 卡, …],unified/split 共用。 */
function segmentByAnchor<T>(
  items: { row: T; anchor: number | null }[],
  byLine: Map<number, Finding[]>,
): CardSeg<T>[] {
  const segs: CardSeg<T>[] = [];
  let cur: T[] = [];
  for (const { row, anchor } of items) {
    cur.push(row);
    const hit = anchor != null ? byLine.get(anchor) : undefined;
    if (hit && hit.length > 0) {
      segs.push({ rows: cur, cardsAfter: hit });
      cur = [];
    }
  }
  if (cur.length > 0) segs.push({ rows: cur, cardsAfter: [] });
  return segs;
}

/** 单个 hunk:在锚点行处把 code 表切段插内联卡(对齐 mockup table → .inline card → table)。 */
function HunkView({
  hunk,
  lang,
  byLine,
  focusFindingId,
  view,
  onTriage,
  onUpdate,
}: {
  hunk: DiffHunk;
  lang: string | null;
  byLine: Map<number, Finding[]>;
  focusFindingId: string | null;
  view: DiffView;
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
}) {
  const cards = (list: Finding[]) =>
    list.map((f) => (
      <InlineCard
        key={f.id}
        finding={f}
        focused={f.id === focusFindingId}
        onTriage={onTriage}
        onUpdate={onUpdate}
      />
    ));

  return (
    <div className="hunk">
      <div className="hunk-label">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.section && <span className="ctx">{hunk.section}</span>}
      </div>
      {view === 'split'
        ? segmentByAnchor(
            toSplitRows(hunk.lines).map((r) => ({ row: r, anchor: r.right?.newLine ?? null })),
            byLine,
          ).map((seg, i) => (
            <div key={i}>
              <table className="code split">
                <tbody>
                  {seg.rows.map((r, j) => (
                    <SplitRow key={j} row={r} lang={lang} />
                  ))}
                </tbody>
              </table>
              {cards(seg.cardsAfter)}
            </div>
          ))
        : segmentByAnchor(
            hunk.lines.map((l) => ({ row: l, anchor: l.newLine })),
            byLine,
          ).map((seg, i) => (
            <div key={i}>
              <table className="code unified">
                <tbody>
                  {seg.rows.map((l, j) => (
                    <LineRow key={j} line={l} lang={lang} />
                  ))}
                </tbody>
              </table>
              {cards(seg.cardsAfter)}
            </div>
          ))}
    </div>
  );
}

interface SplitPair {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** 把 unified 行流配成并排双列:连续 del 与 add 按序两两对齐,context 两侧同行。 */
function toSplitRows(lines: DiffLine[]): SplitPair[] {
  const rows: SplitPair[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

function LineRow({ line, lang }: { line: DiffLine; lang: string | null }) {
  const gutter = line.kind === 'add' ? '＋' : line.kind === 'del' ? '−' : '';
  const lineNo = line.kind === 'del' ? line.oldLine : line.newLine;
  const html = line.text === '' ? '&nbsp;' : highlightLine(line.text, lang);
  return (
    <tr className={`row${line.kind === 'add' ? ' add' : line.kind === 'del' ? ' del' : ''}`}>
      <td className="ln">{lineNo}</td>
      <td className="gutter">{gutter}</td>
      <td className="src" dangerouslySetInnerHTML={{ __html: html }} />
    </tr>
  );
}

function SplitCell({ line, side, lang }: { line: DiffLine | null; side: 'old' | 'new'; lang: string | null }) {
  const lnBase = side === 'new' ? 'ln new' : 'ln';
  const srcBase = side === 'new' ? 'src new' : 'src';
  if (!line) {
    return (
      <>
        <td className={`${lnBase} blank`} />
        <td className={`${srcBase} blank`} />
      </>
    );
  }
  const mod = side === 'new' && line.kind === 'add' ? ' add' : side === 'old' && line.kind === 'del' ? ' del' : '';
  const lineNo = side === 'new' ? line.newLine : line.oldLine;
  const html = line.text === '' ? '&nbsp;' : highlightLine(line.text, lang);
  return (
    <>
      <td className={lnBase + mod}>{lineNo}</td>
      <td className={srcBase + mod} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

function SplitRow({ row, lang }: { row: SplitPair; lang: string | null }) {
  return (
    <tr className="row">
      <SplitCell line={row.left} side="old" lang={lang} />
      <SplitCell line={row.right} side="new" lang={lang} />
    </tr>
  );
}
