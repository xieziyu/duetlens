/**
 * 中栏 diff 内容检索(⌘F)的纯逻辑:在**行模型**上建命中索引,再把命中画到 DOM。
 *
 * 为什么索引建在模型而不是扫 DOM:折叠 / 已看的文件不在 DOM 里,扫 DOM 会让它们的命中凭空消失,
 * 而「跨全部改动找一个符号」正是折叠之后最需要的。
 * 为什么着色走 CSS Custom Highlight API 而不是包 <mark>:diff 代码是 highlight.js 的 HTML,
 * 包标签意味着每次按键重渲整棵 diff;Highlight API 不改 DOM、不触发 React 重渲。
 */
import type { DiffLine } from '@shared/diff';

/** 命中上限:单字符查询在大 diff 上能出几万条,超出只标 `N+`,不再继续建索引 */
export const FIND_CAP = 5000;

export interface FindOptions {
  /** 关时为 smart-case:查询含大写即区分,全小写则不区分 */
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** 一条可检索的行:hunk 行,或已展开的 diff 外上下文行 */
export interface FindLine {
  /** 行标识,对应 DOM 里 `.src[data-hit]`;见 hitKey */
  hit: string;
  text: string;
}

export interface FindFile {
  path: string;
  /** 按渲染顺序排列(上下文展开段与 hunk 交错) */
  lines: FindLine[];
}

export interface FindMatch {
  file: string;
  hit: string;
  /** 命中在该行文本中的字符区间 */
  start: number;
  end: number;
}

/**
 * 行在所属文件内的唯一标识 = 旧侧行号|新侧行号。
 * 同一文件内 (oldLine, newLine) 必然唯一:context 两侧都有、add 只有新侧、del 只有旧侧,
 * 而展开出来的上下文行落在 hunk 覆盖区间之外,不会与 hunk 行撞号。
 */
export function hitKey(line: Pick<DiffLine, 'oldLine' | 'newLine'>): string {
  return `${line.oldLine ?? ''}|${line.newLine ?? ''}`;
}

/** 命中的稳定身份:重算索引后靠它把「当前项」钉回原处 */
export function matchKey(m: FindMatch): string {
  return `${m.file}\u0000${m.hit}\u0000${m.start}`;
}

/**
 * 单词边界:Unicode 标识符字符(字母 / 数字 / 组合记号 / 连接符,外加代码里常见的 $)算词内。
 * 不能用 `\w` —— 它只认 ASCII,于是「变量」会被当成完整词命中「变量名」,café 后接重音字母也照命中。
 */
const WORD = /[\p{L}\p{N}\p{M}\p{Pc}$]/u;

/** 边界处要取**完整码点**:astral 字符占两个 UTF-16 格,只取半个代理对匹配不上 \p{L},会假装成词边界 */
function cpBefore(s: string, i: number): string {
  const lo = s.charAt(i - 1);
  if (i >= 2 && lo >= '\udc00' && lo <= '\udfff') {
    const hi = s.charAt(i - 2);
    if (hi >= '\ud800' && hi <= '\udbff') return hi + lo;
  }
  return lo;
}

function cpAt(s: string, i: number): string {
  const cp = s.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** ASCII 的 toLowerCase 保证逐字符 1:1,可以直接走;只有含非 ASCII 的行需要小心折叠 */
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * **长度守恒**的小写折叠。整行 `toLowerCase()` 会让偏移失真:Unicode 折叠不保证长度守恒
 * (`İ` 折成 `i̇`,一个码点变两个),而命中偏移随后要当成**原文本**的 UTF-16 下标去建 Range ——
 * 长度一变,轻则高亮画到别的字符上,重则越界,于是这条命中计数在、却既画不出也跳不过去。
 * 故逐码点折叠、只采纳长度不变的那些;代价是 `İ` 不与 `i̇` 互相匹配,这是明确的取舍。
 */
function foldCase(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  let out = '';
  for (const cp of s) {
    const lower = cp.toLowerCase();
    out += lower.length === cp.length ? lower : cp;
  }
  return out;
}

/**
 * 全文扫描建索引。不走正则:查询串是用户随手输的代码片段,转义与非法正则的错误态
 * 不值当,indexOf + 边界判定已足够,也更快。
 */
export function findMatches(
  files: FindFile[],
  query: string,
  opts: FindOptions,
): { matches: FindMatch[]; capped: boolean } {
  const matches: FindMatch[] = [];
  if (!query) return { matches, capped: false };
  // smart-case 不能用 /[A-Z]/:Éclair、Δvalue 同样是「含大写」。与自身小写形比对是唯一覆盖全 Unicode 的判据,
  // 且顺带把 İ 这类折叠会变长、foldCase 不会动的字符也归进大小写敏感,免得它们静悄悄退化成异常匹配。
  const sensitive = opts.caseSensitive || query !== query.toLowerCase();
  const needle = sensitive ? query : foldCase(query);
  // 取 needle 而非 query 的长度:折叠虽守恒,但命中区间量的是 hay 里的跨度,两者必须同源
  const len = needle.length;

  for (const file of files) {
    for (const line of file.lines) {
      const hay = sensitive ? line.text : foldCase(line.text);
      let from = 0;
      let at: number;
      while ((at = hay.indexOf(needle, from)) >= 0) {
        const end = at + len;
        from = at + 1; // 允许重叠命中(如 `aa` 在 `aaa` 中两处),与编辑器一致
        if (opts.wholeWord && (WORD.test(cpBefore(hay, at)) || WORD.test(cpAt(hay, end)))) continue;
        // 判定在 push 之前:满 CAP 时还要再找到**下一个**命中才算超出,否则不多不少 5000 条会被标成 5000+
        if (matches.length === FIND_CAP) return { matches, capped: true };
        matches.push({ file: file.path, hit: line.hit, start: at, end });
      }
    }
  }
  return { matches, capped: false };
}

const HL_ALL = 'dl-find';
const HL_CUR = 'dl-find-cur';

/** lib.dom 只给 Highlight 声明了 forEach;规范里它是 setlike<AbstractRange>,增删当前项要靠这两个方法 */
type HighlightSet = Highlight & { add(r: AbstractRange): void; delete(r: AbstractRange): boolean };

/**
 * 上一次着色的 Range,按命中下标存。
 * 换当前项时靠它把那一项在两个集合间搬家:重建 Range 要扫遍 pane 里所有 `.src`、再为每条命中走一趟
 * TreeWalker,而 Enter / ⌘G 逐条浏览正是最热的路径,大 diff 上重建一次就是一次可感的卡顿。
 * Range 指向具体文本节点,故 DOM 一重建这份缓存即作废 —— 那些场景本就会重跑 paintMatches。
 */
let painted: { ranges: Range[][]; cur: number; all: HighlightSet; one: HighlightSet } | null = null;

/** 把 (单元格, 字符偏移) 变成 Range:沿 cell 内的文本节点累加长度定位。 */
function rangeIn(cell: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.data.length;
    if (startNode === null && pos + len > start) {
      startNode = text;
      startOffset = start - pos;
    }
    if (startNode !== null && pos + len >= end) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(text, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

/**
 * 收集 pane 内所有代码单元格,按 `文件路径 + NUL + 行标识` 归拢。
 * split 视图下 context 行左右两格同标识,故一个键可能对应两格 —— 两侧都要着色。
 */
function cellIndex(pane: HTMLElement): Map<string, Element[]> {
  const index = new Map<string, Element[]>();
  for (const cell of pane.querySelectorAll('.src[data-hit]')) {
    const path = cell.closest('.diff-file')?.getAttribute('data-path');
    if (!path) continue;
    const key = `${path}\u0000${cell.getAttribute('data-hit')}`;
    const arr = index.get(key);
    if (arr) arr.push(cell);
    else index.set(key, [cell]);
  }
  return index;
}

/** 把命中画上去;current 为当前项下标(-1 表示无)。折叠文件的命中自然无格可画,跳过。 */
export function paintMatches(pane: HTMLElement, matches: FindMatch[], current: number): void {
  if (!supportsHighlight()) return;
  if (matches.length === 0) {
    clearMatches();
    return;
  }
  const cells = cellIndex(pane);
  const all = new Highlight() as HighlightSet;
  const one = new Highlight() as HighlightSet;
  const ranges = matches.map((m, i) => {
    const rs: Range[] = [];
    for (const cell of cells.get(`${m.file}\u0000${m.hit}`) ?? []) {
      const range = rangeIn(cell, m.start, m.end);
      if (range) rs.push(range);
    }
    for (const r of rs) (i === current ? one : all).add(r);
    return rs;
  });
  CSS.highlights.set(HL_ALL, all);
  CSS.highlights.set(HL_CUR, one);
  painted = { ranges, cur: current, all, one };
}

/** 只挪动「当前项」的着色;缓存不在(DOM 重建过或尚未画过)时不动,由 paintMatches 负责重画。 */
export function paintCurrent(current: number): void {
  if (!painted || painted.cur === current) return;
  for (const r of painted.ranges[painted.cur] ?? []) {
    painted.one.delete(r);
    painted.all.add(r);
  }
  for (const r of painted.ranges[current] ?? []) {
    painted.all.delete(r);
    painted.one.add(r);
  }
  painted.cur = current;
}

export function clearMatches(): void {
  painted = null;
  if (!supportsHighlight()) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CUR);
}

function supportsHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/**
 * ⌘F 的预填词:diff 内的单行选区。跨行或过长的不是「一个词」,不预填。
 * 必须在按键当场调用 —— 检索条一挂载就抢焦点,那会把文档选区清空。
 */
export function selectionSeed(pane: HTMLElement | null): string | null {
  const sel = window.getSelection();
  if (!pane || !sel || sel.isCollapsed || !pane.contains(sel.anchorNode)) return null;
  const text = sel.toString().trim();
  return text && !text.includes('\n') && text.length <= 120 ? text : null;
}

/** 命中所在的代码单元格;文件折叠或尚未渲染时为 null。 */
export function matchCell(pane: HTMLElement, m: FindMatch): HTMLElement | null {
  const file = pane.querySelector(`.diff-file[data-path="${CSS.escape(m.file)}"]`);
  return (file?.querySelector(`.src[data-hit="${CSS.escape(m.hit)}"]`) as HTMLElement | null) ?? null;
}

/**
 * 把命中滚进视口:纵向滚 pane,横向滚该行所在的 `.code-scroll`。
 * 横向这一半不能省 —— 长代码行的命中常落在屏幕右侧之外,只滚纵向的话行是对的、词却看不见,
 * 读起来就像"报了命中却找不到"。两个方向都只在真的不可见时才动,免得每跳一次都抖。
 */
export function scrollToMatch(pane: HTMLElement, cell: HTMLElement, m: FindMatch): void {
  const row = cell.closest('.row') as HTMLElement | null;
  if (row) scrollRowIntoView(pane, row);
  scrollMatchIntoViewX(cell, m);
}

/** 纵向:列头与 file-header 都是 sticky,scrollIntoView 会把行送到它们底下,故自己算落点。 */
function scrollRowIntoView(pane: HTMLElement, row: HTMLElement): void {
  const paneBox = pane.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const header = row.closest('.diff-file')?.querySelector('.file-header');
  const blocked =
    (parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0) +
    (header?.getBoundingClientRect().height ?? 0);
  const top = rowBox.top - paneBox.top;
  if (top >= blocked + 8 && top + rowBox.height <= paneBox.height - 8) return;
  pane.scrollTo({
    top: Math.max(0, pane.scrollTop + top - blocked - (paneBox.height - blocked) / 3),
    behavior: 'smooth',
  });
}

/**
 * 横向:命中区间自己的 rect 才算数(整格的 rect 是长行的全宽,判不出词在不在视野里)。
 * unified 下行号 + gutter 是 sticky 钉在左缘的,滚到它们底下等于没滚,故左边界要让开它们。
 * DiffPane 会把各 `.code-scroll` 的 scrollLeft 同步,这里滚一个即可。
 */
function scrollMatchIntoViewX(cell: HTMLElement, m: FindMatch): void {
  const box = cell.closest('.code-scroll') as HTMLElement | null;
  if (!box || box.scrollWidth <= box.clientWidth) return;
  const range = rangeIn(cell, m.start, m.end);
  if (!range) return;
  const hit = range.getBoundingClientRect();
  const boxBox = box.getBoundingClientRect();
  const row = cell.closest('.row');
  let pinned = 0;
  for (const td of row?.querySelectorAll<HTMLElement>('.ln, .gutter') ?? []) {
    if (getComputedStyle(td).position === 'sticky') pinned += td.getBoundingClientRect().width;
  }
  const left = boxBox.left + pinned;
  if (hit.left >= left + 8 && hit.right <= boxBox.right - 8) return;
  box.scrollTo({
    left: Math.max(0, box.scrollLeft + hit.left - left - (boxBox.width - pinned) / 3),
    behavior: 'smooth',
  });
}
