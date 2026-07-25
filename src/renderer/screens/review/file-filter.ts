/**
 * 左栏文件检索的匹配规则。匹配对象是**完整路径**,所以 `src/` 这类只写目录的词也能收窄一片。
 * 命中下标随结果一起返回,渲染时据此高亮;不参与打分排序 —— 树的顺序必须与中栏 diff 的堆叠
 * 顺序一致,按相关度重排会让「树上第三条」和「diff 里第三个文件」错位。
 */

/** 短词不做子序列:`ts` 这种两字母词一模糊就把 `styles/app.css` 也捞进来,过滤等于没过滤。 */
const FUZZY_MIN = 3;

/** 空格分词并小写化;返回空数组表示不过滤。 */
export function parseFileQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 逐词匹配路径:先试整段包含,不中再退化为顺序子序列(`revscr` → `ReviewScreen`)。
 * 任一词不中即整条不中。返回值是命中字符在 path 中的下标集合。
 */
export function matchFilePath(path: string, terms: string[]): Set<number> | null {
  const hay = path.toLowerCase();
  const hits = new Set<number>();
  for (const term of terms) {
    const at = hay.indexOf(term);
    if (at >= 0) {
      for (let i = 0; i < term.length; i++) hits.add(at + i);
      continue;
    }
    if (term.length < FUZZY_MIN || !collectSubsequence(hay, term, hits)) return null;
  }
  return hits;
}

/** 只收整段包含的命中(目录头用:一个头对应整组文件,结果不能取决于组内选了哪个文件)。 */
export function containsHits(text: string, terms: string[]): Set<number> {
  const hay = text.toLowerCase();
  const hits = new Set<number>();
  for (const term of terms) {
    for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + 1)) {
      for (let i = 0; i < term.length; i++) hits.add(at + i);
    }
  }
  return hits;
}

/** 贪心从左到右吃字符;不中时不污染 hits。 */
function collectSubsequence(hay: string, term: string, hits: Set<number>): boolean {
  const found: number[] = [];
  let at = 0;
  for (const ch of term) {
    const i = hay.indexOf(ch, at);
    if (i < 0) return false;
    found.push(i);
    at = i + 1;
  }
  for (const i of found) hits.add(i);
  return true;
}
