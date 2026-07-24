import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffHunk, DiffLine } from '@shared/diff';
import type { Discussion, Finding, Triage } from '@shared/domain';
import type { DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { InlineCard } from './InlineCard';
import { InlineComposer } from './InlineComposer';
import { NewFindingComposer, type NewFindingDraft } from './NewFindingComposer';
import { SelectionPopover } from './SelectionPopover';
import { highlightLine, langOf } from './highlight';

export type DiffView = 'unified' | 'split';

/** 内联 composer 的两种形态:发起 discussion 或 新增 finding。 */
type ComposeMode = 'discussion' | 'finding';
interface Compose {
  pick: AnchorPick;
  mode: ComposeMode;
}

/** 文件锚点 id:供左栏点击滚动定位。路径里的非单词字符替换成 -。 */
export function fileAnchorId(path: string): string {
  return 'df-' + path.replace(/[^\w]+/g, '-');
}

const basename = (p: string) => p.split('/').pop() ?? p;
/** 目录段(含尾部 /);根目录文件返回空串 */
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

/** 非常规状态的文件在 file-header 标一枚 pill;modified 是默认、不标以免噪音。 */
const FILE_STATUS_LABEL: Partial<Record<DiffFile['status'], string>> = {
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
};

/** diff 内锚点:发起 discussion / 追问 codex 时携带的选区信息 */
interface AnchorPick {
  anchor: DiscussionAnchor;
  /** 内联 composer 插入位置(新侧行号) */
  placeLine: number;
  label: string;
  snippet: string;
}

/** 某新侧行上的锚点标记(gutter 圆点):agent(codex finding)/ human(用户讨论·手动 finding)。 */
interface AnchorMark {
  tone: 'agent' | 'human';
  finding?: Finding;
  discussionId?: string;
}

/** gutter 圆点:标记该行有 finding / 讨论,点击跳到对应卡片或 Discussion 线程。 */
function AnchorDot({ mark, onClick }: { mark: AnchorMark; onClick: (m: AnchorMark) => void }) {
  return (
    <span
      className={`anchor ${mark.tone}`}
      title={mark.finding ? '跳到该 finding' : '跳到该 discussion'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(mark);
      }}
    />
  );
}

export interface DiffPaneProps {
  files: DiffFile[];
  findings: Finding[];
  /** 讨论(含 user 线程);用于在 gutter 给有讨论/finding 的行打锚点圆点 */
  discussions?: Discussion[];
  /** 左栏选中的文件路径;变化时滚动到对应 file-header */
  activePath: string | null;
  /** 右栏点选的 finding;变化时滚动到内联卡并高亮 */
  focusFindingId: string | null;
  /** review 当前轮次;内联卡据此显示「本轮新增 / 已修复」标记 */
  currentRound?: number;
  /** finding 写路径:裁决 / 就地编辑,缺省则内联卡为只读 */
  onTriage?: (finding: Finding, triage: Triage, reason?: string | null) => void;
  onUpdate?: (input: FindingEditInput) => void;
  /** 框选 / hover ＋ 发起 discussion:创建 user discussion 并发出首问 */
  onStartDiscussion?: (anchor: DiscussionAnchor, text: string) => void;
  /** 追问 codex:把选区作为引用带进 Discussion 栏 composer */
  onAskCodex?: (anchor: DiscussionAnchor, label: string) => void;
  /** 框选「记为 finding」:在锚点处填写后新增一条 manual finding */
  onAddFinding?: (anchor: DiscussionAnchor, draft: NewFindingDraft) => void;
  /** 内联 finding 卡「追问」:切 Discussion 栏并选中该 finding 的承载线程 */
  onDiscussFinding?: (finding: Finding) => void;
  /** 点 gutter 圆点跳转:finding → 聚焦内联卡;user discussion → 切 Discussion 栏 */
  onJumpFinding?: (finding: Finding) => void;
  onJumpDiscussion?: (discussionId: string) => void;
  /** 按需拉取文件新侧全文,用于展开 diff 外上下文;缺省则不显示展开控件(如预览)。 */
  fetchFileContent?: (path: string) => Promise<string | null>;
  /** unified / split 视图(全局偏好,底部状态栏驱动) */
  view: DiffView;
  /** per-file 已看 / 折叠(本地态) */
  viewed: Set<string>;
  collapsed: Set<string>;
  onToggleViewed: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
}

