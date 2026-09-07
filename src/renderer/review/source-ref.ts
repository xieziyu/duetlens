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
  /** 钉在某个提交上的范围;它的 title 身份段是 `#123 @sha7`,同样要剥 */
  headRef?: string | null,
): string {
  if (!title) return '';
  const label = shortSourceLabel(source, ref);
  const dup = new Set(
    [
      label,
      ref,
      headRef ? `${label} @${shortOid(headRef)}` : undefined,
      source ? SOURCE_NAME[source] : undefined,
    ].filter((s): s is string => Boolean(s)),
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

/**
 * 短 sha 一律 7 位:GitHub 自己也这么截,两边对照时不用数位数。
 * **只用于显示** —— 选中值、React key、落库一律走完整 oid,
 * 否则同一个 PR 里撞前缀的两条 commit 会共用 key、并让回查取错另一条。
 */
export const shortOid = (oid: string): string => oid.slice(0, 7);

/** commit 时间的相对说法(入参是 ISO 串);入口的范围选择器与 review 屏的切换器共用。 */
export function commitAge(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
