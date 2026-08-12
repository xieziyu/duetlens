import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DiffFile, DiffHunk, DiffLine } from '@shared/diff';
import type { Discussion, Finding, Triage } from '@shared/domain';
import type { DiscussionAnchor, FindingEditInput } from '@shared/ipc';
import { InlineCard } from './InlineCard';
import { AnnotateComposer, type NewFindingDraft } from './AnnotateComposer';
import { PencilIcon } from './PencilIcon';
import { SelectionPopover } from './SelectionPopover';
import { DiffFindBar } from './DiffFindBar';
import { primaryModifier } from '../../keys';
import {
  clearMatches,
  findMatches,
  hitKey,
  matchKey,
  matchCell,
  paintCurrent,
  paintMatches,
  scrollToMatch,
  selectionSeed,
  type FindFile,
  type FindLine,
  type FindMatch,
  type FindOptions,
} from './diff-find';
import { highlightLine, langOf } from './highlight';

export type DiffView = 'unified' | 'split';

interface Compose {
  pick: AnchorPick;
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

/** diff 列头的视图切换:图标 + 文字,让「这是排版方式」一眼可辨(快捷键 ⌘U)。 */
function ViewSwitch({ view, onChange }: { view: DiffView; onChange: (v: DiffView) => void }) {
  return (
    <span className="db-seg" role="group" aria-label="diff 视图">
      {(['unified', 'split'] as DiffView[]).map((v) => (
        <button
          key={v}
          className={view === v ? 'on' : ''}
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          title={`${v === 'unified' ? '单栏对照' : '左右分栏'} diff(快捷键 ⌘U 切换)`}
        >
          <ViewIcon view={v} />
          {v === 'unified' ? 'Unified' : 'Split'}
        </button>
      ))}
    </span>
  );
}

const ViewIcon = ({ view }: { view: DiffView }) =>
  view === 'unified' ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
      <path d="M3.2 4.3h5.6M3.2 6h5.6M3.2 7.7h3.4" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
      <path d="M6 1.5v9M2.7 4.6h1.9M2.7 6.6h1.9M7.4 4.6h1.9M7.4 6.6h1.9" />
    </svg>
  );

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
  onStartDiscussion?: (anchor: DiscussionAnchor, text: string) => void | Promise<void>;
  /** 框选「记为 finding」:在锚点处填写后新增一条 manual finding */
  onAddFinding?: (anchor: DiscussionAnchor, draft: NewFindingDraft) => void | Promise<void>;
  /** 内联 finding 卡「追问」:切 Discussion 栏并选中该 finding 的承载线程 */
  onDiscussFinding?: (finding: Finding) => void;
  /** 点 gutter 圆点跳转:finding → 聚焦内联卡;user discussion → 切 Discussion 栏 */
  onJumpFinding?: (finding: Finding) => void;
  onJumpDiscussion?: (discussionId: string) => void;
  /** 按需拉取文件新侧全文,用于展开 diff 外上下文;缺省则不显示展开控件(如预览)。 */
  fetchFileContent?: (path: string) => Promise<string | null>;
  /** unified / split 视图(全局偏好) */
  view: DiffView;
  /** 切换视图;缺省则列头不显示切换控件(如预览的只读场景) */
  onViewChange?: (v: DiffView) => void;
  /** per-file 已看 / 折叠(本地态) */
  viewed: Set<string>;
  collapsed: Set<string>;
  onToggleViewed: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
  /** 「标记已看即折叠」偏好;开启时标记已看会自动推进到下一个未看文件 */
  collapseOnViewed?: boolean;
  /** 自动推进时同步左栏选中;缺省则只滚动不改选中(如预览) */
  onSelectFile?: (path: string) => void;
  /** 只展开不折叠:⌘F 跳到折叠文件里的命中时先把它展开 */
  onExpandFile?: (path: string) => void;
  /** ⌘F 请求打开 diff 内检索;每次按下自增,重复按即把焦点抢回输入框。0 / 缺省 = 未开启 */
  findNonce?: number;
  /** 模态弹层(如快捷键帮助)开着:检索自己的全局键位让位,别在弹层背后动 diff */
  keysSuspended?: boolean;
  /** 检索条自行关闭(Esc / ✕)时回报,好让屏侧的 nonce 归零 */
  onFindClose?: () => void;
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
    onAddFinding,
    onJumpFinding,
    onJumpDiscussion,
  } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ pick: AnchorPick; top: number; left: number } | null>(null);
  const [composeAt, setComposeAt] = useState<Compose | null>(null);

  // ---- diff 外上下文展开:按需拉文件新侧全文并缓存,记录各 gap 已展开的行数 ----
  // 这份状态住在整栏而非各 DiffFileView:检索索引要把已展开的上下文一并算进去,
  // 藏在子组件里就取不到了。reveal 的键是 `路径 gapKey`。
  //
  // 但提到这里就活得比一条 review 长了(切 review 只换 prop、组件不卸载),故按 diff 版本作废:
  // 换 review 或复审重拉 diff 后,同名文件的全文与展开进度都不再对得上新行号,
  // 照旧渲染就会拿上一条 review 的内容去检索。`files` 的引用只在 diff 重新拉取时变,正好当版本号。
  const diffGen = useRef(0);
  const lastFiles = useRef<DiffFile[] | null>(null);
  if (lastFiles.current !== files) {
    lastFiles.current = files;
    diffGen.current += 1;
  }
  const gen = diffGen.current;
  const [ctxState, setCtxState] = useState<CtxCache>(() => emptyCtx(gen));
  // 在 render 期派生作废,而不是留给 effect 去补清 —— 否则换 diff 后会先渲染一帧旧内容。
  // 空缓存按 gen 记住:它一路当依赖传到检索索引与着色,每帧新建对象等于换 diff 后从没展开过上下文的
  // 那段时间里(常态)全部 memo 失效,⌘G 每跳一次都要重扫全 diff 并重建所有 Range。
  const empty = useMemo(() => emptyCtx(gen), [gen]);
  const ctx = ctxState.gen === gen ? ctxState : empty;
  const fetchFileContent = props.fetchFileContent;

  const ensureFile = useCallback(
    async (path: string): Promise<string[] | null> => {
      const cached = ctx.lines[path];
      if (cached) return cached;
      if (!fetchFileContent) return null;
      // 请求发出时的版本随请求一起走:回来时 diff 已换版就整份丢弃,不写进新版缓存
      const at = gen;
      setCtxState((c) => withCtx(c, at, (d) => ({ ...d, loading: { ...d.loading, [path]: true } })));
      try {
        const raw = await fetchFileContent(path);
        if (raw == null || at !== diffGen.current) return null;
        const lines = raw.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 去掉末换行 split 残留
        setCtxState((c) => withCtx(c, at, (d) => ({ ...d, lines: { ...d.lines, [path]: lines } })));
        return lines;
      } catch {
        return null;
      } finally {
        setCtxState((c) => withCtx(c, at, (d) => ({ ...d, loading: { ...d.loading, [path]: false } })));
      }
    },
    [ctx.lines, fetchFileContent, gen],
  );

  const expand = useCallback(
    async (path: string, gap: Gap) => {
      const at = gen;
      const lines = await ensureFile(path);
      if (!lines || at !== diffGen.current) return;
      setCtxState((c) =>
        withCtx(c, at, (d) => {
          const key = revealKey(path, gap.key);
          const cur = d.reveal[key] ?? 0;
          const newTo = gap.side === 'trail' ? lines.length : gap.newTo;
          const remaining = Math.max(0, newTo - gap.newFrom + 1 - cur);
          if (remaining <= 0) return d;
          return { ...d, reveal: { ...d.reveal, [key]: cur + Math.min(CTX_CHUNK, remaining) } };
        }),
      );
    },
    [ensureFile, gen],
  );

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

  // 文件头是 sticky:一旦被吸在列头下,scrollIntoView 会认定它「已在视口起点」而原地不动,
  // 于是顶上停着的还是上一个文件。故按非 sticky 的区块算落点、自己写 scrollTop。
  const scrollToFile = useCallback((path: string, behavior: ScrollBehavior = 'smooth') => {
    const pane = ref.current;
    const el = pane?.querySelector(`#${CSS.escape(fileAnchorId(path))}`);
    if (!pane || !el) return;
    const box = el.closest('.diff-file') ?? el;
    const pad = parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0;
    const top =
      pane.scrollTop + box.getBoundingClientRect().top - pane.getBoundingClientRect().top - pad;
    pane.scrollTo({ top, behavior });
  }, []);

  // 折叠态一并入依赖:跳到已是 activePath 的那个文件时,同值的 setActivePath 不触发重渲染,
  // 光靠 activePath 补不上这次定位(锚在其上的又恰好没有 finding 可走下面那条 effect 时尤其明显)。
  const activeCollapsed = activePath != null && props.collapsed.has(activePath);
  useEffect(() => {
    if (!activePath) return;
    scrollToFile(activePath);
  }, [activePath, activeCollapsed, scrollToFile]);

  // 标记已看会把当前文件折叠掉,滚动位置不变则视口塌进下一个文件的中段;
  // 记下落点,等折叠提交后再把它的文件头顶上来。取消已看不跳。
  const advanceTo = useRef<string | null>(null);
  const onToggleViewed = useCallback(
    (path: string) => {
      if (!props.viewed.has(path) && props.collapseOnViewed) {
        const i = files.findIndex((f) => f.path === path);
        const next = files.slice(i + 1).find((f) => !props.viewed.has(f.path));
        advanceTo.current = next?.path ?? path; // 后面没有未看文件:回到自己的文件头,不留悬空视口
      }
      props.onToggleViewed(path);
    },
    [files, props.viewed, props.collapseOnViewed, props.onToggleViewed],
  );

  useEffect(() => {
    const path = advanceTo.current;
    if (!path) return;
    advanceTo.current = null;
    // 折叠刚把大段内容抽走,再补一段平滑动画只会更晕;直接定位
    scrollToFile(path, 'auto');
    props.onSelectFile?.(path); // 左栏高亮跟着走
  }, [props.viewed]);

  // 折叠态一并入依赖:目标文件刚被展开时卡片才进 DOM,此刻要补一次滚动。
  // 只看被聚焦那条所在的文件,免得折叠别处也把视口拽回来。
  const focusCollapsed =
    focusFindingId != null &&
    props.collapsed.has(findings.find((f) => f.id === focusFindingId)?.file ?? '');
  useEffect(() => {
    if (!focusFindingId || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(`finding-${focusFindingId}`)}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusFindingId, focusCollapsed]);

  // 长代码行只让 code 表自己横滚(文件头/hunk 头/内联卡片不跟着滑走);
  // 一份 diff 被卡片切成多张表,共用同一横向偏移才不会读到一半错位。scroll 不冒泡,故用捕获。
  useEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    let syncing = false;
    const onScroll = (e: Event) => {
      const src = e.target as HTMLElement | null;
      if (syncing || !src?.classList?.contains('code-scroll')) return;
      syncing = true;
      for (const el of pane.querySelectorAll<HTMLElement>('.code-scroll')) {
        if (el !== src && el.scrollLeft !== src.scrollLeft) el.scrollLeft = src.scrollLeft;
      }
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    pane.addEventListener('scroll', onScroll, true);
    return () => pane.removeEventListener('scroll', onScroll, true);
  }, []);

  // ---- ⌘F diff 内容检索 ----
  const findNonce = props.findNonce ?? 0;
  const findOpen = findNonce > 0;
  const [query, setQuery] = useState('');
  const [findOpts, setFindOpts] = useState<FindOptions>({ caseSensitive: false, wholeWord: false });
  const [cur, setCur] = useState(0);
  const [revealNonce, setRevealNonce] = useState(0);
  // 建索引 + 画命中在按键的同一帧做完会拖住输入;让匹配结果落后一帧,输入框始终跟手
  const deferredQuery = useDeferredValue(query);

  // 可检索的行 = hunk 行 + **已展开**的 diff 外上下文行,按渲染顺序交错。
  // 上下文算进来意味着命中总数会随展开增长,故下方要把「当前项」钉住,不能只按下标记。
  const searchable = useMemo<FindFile[]>(() => {
    if (!findOpen) return [];
    return files.map((file) => {
      const gaps = buildGaps(file.hunks);
      const lines: FindLine[] = [];
      const push = (ls: DiffLine[]) => {
        for (const l of ls) lines.push({ hit: hitKey(l), text: l.text });
      };
      const gapLines = (gap: Gap | null) =>
        gap
          ? revealedGapLines(gap, ctx.lines[file.path] ?? null, ctx.reveal[revealKey(file.path, gap.key)] ?? 0)
          : [];
      push(gapLines(gaps.lead));
      file.hunks.forEach((h, i) => {
        push(h.lines);
        push(gapLines(gaps.between[i] ?? null));
      });
      push(gapLines(gaps.trail));
      return { path: file.path, lines };
    });
  }, [findOpen, files, ctx]);

  const { matches, capped } = useMemo(
    () => findMatches(searchable, deferredQuery, findOpts),
    [searchable, deferredQuery, findOpts],
  );
  const matchesRef = useRef<FindMatch[]>(matches);
  matchesRef.current = matches;

  // 命中集会因改词、展开上下文、增删 finding 而重算。改词=回到第一处;
  // 其余情况把当前项钉在原来那处 —— 否则每展开一段上下文,序号就跳到别的地方去了。
  const curKey = useRef<string | null>(null);
  const prevQuery = useRef('');
  useEffect(() => {
    const changedQuery = prevQuery.current !== deferredQuery;
    prevQuery.current = deferredQuery;
    if (matches.length === 0) {
      curKey.current = null;
      setCur(0);
      return;
    }
    const kept = !changedQuery && curKey.current ? matches.findIndex((m) => matchKey(m) === curKey.current) : -1;
    const next = kept >= 0 ? kept : 0;
    curKey.current = matchKey(matches[next]);
    setCur(next);
    // 钉不住原来那处就等于换了当前项(改词,或 Aa / 全词把它筛掉了),必须跟着滚过去 ——
    // 否则计数显示的是新的一处,视口却还停在已经失效的旧位置,命中甚至可能在折叠文件里根本看不见。
    if (kept < 0) {
      pendingReveal.current = true;
      setRevealNonce((n) => n + 1);
    }
  }, [matches, deferredQuery]);

  const step = useCallback((delta: 1 | -1) => {
    const list = matchesRef.current;
    if (list.length === 0) return;
    setCur((c) => {
      const next = (c + delta + list.length) % list.length;
      curKey.current = matchKey(list[next]);
      return next;
    });
    pendingReveal.current = true;
    setRevealNonce((n) => n + 1);
  }, []);

  // 着色必须在同一帧提交,否则跳转时会闪过一帧「旧命中还亮着」。
  // 依赖列的是**所有会重建 `.src` 单元格的东西** —— Highlight 存的是 Range,指向具体文本节点,
  // 节点一旦被替换,旧 Range 就脱离了文档,高亮凭空消失而计数照旧。除了换视图 / 展开文件,
  // findings 与 composeAt 也会让 segmentByAnchor 重新切表(扫描期 finding 陆续到达最容易撞上)。
  // cur 不在依赖里:换当前项走下面的增量着色,重建全部 Range 太贵,而它正是 ⌘G 的热路径。
  const curRef = useRef(cur);
  curRef.current = cur;
  useLayoutEffect(() => {
    if (!ref.current) return;
    paintMatches(ref.current, matches, curRef.current);
  }, [matches, props.view, props.collapsed, findings, composeAt, ctx]);

  // 同一帧内两者都变时,上面那条(声明在先)已按新的 cur 画完,这里退化成空操作。
  useLayoutEffect(() => paintCurrent(cur), [cur]);

  // 关掉即清空:检索词是纯导航态,下次 ⌘F 应当是干净的一次新检索(切 review 也走这条)
  useEffect(() => {
    if (findOpen) return;
    setQuery('');
    clearMatches();
  }, [findOpen]);
  useEffect(() => clearMatches, []);

  // 跳到当前项。本 effect 也挂在 collapsed 上(展开后才滚得到),所以必须两处设防:
  //   1. 只在真的请求了跳转时动作(pendingReveal),否则用户手动折叠任何文件都会被当成跳转;
  //   2. 展开走 onExpandFile 这条只展不收的路 —— 用 toggle 的话,用户折叠恰好含当前命中的
  //      文件时,会被本 effect 立刻掰回展开。
  const pendingReveal = useRef(false);
  useEffect(() => {
    if (!pendingReveal.current || !ref.current) return;
    const m = matchesRef.current[cur];
    if (m && props.collapsed.has(m.file) && props.onExpandFile) {
      props.onExpandFile(m.file); // 展开后 collapsed 变化,本 effect 再跑一遍完成滚动
      return;
    }
    pendingReveal.current = false;
    const cell = m && matchCell(ref.current, m);
    if (cell && m) scrollToMatch(ref.current, cell, m);
  }, [revealNonce, cur, props.collapsed]);

  // ⌘F 以选区预填(编辑器惯例)。选区只能在**按键当场**读:检索条一挂载就抢焦点并全选,
  // 那一步会清空文档选区,而子组件的 effect 先于父组件跑 —— 等这里的 effect 轮到时已什么都不剩。
  const findSeed = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primaryModifier(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      findSeed.current = selectionSeed(ref.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!findOpen) return;
    const seed = findSeed.current;
    findSeed.current = null;
    if (seed) setQuery(seed);
  }, [findNonce]);

  // ⌘G / ⌘⇧G 前后跳:只在检索开启、且没有模态弹层压在上面时接管。
  // 少了 keysSuspended 这一档,帮助层开着按 ⌘G 会在弹层背后偷偷换命中并滚动 diff,
  // 关掉弹层才发现视口已经不是原来那处 —— ⌘F 由屏侧的导航 handler 同样按这条让位。
  useEffect(() => {
    if (!findOpen || props.keysSuspended) return;
    const onKey = (e: KeyboardEvent) => {
      if (!primaryModifier(e) || e.altKey || e.key.toLowerCase() !== 'g') return;
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen, props.keysSuspended, step]);

  const closeFind = props.onFindClose;

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
      // 横向锚在代码区左缘而非选区中点:跟着选区走会随行长忽左忽右,长行更会被甩出视野。
      // 纵向仍贴选区首行上方,贴到顶栏则翻到选区下方。
      const codeBox = (rows[0].closest('.code-scroll') as HTMLElement | null) ?? pane;
      const pw = 260; // 动作条估算宽度,仅用于右边界收敛
      const left = Math.max(8, Math.min(window.innerWidth - pw - 8, codeBox.getBoundingClientRect().left + 10));
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      let top = rows[0].getBoundingClientRect().top - 44;
      if (top < 58) top = rect.bottom + 9;
      setSel({ pick, top, left });
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

  const startCompose = (pick: AnchorPick) => {
    setSel(null);
    window.getSelection()?.removeAllRanges();
    setComposeAt({ pick });
  };

  if (files.length === 0 && absentByFile.size === 0) {
    return (
      <div className="diff-col">
        <div className="diff pane" ref={ref}>
          <p className="diff-empty">暂无 diff。扫描期会在拉取改动后显示。</p>
        </div>
      </div>
    );
  }

  // 改动总量:左栏是逐文件的,整份 diff 的体量只有这里给
  const totals = files.reduce(
    (acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }),
    { a: 0, d: 0 },
  );

  return (
    // 检索条是 .diff-col 的绝对定位子元素,**不能**放进滚动容器:
    // 放进去它会随内容滚开,点上一处 / 下一处时搜索条自己先跑掉
    <div className="diff-col">
    <div className="diff pane" ref={ref} onMouseUp={onMouseUp}>
      <div className="diff-bar">
        <span className="db-stat mono" title="本次改动总量">
          <span className="a">+{totals.a}</span>
          <span className="d">−{totals.d}</span>
        </span>
        <span className="db-spacer" />
        {props.onViewChange && <ViewSwitch view={props.view} onChange={props.onViewChange} />}
      </div>
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
          collapseOnViewed={!!props.collapseOnViewed}
          onToggleViewed={() => onToggleViewed(f.path)}
          onToggleCollapsed={() => props.onToggleCollapsed(f.path)}
          fileLines={ctx.lines[f.path] ?? null}
          loadingCtx={!!ctx.loading[f.path]}
          revealOf={(gapKey) => ctx.reveal[revealKey(f.path, gapKey)] ?? 0}
          onExpand={(gap) => expand(f.path, gap)}
          onAddThread={
            canStart
              ? (line, snippet) =>
                  startCompose({
                    anchor: { file: f.path, line, lineEnd: null },
                    placeLine: line,
                    label: `${basename(f.path)}:${line}`,
                    snippet,
                  })
              : undefined
          }
          compose={composeAt && composeAt.pick.anchor.file === f.path ? composeAt : null}
          onSendCompose={async (text) => {
            // 发起卡是这段原文唯一的落脚处,建线程成功了才关;失败由卡片自己报错并守住内容
            if (composeAt) await onStartDiscussion?.(composeAt.pick.anchor, text);
            setComposeAt(null);
          }}
          onCreateFinding={async (draft) => {
            if (composeAt) await onAddFinding?.(composeAt.pick.anchor, draft);
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
          onAnnotate={() => startCompose(sel.pick)}
        />
      )}
    </div>
      {findOpen && (
        <DiffFindBar
          query={query}
          onQueryChange={setQuery}
          options={findOpts}
          onOptionsChange={setFindOpts}
          total={matches.length}
          current={cur}
          capped={capped}
          onStep={step}
          onClose={() => closeFind?.()}
          focusNonce={findNonce}
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

/** reveal 记账的键:同一份 gap.key 在不同文件里会重名。分隔符用 NUL —— 路径里可能有空格。 */
function revealKey(path: string, gapKey: string): string {
  return `${path}\u0000${gapKey}`;
}

/** diff 外上下文缓存,连同它属于哪一版 diff(见 DiffPane 里 diffGen 的说明) */
interface CtxCache {
  gen: number;
  /** 文件新侧全文,按路径 */
  lines: Record<string, string[]>;
  loading: Record<string, boolean>;
  /** 各 gap 已展开的行数,键见 revealKey */
  reveal: Record<string, number>;
}

const emptyCtx = (gen: number): CtxCache => ({ gen, lines: {}, loading: {}, reveal: {} });

/** 按版本更新:迟到的旧版写入直接丢弃,新版写入落在一份干净缓存上。 */
function withCtx(cache: CtxCache, gen: number, update: (c: CtxCache) => CtxCache): CtxCache {
  if (gen < cache.gen) return cache;
  return update(cache.gen === gen ? cache : emptyCtx(gen));
}

/**
 * 某个 gap 当前已展开出来的行。首部贴着下方 hunk 向上揭示(取区间末段),
 * 其余贴着上方 hunk 向下揭示(取区间首段)。渲染与检索索引共用这一份,免得两处算法漂移。
 */
function revealedGapLines(gap: Gap, fileLines: string[] | null, revealed: number): DiffLine[] {
  if (!fileLines || revealed <= 0) return [];
  const newTo = gap.side === 'trail' ? fileLines.length : gap.newTo;
  return gap.side === 'lead'
    ? Array.from({ length: revealed }, (_, i) => ctxLine(newTo - revealed + 1 + i, fileLines, gap.oldOffset))
    : Array.from({ length: revealed }, (_, i) => ctxLine(gap.newFrom + i, fileLines, gap.oldOffset));
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
    <div className="code-scroll">
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
    </div>
  ) : (
    <div className="code-scroll">
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
    </div>
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

  const revealedLines = revealedGapLines(gap, fileLines, revealed);
  const revealedTable = revealedLines.length > 0 ? <ContextTable lines={revealedLines} {...ctxProps} /> : null;

  if (remaining === 0) return revealedTable; // 全部展开完,收起条

  const hiddenFrom = gap.side === 'lead' ? gap.newFrom : gap.newFrom + revealed;
  const hiddenTo = gap.side === 'lead' ? newTo - revealed : newTo;
  const rng = remaining == null ? '' : hiddenFrom === hiddenTo ? `${hiddenFrom}` : `${hiddenFrom}–${hiddenTo}`;

  const bar = (
    <div className="gap-bar" title="展开未改动代码" onClick={loading ? undefined : onExpand}>
      <span className="gap-pill">
        <span className="gap-ic">↕</span>
        <span className="gap-label">{loading ? '载入中…' : gapLabel(gap.side, remaining)}</span>
        {rng && <span className="gap-rng">{rng}</span>}
      </span>
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
  collapseOnViewed,
  onToggleViewed,
  onToggleCollapsed,
  onAddThread,
  compose,
  onSendCompose,
  onCreateFinding,
  onCancelCompose,
  fileLines,
  loadingCtx,
  revealOf,
  onExpand,
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
  collapseOnViewed: boolean;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
  onAddThread?: (line: number, snippet: string) => void;
  compose: Compose | null;
  onSendCompose: (text: string) => void | Promise<void>;
  onCreateFinding: (draft: NewFindingDraft) => void | Promise<void>;
  onCancelCompose: () => void;
  /** 以下四项由 DiffPane 托管:检索索引要看得到已展开的上下文,状态不能留在这里 */
  fileLines: string[] | null;
  loadingCtx: boolean;
  revealOf: (gapKey: string) => number;
  onExpand: (gap: Gap) => void;
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

  // 同一个按钮在四种状态下做的事不同,tooltip 必须跟着说
  const viewedTitle = viewed
    ? collapseOnViewed
      ? '取消已看并展开'
      : '取消已看'
    : collapseOnViewed
      ? '标记已看并折叠,跳到下一个未看文件'
      : '标记已看';

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

  // 新增/删除文件整份即在 diff 里(无 diff 外上下文),不给展开控件以免留下点了无效的空条。
  const canExpand =
    !!fetchFileContent && !file.binary && file.status !== 'added' && file.status !== 'deleted';
  const gaps = useMemo(() => buildGaps(file.hunks), [file.hunks]);

  const gapNode = (gap: Gap | null) =>
    gap && canExpand ? (
      <GapExpander
        gap={gap}
        view={view}
        lang={lang}
        fileLines={fileLines}
        loading={loadingCtx}
        revealed={revealOf(gap.key)}
        onExpand={() => onExpand(gap)}
        onAddThread={onAddThread}
        anchorByLine={anchorByLine}
        onAnchorClick={onAnchorClick}
      />
    ) : null;

  const composeNode = compose ? (
    <AnnotateComposer
      // 锚点变了要重挂:同一张卡换个位置继续用会把上一处的草稿带过去。
      // 起止行都要进 key —— 只认落位行的话,末行相同、起点不同的两次框选会共用实例,
      // 草稿留在原地却提交到新锚点
      key={`${compose.pick.anchor.file}:${compose.pick.anchor.line}:${compose.pick.anchor.lineEnd ?? ''}`}
      label={compose.pick.label}
      snippet={compose.pick.snippet}
      onSend={onSendCompose}
      onCreate={onCreateFinding}
      onCancel={onCancelCompose}
    />
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
            {/* 复选框语义:文案恒为「已看」,状态由勾选框表达,免得点一下按钮宽度就跳 */}
            <button
              className={`fh-btn${viewed ? ' on' : ''}`}
              title={viewedTitle}
              aria-pressed={viewed}
              onClick={onToggleViewed}
            >
              <span className="fb-box" aria-hidden="true">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M2.4 6.3l2.6 2.6 4.6-5.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="fb-label">已看</span>
            </button>
            {/* 与上一个相反:文案给的是点下去会发生什么,不是当前状态 */}
            <button
              className="fh-btn"
              title={collapsed ? '展开文件内容' : '折叠文件内容'}
              onClick={onToggleCollapsed}
            >
              <span className="fb-ic" aria-hidden="true">{collapsed ? '+' : '−'}</span>
              <span className="fb-label">{collapsed ? '展开' : '折叠'}</span>
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

      {/* 折叠态只留标题栏:已看勾选框与「展开」按钮就在其中,再加一条说明纯属复述 */}
      {collapsed ? null : file.binary ? (
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
              <div className="code-scroll">
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
              </div>
              {cards(seg.endAnchor)}
              {seg.endAnchor === composeLine && composeNode}
            </div>
          ))
        : segmentByAnchor(
            hunk.lines.map((l) => ({ row: l, anchor: l.newLine })),
            shouldBreak,
          ).map((seg, i) => (
            <div key={i}>
              <div className="code-scroll">
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
              </div>
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

/**
 * hover 才显影的行内批注 ✎(仅新侧行);与框选浮层同一枚字形与配色,两条路径开的是同一张卡。
 * 挂在行号格里:代码格会随长行横滚,贴在其右缘的按钮要滑到行尾才够得着。
 */
function AddThread({ line, text, onAddThread }: { line: number; text: string; onAddThread?: (line: number, snippet: string) => void }) {
  if (!onAddThread) return null;
  return (
    <button
      className="add-thread"
      title="批注这一行"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onAddThread(line, text.trim().slice(0, 60));
      }}
    >
      <PencilIcon />
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
      <td className="ln">
        {lineNo}
        {line.newLine != null && <AddThread line={line.newLine} text={line.text} onAddThread={onAddThread} />}
      </td>
      <td className="gutter">
        {mark ? <AnchorDot mark={mark} onClick={onAnchorClick} /> : gutter}
      </td>
      {/* data-hit:⌘F 检索把命中的字符区间画回这一格,见 diff-find.ts */}
      <td className="src" data-hit={hitKey(line)}>
        <span dangerouslySetInnerHTML={{ __html: html }} />
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
        {side === 'new' && line.newLine != null && (
          <AddThread line={line.newLine} text={line.text} onAddThread={onAddThread} />
        )}
      </td>
      <td className={srcBase + mod} data-hit={hitKey(line)}>
        <span dangerouslySetInnerHTML={{ __html: html }} />
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