/**
 * 中栏 diff 主场:unified/split 双视图 + 锚定内联 finding 卡 +
 * 框选 / 行内 ＋ 发起 discussion。selection popover 与内联 composer 都由本组件托管;
 * 发起后交由 ReviewScreen 落库并在 Discussion 栏承载对话。
 */
export function DiffPane(props: DiffPaneProps) {
  const {
    files,
    findings,
    discussions,
    activePath,
    focusFindingId,
    onStartDiscussion,
    onAskCodex,
    onAddFinding,
    onJumpFinding,
    onJumpDiscussion,
  } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ pick: AnchorPick; top: number; left: number; cx: number } | null>(null);
  const [composeAt, setComposeAt] = useState<Compose | null>(null);

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

  // 文件整体不在本次 diff 内的 finding(允许 agent off-diff 报到被引用文件):
  // 没有对应 DiffFileView 承载,单独成区并挂 fileAnchorId,否则点卡片 setActivePath 无锚点可滚。
  const absentByFile = useMemo(() => {
    const diffPaths = new Set(files.map((f) => f.path));
    const m = new Map<string, Finding[]>();
    for (const f of findings) {
      if (diffPaths.has(f.file)) continue;
      const arr = m.get(f.file) ?? [];
      arr.push(f);
      m.set(f.file, arr);
    }
    return m;
  }, [findings, files]);

  // 按文件聚合 user discussions(有锚点、非 finding),用于 gutter 打点
  const discByFile = useMemo(() => {
    const m = new Map<string, Discussion[]>();
    for (const d of discussions ?? []) {
      if (d.kind !== 'user' || !d.file) continue;
      const arr = m.get(d.file) ?? [];
      arr.push(d);
      m.set(d.file, arr);
    }
    return m;
  }, [discussions]);

  const onAnchorClick = useCallback(
    (mark: AnchorMark) => {
      if (mark.finding) onJumpFinding?.(mark.finding);
      else if (mark.discussionId) onJumpDiscussion?.(mark.discussionId);
    },
    [onJumpFinding, onJumpDiscussion],
  );

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

  // ---- 框选 → popover:解析选区新侧锚点 + 定位 ----
  const canStart = !!onStartDiscussion;
  const onMouseUp = useCallback(() => {
    if (!canStart) return;
    // 等浏览器把 selection 敲定后再读
    setTimeout(() => {
      const pane = ref.current;
      const selection = window.getSelection();
      if (!pane || !selection || selection.isCollapsed || !selection.toString().trim()) {
        setSel(null);
        return;
      }
      const startRow = rowOf(selection.anchorNode);
      const endRow = rowOf(selection.focusNode);
      if (!startRow || !pane.contains(startRow)) {
        setSel(null);
        return;
      }
      const rows = rowsBetween(startRow, endRow);
      const withLine = rows
        .map((r) => ({ r, line: rowNewLine(r) }))
        .filter((x): x is { r: HTMLElement; line: number } => x.line != null);
      const fileEl = startRow.closest('.diff-file') as HTMLElement | null;
      const file = fileEl?.getAttribute('data-path') ?? null;
      if (!file || withLine.length === 0) {
        setSel(null); // 纯删除行 / 越界:无新侧行不可锚定
        return;
      }
      const first = withLine[0].line;
      const last = withLine[withLine.length - 1].line;
      const label = `${basename(file)}:${first === last ? first : `${first}–${last}`}`;
      const snippet = snippetOf(withLine[withLine.length - 1].r);
      const pick: AnchorPick = {
        anchor: { file, line: first, lineEnd: first === last ? null : last },
        placeLine: last,
        label,
        snippet,
      };
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const pw = 340; // 三动作按钮的估算宽度(定位/箭头居中用)
      let left = rect.left + rect.width / 2 - pw / 2;
      left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
      let top = rect.top - 44;
      if (top < 58) top = rect.bottom + 9;
      const cx = Math.max(14, Math.min(pw - 14, rect.left + rect.width / 2 - left));
      setSel({ pick, top, left, cx });
    }, 0);
  }, [canStart]);

  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.sel-pop')) setSel(null);
    };
    const onScroll = () => setSel(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [sel]);

  const startCompose = (pick: AnchorPick, mode: ComposeMode) => {
    setSel(null);
    window.getSelection()?.removeAllRanges();
    setComposeAt({ pick, mode });
  };

  if (files.length === 0 && absentByFile.size === 0) {
    return (
      <div className="diff pane" ref={ref}>
        <p className="diff-empty">暂无 diff。扫描期会在拉取改动后显示。</p>
      </div>
    );
  }

  return (
    <div className="diff pane" ref={ref} onMouseUp={onMouseUp}>
      {files.map((f) => (
        <DiffFileView
          key={f.path}
          file={f}
          findings={byFile.get(f.path) ?? []}
          discussions={discByFile.get(f.path) ?? []}
          onAnchorClick={onAnchorClick}
          focusFindingId={focusFindingId}
          currentRound={props.currentRound ?? 1}
          onTriage={props.onTriage}
          onUpdate={props.onUpdate}
          onDiscussFinding={props.onDiscussFinding}
          view={props.view}
          fetchFileContent={props.fetchFileContent}
          viewed={props.viewed.has(f.path)}
          collapsed={props.collapsed.has(f.path)}
          onToggleViewed={() => props.onToggleViewed(f.path)}
          onToggleCollapsed={() => props.onToggleCollapsed(f.path)}
          onAddThread={
            canStart
              ? (line, snippet) =>
                  startCompose(
                    {
                      anchor: { file: f.path, line, lineEnd: null },
                      placeLine: line,
                      label: `${basename(f.path)}:${line}`,
                      snippet,
                    },
                    'discussion',
                  )
              : undefined
          }
          compose={composeAt && composeAt.pick.anchor.file === f.path ? composeAt : null}
          onSendCompose={(text) => {
            if (composeAt) onStartDiscussion?.(composeAt.pick.anchor, text);
            setComposeAt(null);
          }}
          onCreateFinding={(draft) => {
            if (composeAt) onAddFinding?.(composeAt.pick.anchor, draft);
            setComposeAt(null);
          }}
          onCancelCompose={() => setComposeAt(null)}
        />
      ))}

      {[...absentByFile.entries()].map(([path, fs]) => (
        <div key={path} className="offdiff absent" id={fileAnchorId(path)}>
          <div className="offdiff-head">◇ 文件不在本次改动内 · <span className="mono">{path}</span></div>
          {fs.map((f) => (
            <InlineCard
              key={f.id}
              finding={f}
              focused={f.id === focusFindingId}
              offDiff
              currentRound={props.currentRound ?? 1}
              onTriage={props.onTriage}
              onUpdate={props.onUpdate}
              onDiscuss={props.onDiscussFinding}
            />
          ))}
        </div>
      ))}

      {sel && (
        <SelectionPopover
          label={sel.pick.label}
          top={sel.top}
          left={sel.left}
          cx={sel.cx}
          onDiscussion={() => startCompose(sel.pick, 'discussion')}
          onAsk={() => {
            onAskCodex?.(sel.pick.anchor, sel.pick.label);
            setSel(null);
            window.getSelection()?.removeAllRanges();
          }}
          onFinding={() => startCompose(sel.pick, 'finding')}
        />
      )}
    </div>
  );
}

