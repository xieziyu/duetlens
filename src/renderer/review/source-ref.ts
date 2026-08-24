import type { Review } from '@shared/domain';

/**
 * 展示用的 PR 引用拆解(URL / owner/repo#123 / 纯号);解析不出就退回原样显示,
 * 不与 main 侧 parsePrRef 共用 —— 那条路径要抛错并回退推断仓库,展示态不需要。
 */
export function parsePrRefLoose(ref: string): { nwo: string; num: string } | null {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { nwo: url[1], num: url[2] };
  const short = ref.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/);
  if (short) return { nwo: short[1], num: short[2] };
  const numOnly = ref.match(/^#?(\d+)$/);
  return numOnly ? { nwo: '', num: numOnly[1] } : null;
}

/** 顶栏与 tab 共用的短来源标识:PR 取 `#123`,其余给 ref 原文。 */
export function shortSourceLabel(source: Review['source'] | undefined, ref: string): string {
  const pr = source === 'github-pr' ? parsePrRefLoose(ref) : null;
  return pr ? `#${pr.num}` : ref;
}

/** 悬浮卡用的完整来源标识:PR 补回仓库,其余给 ref 全文(tab 上那份可能被截过)。 */
export function fullSourceLabel(source: Review['source'] | undefined, ref: string): string {
  const pr = source === 'github-pr' ? parsePrRefLoose(ref) : null;
  if (!pr) return ref;
  return pr.nwo ? `${pr.nwo}#${pr.num}` : `#${pr.num}`;
}

/** 图标已经表达过的来源名;它出现在 title 开头时与图标重复。 */
const SOURCE_NAME: Partial<Record<NonNullable<Review['source']>, string>> = {
  'gitbutler-vbranch': 'GitButler',
};

/**
 * title 里跟在身份之后的那半句。backend 各 source 都按 `<身份> · <正文>` 拼 title,
 * 而身份(与来源图标)在界面上已经单独画了一遍 —— 逐段剥掉开头这些重复,只留真正的新信息;
 * 剥空说明这条 title 除了身份什么都没带,那就一个字都不画。
 * 剥的是**开头连续**的重复段:PR 标题自己带 ` · ` 的部分不受影响。
 */
export function sourceTitleRest(
  source: Review['source'] | undefined,
  ref: string,
  title: string | null | undefined,
): string {
  if (!title) return '';
  const dup = new Set(
    [shortSourceLabel(source, ref), ref, source ? SOURCE_NAME[source] : undefined].filter(
      (s): s is string => Boolean(s),
    ),
  );
  let rest = title;
  for (;;) {
    const i = rest.indexOf(' · ');
    const head = i === -1 ? rest : rest.slice(0, i);
    if (!dup.has(head)) return rest;
    if (i === -1) return '';
    rest = rest.slice(i + 3);
  }
}

/**
 * 展示用仓库名:本地路径 basename 优先,其次从 github sourceRef 取 repo 段;都拿不到给 null。
 * 入口最近列表、历史屏与 tab 悬浮卡共用一份 —— 这几处指的是同一个「项目」。
 */
export function repoName(r: {
  source: Review['source'];
  sourceRef: string;
  repoPath: string | null;
}): string | null {
  if (r.repoPath) {
    const base = r.repoPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (base) return base;
  }
  if (r.source === 'github-pr') {
    // 走 parsePrRefLoose 而不是就地再写一条:未锚定的通用正则遇到完整 PR 链接会先咬中
    // `github.com/<owner>`,把 owner 当成项目名
    const nwo = parsePrRefLoose(r.sourceRef)?.nwo;
    if (nwo) return nwo.split('/').pop() ?? null;
  }
  return null;
}

/**
 * tab 悬浮卡那一句:项目名 + 完整身份。**只答「这枚 tab 是哪条 review」** ——
 * 光有分支名认不出是哪个仓库的分支,而同名分支在两个项目里同时开审是常态。
 * PR 的 `owner/repo#123` 自己已经带了项目名,不再前缀一遍。
 */
export function tabTipText(r: {
  source: Review['source'];
  sourceRef: string;
  repoPath: string | null;
}): string {
  const id = fullSourceLabel(r.source, r.sourceRef);
  const hasNwo = r.source === 'github-pr' && Boolean(parsePrRefLoose(r.sourceRef)?.nwo);
  const repo = hasNwo ? null : repoName(r);
  return repo ? `${repo} · ${id}` : id;
}