/** 选中节点向上找到所在 diff 行 */
function rowOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return el?.closest?.('.row') ?? null;
}

/** 行的新侧行号(data-new-line);删除行无 */
function rowNewLine(tr: HTMLElement): number | null {
  const v = tr.getAttribute('data-new-line');
  return v ? Number(v) : null;
}

/** 同一 tbody 内取 a..b 之间的所有行 */
function rowsBetween(a: HTMLElement, b: HTMLElement | null): HTMLElement[] {
  if (!b) return [a];
  const tb = a.closest('tbody');
  if (!tb || b.closest('tbody') !== tb) return [a, b];
  const all = [...tb.querySelectorAll<HTMLElement>('.row')];
  let i = all.indexOf(a);
  let j = all.indexOf(b);
  if (i > j) [i, j] = [j, i];
  return all.slice(i, j + 1);
}

/** 行的新侧源码片段(优先 .src.new) */
function snippetOf(tr: HTMLElement): string {
  const el = tr.querySelector('.src.new') ?? tr.querySelector('.src');
  return (el?.textContent ?? '').trim().slice(0, 60);
}

/** 每次点「展开」揭示的行数(diff 外上下文);贴近改动逐块展开,超大间隙不一次性铺满。 */
const CTX_CHUNK = 40;

/** diff 未覆盖的隐藏区间(hunk 之间 / 首尾),供按需展开新侧上下文。 */
interface Gap {
  key: string;
  side: 'lead' | 'mid' | 'trail';
  /** 首个隐藏新侧行号 */
  newFrom: number;
  /** 末个隐藏新侧行号;trail 未知(取文件行数),先置 MAX 待拉全文后收敛 */
  newTo: number;
  /** oldLine = newLine + oldOffset(区间内不变) */
  oldOffset: number;
}

/** 由 hunk 头推出各隐藏区间(首部 / hunk 间 / 尾部);行号信息足以定位,不需文件内容。 */
function buildGaps(hunks: DiffHunk[]): { lead: Gap | null; between: (Gap | null)[]; trail: Gap | null } {
  if (hunks.length === 0) return { lead: null, between: [], trail: null };
  const first = hunks[0];
  const lead: Gap | null =
    first.newStart > 1
      ? { key: 'lead', side: 'lead', newFrom: 1, newTo: first.newStart - 1, oldOffset: first.oldStart - first.newStart }
      : null;
  const between: (Gap | null)[] = [];
  for (let i = 0; i < hunks.length - 1; i++) {
    const a = hunks[i];
    const b = hunks[i + 1];
    const newFrom = a.newStart + a.newCount;
    const newTo = b.newStart - 1;
    between.push(
      newFrom <= newTo
        ? {
            key: `mid-${i}`,
            side: 'mid',
            newFrom,
            newTo,
            oldOffset: a.oldStart + a.oldCount - (a.newStart + a.newCount),
          }
        : null,
    );
  }
  const last = hunks[hunks.length - 1];
  const trailFrom = last.newStart + last.newCount;
  const trail: Gap = {
    key: 'trail',
    side: 'trail',
    newFrom: trailFrom,
    newTo: Number.MAX_SAFE_INTEGER,
    oldOffset: last.oldStart + last.oldCount - (last.newStart + last.newCount),
  };
  return { lead, between, trail };
}

/** 由新侧行号构造一条 context 行(用于展开的 diff 外上下文)。 */
function ctxLine(n: number, lines: string[], oldOffset: number): DiffLine {
  return { kind: 'context', oldLine: n + oldOffset, newLine: n, text: lines[n - 1] ?? '' };
}

/** 一段 context 行的 code 表(复用 LineRow/SplitRow,故选区发起 discussion、锚点圆点均沿用)。 */
function ContextTable({
  lines,
  view,
  lang,
  onAddThread,
  anchorByLine,
  onAnchorClick,
}: {
  lines: DiffLine[];
  view: DiffView;
  lang: string | null;
  onAddThread?: (line: number, snippet: string) => void;
  anchorByLine: Map<number, AnchorMark>;
  onAnchorClick: (mark: AnchorMark) => void;
}) {
  return view === 'split' ? (
    <table className="code split">
      <tbody>
        {lines.map((l, j) => (
          <SplitRow
            key={j}
            row={{ left: l, right: l }}
            lang={lang}
            onAddThread={onAddThread}
            anchorByLine={anchorByLine}
            onAnchorClick={onAnchorClick}
          />
        ))}
      </tbody>
    </table>
  ) : (
    <table className="code unified">
      <tbody>
        {lines.map((l, j) => (
          <LineRow
            key={j}
            line={l}
            lang={lang}
            onAddThread={onAddThread}
            anchorByLine={anchorByLine}
            onAnchorClick={onAnchorClick}
          />
        ))}
      </tbody>
    </table>
  );
}

/** 展开条文案:按区间位置给方向词;超过一屏块时只说本次揭示的行数,否则说剩余全部。 */
function gapLabel(side: Gap['side'], remaining: number | null): string {
  if (remaining == null) return '展开下方未改动 · 至文件末尾'; // 尾部未拉全文,行数未知
  const many = remaining > CTX_CHUNK;
  const n = many ? CTX_CHUNK : remaining;
  if (side === 'lead') return many ? `展开上方 ${n} 行` : `展开上方 ${n} 行未改动`;
  if (side === 'trail') return many ? `展开下方 ${n} 行` : `展开下方 ${n} 行 · 至文件末尾`;
  return many ? `展开 ${n} 行` : `展开 ${n} 行未改动`;
}

/**
 * 隐藏区间的整行展开条:贴近改动逐块揭示未改动上下文——首部向上、
 * hunk 间与尾部向下。尾部在拉到全文前行数未知,只显方向;拉全文后若无剩余行(末改动即 EOF)则整条隐藏。
 */
function GapExpander({
  gap,
  view,
  lang,
  fileLines,
  loading,
  revealed,
  onExpand,
  onAddThread,
  anchorByLine,
  onAnchorClick,
}: {
  gap: Gap;
  view: DiffView;
  lang: string | null;
  fileLines: string[] | null;
  loading: boolean;
  revealed: number;
  onExpand: () => void;
  onAddThread?: (line: number, snippet: string) => void;
  anchorByLine: Map<number, AnchorMark>;
  onAnchorClick: (mark: AnchorMark) => void;
}) {
  const bounded = gap.side !== 'trail' || fileLines != null;
  const newTo = gap.side === 'trail' && fileLines ? fileLines.length : gap.newTo;
  if (bounded && newTo < gap.newFrom) return null; // 尾部区间实为 EOF,无可展开
  const total = bounded ? Math.max(0, newTo - gap.newFrom + 1) : null; // null = 尾部未知
  const remaining = total == null ? null : Math.max(0, total - revealed);
  const ctxProps = { view, lang, onAddThread, anchorByLine, onAnchorClick };

  // 首部贴着下方 hunk 向上揭示(取区间末段);其余贴着上方 hunk 向下揭示(取区间首段)
  const revealedLines =
    fileLines && revealed > 0
      ? gap.side === 'lead'
        ? Array.from({ length: revealed }, (_, i) => ctxLine(newTo - revealed + 1 + i, fileLines, gap.oldOffset))
        : Array.from({ length: revealed }, (_, i) => ctxLine(gap.newFrom + i, fileLines, gap.oldOffset))
      : [];
  const revealedTable = revealedLines.length > 0 ? <ContextTable lines={revealedLines} {...ctxProps} /> : null;

  if (remaining === 0) return revealedTable; // 全部展开完,收起条

  const hiddenFrom = gap.side === 'lead' ? gap.newFrom : gap.newFrom + revealed;
  const hiddenTo = gap.side === 'lead' ? newTo - revealed : newTo;
  const rng = remaining == null ? '' : hiddenFrom === hiddenTo ? `${hiddenFrom}` : `${hiddenFrom}–${hiddenTo}`;

  const bar = (
    <div className="gap-bar" title="展开未改动代码" onClick={loading ? undefined : onExpand}>
      <span className="gap-ic">↕</span>
      <span className="gap-label">{loading ? '载入中…' : gapLabel(gap.side, remaining)}</span>
      {rng && <span className="gap-rng">{rng}</span>}
    </div>
  );

  // 首部:条在上、揭示的行贴着下方 hunk;其余:揭示的行贴着上方 hunk、条在下
  return gap.side === 'lead' ? (
    <>
      {bar}
      {revealedTable}
    </>
  ) : (
    <>
      {revealedTable}
      {bar}
    </>
  );
}

function DiffFileView({
  file,
  findings,
  discussions,
  onAnchorClick,
  focusFindingId,
  currentRound,
  onTriage,
  onUpdate,
  onDiscussFinding,
  view,
  fetchFileContent,
  viewed,
  collapsed,
  onToggleViewed,
  onToggleCollapsed,
  onAddThread,
  compose,
  onSendCompose,
  onCreateFinding,
  onCancelCompose,
}: {
  file: DiffFile;
  findings: Finding[];
  discussions: Discussion[];
  onAnchorClick: (mark: AnchorMark) => void;
  focusFindingId: string | null;
  currentRound: number;
  onTriage?: (finding: Finding, triage: Triage, reason?: string | null) => void;
  onUpdate?: (input: FindingEditInput) => void;
  onDiscussFinding?: (finding: Finding) => void;
  view: DiffView;
  fetchFileContent?: (path: string) => Promise<string | null>;
  viewed: boolean;
  collapsed: boolean;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
  onAddThread?: (line: number, snippet: string) => void;
  compose: Compose | null;
  onSendCompose: (text: string) => void;
  onCreateFinding: (draft: NewFindingDraft) => void;
  onCancelCompose: () => void;
}) {
  // 新侧存在的行号集合;锚点不在其中的 finding 归 off-diff
  const newLines = useMemo(() => {
    const s = new Set<number>();
    for (const h of file.hunks) for (const l of h.lines) if (l.newLine != null) s.add(l.newLine);
    return s;
  }, [file]);

  // 每个新侧行的锚点圆点:finding(agent 优先)> user discussion;off-diff 不打点
  const anchorByLine = useMemo(() => {
    const m = new Map<number, AnchorMark>();
    for (const f of findings) {
      if (!newLines.has(f.line)) continue;
      const tone = f.origin === 'agent' ? 'agent' : 'human';
      const prev = m.get(f.line);
      if (!prev || (tone === 'agent' && prev.tone !== 'agent')) m.set(f.line, { tone, finding: f });
    }
    for (const d of discussions) {
      if (d.line == null || !newLines.has(d.line) || m.has(d.line)) continue;
      m.set(d.line, { tone: 'human', discussionId: d.id });
    }
    return m;
  }, [findings, discussions, newLines]);

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

  // ---- diff 外上下文展开:按需拉文件新侧全文并缓存,记录各 gap 已展开的行数 ----
  // 新增/删除文件整份即在 diff 里(无 diff 外上下文),不给展开控件以免留下点了无效的空条。
  const canExpand =
    !!fetchFileContent && !file.binary && file.status !== 'added' && file.status !== 'deleted';
  const gaps = useMemo(() => buildGaps(file.hunks), [file.hunks]);
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [reveal, setReveal] = useState<Record<string, number>>({});

  const ensureFile = useCallback(async (): Promise<string[] | null> => {
    if (fileLines) return fileLines;
    if (!fetchFileContent) return null;
    setLoadingCtx(true);
    try {
      const raw = await fetchFileContent(file.path);
      if (raw == null) return null;
      const lines = raw.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 去掉末换行 split 残留
      setFileLines(lines);
      return lines;
    } catch {
      return null;
    } finally {
      setLoadingCtx(false);
    }
  }, [fileLines, fetchFileContent, file.path]);

  const expand = useCallback(
    async (gap: Gap) => {
      const lines = await ensureFile();
      if (!lines) return;
      setReveal((r) => {
        const cur = r[gap.key] ?? 0;
        const newTo = gap.side === 'trail' ? lines.length : gap.newTo;
        const remaining = Math.max(0, newTo - gap.newFrom + 1 - cur);
        if (remaining <= 0) return r;
        return { ...r, [gap.key]: cur + Math.min(CTX_CHUNK, remaining) };
      });
    },
    [ensureFile],
  );

  const gapNode = (gap: Gap | null) =>
    gap && canExpand ? (
      <GapExpander
        gap={gap}
        view={view}
        lang={lang}
        fileLines={fileLines}
        loading={loadingCtx}
        revealed={reveal[gap.key] ?? 0}
        onExpand={() => expand(gap)}
        onAddThread={onAddThread}
        anchorByLine={anchorByLine}
        onAnchorClick={onAnchorClick}
      />
    ) : null;

  const composeNode = compose ? (
    compose.mode === 'finding' ? (
      <NewFindingComposer
        label={compose.pick.label}
        snippet={compose.pick.snippet}
        onCreate={onCreateFinding}
        onCancel={onCancelCompose}
      />
    ) : (
      <InlineComposer
        label={compose.pick.label}
        snippet={compose.pick.snippet}
        onSend={onSendCompose}
        onCancel={onCancelCompose}
      />
    )
  ) : null;

  return (
    <section className={`diff-file${collapsed ? ' collapsed' : ''}`} data-path={file.path}>
      <div className="file-header" id={fileAnchorId(file.path)}>
        <div className="fh-id">
          <div className="fh-line1">
            <span className="fh-name" title={file.path}>{basename(file.path)}</span>
            {FILE_STATUS_LABEL[file.status] && (
              <span className={`fstat ${file.status}`}>{FILE_STATUS_LABEL[file.status]}</span>
            )}
            {file.binary && <span className="fstat binary">二进制</span>}
          </div>
          {/* 路径退居次要行;超长时从头部省略(尾部目录更有辨识度) */}
          <div className="fh-path" title={file.path}>
            <bdi>
              {dirname(file.path)}
              {file.oldPath && file.oldPath !== file.path && (
                <span className="fh-rename"> ← {file.oldPath}</span>
              )}
            </bdi>
          </div>
        </div>
        <div className="fh-meta">
          {findings.length > 0 && <span className="fh-fnd">⚑ {findings.length}</span>}
          {!file.binary && (
            <span className="fh-num">
              <span className="a">+{file.additions}</span>
              <span className="d">−{file.deletions}</span>
            </span>
          )}
          <span className="fh-acts">
            <button
              className={`icon-btn${viewed ? ' on' : ''}`}
              title="标记已看并折叠"
              aria-pressed={viewed}
              onClick={onToggleViewed}
            >
              ✓
            </button>
            <button className="icon-btn" title="折叠 / 展开" onClick={onToggleCollapsed}>
              ⌄
            </button>
          </span>
        </div>
      </div>

      {offDiff.length > 0 && (
        <div className="offdiff">
          <div className="offdiff-head">◇ {offDiff.length} 条 off-diff finding(锚点不在当前改动新侧)</div>
          {offDiff.map((f) => (
            <InlineCard
              key={f.id}
              finding={f}
              focused={f.id === focusFindingId}
              offDiff
              currentRound={currentRound}
              onTriage={onTriage}
              onUpdate={onUpdate}
              onDiscuss={onDiscussFinding}
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
        <>
          {gapNode(gaps.lead)}
          {file.hunks.map((h, i) => (
            <Fragment key={i}>
              <HunkView
                hunk={h}
                lang={lang}
                byLine={byLine}
                anchorByLine={anchorByLine}
                onAnchorClick={onAnchorClick}
                focusFindingId={focusFindingId}
                view={view}
                currentRound={currentRound}
                onTriage={onTriage}
                onUpdate={onUpdate}
                onDiscussFinding={onDiscussFinding}
                onAddThread={onAddThread}
                composeLine={compose?.pick.placeLine ?? null}
                composeNode={composeNode}
              />
              {gapNode(gaps.between[i] ?? null)}
            </Fragment>
          ))}
          {gapNode(gaps.trail)}
        </>
      )}
    </section>
  );
}

interface CardSeg<T> {
  rows: T[];
  /** 该段结尾命中的新侧行号(用于取 finding 卡 / 插 composer);无则 null */
  endAnchor: number | null;
}

/** 把行流按断点切成 [段, (卡/composer), 段, …];断点 = 有 finding 或正是 composeLine。 */
function segmentByAnchor<T>(
  items: { row: T; anchor: number | null }[],
  shouldBreak: (anchor: number) => boolean,
): CardSeg<T>[] {
  const segs: CardSeg<T>[] = [];
  let cur: T[] = [];
  for (const { row, anchor } of items) {
    cur.push(row);
    if (anchor != null && shouldBreak(anchor)) {
      segs.push({ rows: cur, endAnchor: anchor });
      cur = [];
    }
  }
  if (cur.length > 0) segs.push({ rows: cur, endAnchor: null });
  return segs;
}

/** 单个 hunk:在锚点行处把 code 表切段插内联卡 / composer(结构:table → 卡 → table)。 */
function HunkView({
  hunk,
  lang,
  byLine,
  anchorByLine,
  onAnchorClick,
  focusFindingId,
  view,
  currentRound,
  onTriage,
  onUpdate,
  onDiscussFinding,
  onAddThread,
  composeLine,
  composeNode,
}: {
  hunk: DiffHunk;
  lang: string | null;
  byLine: Map<number, Finding[]>;
  anchorByLine: Map<number, AnchorMark>;
  onAnchorClick: (mark: AnchorMark) => void;
  focusFindingId: string | null;
  view: DiffView;
  currentRound: number;
  onTriage?: (finding: Finding, triage: Triage, reason?: string | null) => void;
  onUpdate?: (input: FindingEditInput) => void;
  onDiscussFinding?: (finding: Finding) => void;
  onAddThread?: (line: number, snippet: string) => void;
  composeLine: number | null;
  composeNode: React.ReactNode;
}) {
  const textByNewLine = new Map<number, string>();
  for (const l of hunk.lines) if (l.newLine != null) textByNewLine.set(l.newLine, l.text);

  const cards = (line: number | null) =>
    (line != null ? byLine.get(line) ?? [] : []).map((f) => (
      <InlineCard
        key={f.id}
        finding={f}
        focused={f.id === focusFindingId}
        originalLine={textByNewLine.get(f.line)}
        currentRound={currentRound}
        onTriage={onTriage}
        onUpdate={onUpdate}
        onDiscuss={onDiscussFinding}
      />
    ));

  const shouldBreak = (anchor: number) => byLine.has(anchor) || anchor === composeLine;

  return (
    <div className="hunk">
      <div className="hunk-label">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.section && <span className="ctx">{hunk.section}</span>}
      </div>
      {view === 'split'
        ? segmentByAnchor(
            toSplitRows(hunk.lines).map((r) => ({ row: r, anchor: r.right?.newLine ?? null })),
            shouldBreak,
          ).map((seg, i) => (
            <div key={i}>
              <table className="code split">
                <tbody>
                  {seg.rows.map((r, j) => (
                    <SplitRow
                      key={j}
                      row={r}
                      lang={lang}
                      onAddThread={onAddThread}
                      anchorByLine={anchorByLine}
                      onAnchorClick={onAnchorClick}
                    />
                  ))}
                </tbody>
              </table>
              {cards(seg.endAnchor)}
              {seg.endAnchor === composeLine && composeNode}
            </div>
          ))
        : segmentByAnchor(
            hunk.lines.map((l) => ({ row: l, anchor: l.newLine })),
            shouldBreak,
          ).map((seg, i) => (
            <div key={i}>
              <table className="code unified">
                <tbody>
                  {seg.rows.map((l, j) => (
                    <LineRow
                      key={j}
                      line={l}
                      lang={lang}
                      onAddThread={onAddThread}
                      anchorByLine={anchorByLine}
                      onAnchorClick={onAnchorClick}
                    />
                  ))}
                </tbody>
              </table>
              {cards(seg.endAnchor)}
              {seg.endAnchor === composeLine && composeNode}
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

/** hover 才显影的行内「发起 discussion」＋(仅新侧行) */
function AddThread({ line, text, onAddThread }: { line: number; text: string; onAddThread?: (line: number, snippet: string) => void }) {
  if (!onAddThread) return null;
  return (
    <button
      className="add-thread"
      title="发起 discussion"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onAddThread(line, text.trim().slice(0, 60));
      }}
    >
      ＋
    </button>
  );
}

function LineRow({
  line,
  lang,
  onAddThread,
  anchorByLine,
  onAnchorClick,
}: {
  line: DiffLine;
  lang: string | null;
  onAddThread?: (line: number, snippet: string) => void;
  anchorByLine: Map<number, AnchorMark>;
  onAnchorClick: (mark: AnchorMark) => void;
}) {
  const gutter = line.kind === 'add' ? '＋' : line.kind === 'del' ? '−' : '';
  const lineNo = line.kind === 'del' ? line.oldLine : line.newLine;
  const mark = line.newLine != null ? anchorByLine.get(line.newLine) : undefined;
  const html = line.text === '' ? '&nbsp;' : highlightLine(line.text, lang);
  return (
    <tr
      className={`row${line.kind === 'add' ? ' add' : line.kind === 'del' ? ' del' : ''}`}
      data-new-line={line.newLine ?? undefined}
    >
      <td className="ln">{lineNo}</td>
      <td className="gutter">
        {mark ? <AnchorDot mark={mark} onClick={onAnchorClick} /> : gutter}
      </td>
      <td className="src">
        <span dangerouslySetInnerHTML={{ __html: html }} />
        {line.newLine != null && <AddThread line={line.newLine} text={line.text} onAddThread={onAddThread} />}
      </td>
    </tr>
  );
}

function SplitCell({
  line,
  side,
  lang,
  onAddThread,
  mark,
  onAnchorClick,
}: {
  line: DiffLine | null;
  side: 'old' | 'new';
  lang: string | null;
  onAddThread?: (line: number, snippet: string) => void;
  mark?: AnchorMark;
  onAnchorClick?: (mark: AnchorMark) => void;
}) {
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
      <td className={`${lnBase}${mod}${mark ? ' has-anchor' : ''}`}>
        {mark && onAnchorClick && <AnchorDot mark={mark} onClick={onAnchorClick} />}
        {lineNo}
      </td>
      <td className={srcBase + mod}>
        <span dangerouslySetInnerHTML={{ __html: html }} />
        {side === 'new' && line.newLine != null && (
          <AddThread line={line.newLine} text={line.text} onAddThread={onAddThread} />
        )}
      </td>
    </>
  );
}

function SplitRow({
  row,
  lang,
  onAddThread,
  anchorByLine,
  onAnchorClick,
}: {
  row: SplitPair;
  lang: string | null;
  onAddThread?: (line: number, snippet: string) => void;
  anchorByLine: Map<number, AnchorMark>;
  onAnchorClick: (mark: AnchorMark) => void;
}) {
  const mark = row.right?.newLine != null ? anchorByLine.get(row.right.newLine) : undefined;
  return (
    <tr className="row" data-new-line={row.right?.newLine ?? undefined}>
      <SplitCell line={row.left} side="old" lang={lang} />
      <SplitCell
        line={row.right}
        side="new"
        lang={lang}
        onAddThread={onAddThread}
        mark={mark}
        onAnchorClick={onAnchorClick}
      />
    </tr>
  );
}
