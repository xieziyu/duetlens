import { useId, useMemo } from 'react';
// 几何唯一来源是 build/logo/*.svg(同时供 icons:gen 出应用图标);这里只做两件事:
// 把固定色板换成 .dl-mark 上的 CSS 变量(跟随明暗/配色),把 defs id 按实例改写(多处同时挂载时不串)。
import markFull from '../../../build/logo/mark.svg?raw';
import markSmall from '../../../build/logo/mark-small.svg?raw';
import markTiny from '../../../build/logo/mark-tiny.svg?raw';

type Tier = 'full' | 'small' | 'tiny';

/** 分档同 scripts/gen-icons.ts 的取舍(细行糊掉之前降档),阈值按 CSS px 折半——屏上是 2x 矢量渲染。 */
function tierFor(size: number): Tier {
  if (size >= 64) return 'full';
  return size > 20 ? 'small' : 'tiny';
}

const SOURCE: Record<Tier, string> = { full: markFull, small: markSmall, tiny: markTiny };

const PALETTE: Array<[RegExp, string]> = [
  [/#4a5261/g, 'var(--mk-code)'],
  [/#7a8698/g, 'var(--mk-ctx)'],
  [/#58a6f7/g, 'var(--mk-agent)'],
  [/#e8a24d/g, 'var(--mk-human)'],
  [/#8b98aa|#9aa6b8/g, 'var(--mk-ring)'],
  [/#fff\b/g, 'var(--mk-gloss)'],
];

/** 取出 <svg> 内层内容:外层由 React 渲染,才能给它 width/height/class。 */
function body(tier: Tier, uid: string): string {
  const svg = SOURCE[tier];
  let inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
  for (const [re, v] of PALETTE) inner = inner.replace(re, v);
  return inner.replace(/id="([\w-]+)"/g, `id="$1-${uid}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1-${uid})`);
}

export function LogoMark({
  size = 20,
  tier,
  className,
}: {
  size?: number;
  tier?: Tier;
  className?: string;
}) {
  const uid = useId().replace(/[^\w-]/g, '');
  const t = tier ?? tierFor(size);
  const inner = useMemo(() => body(t, uid), [t, uid]);
  return (
    <svg
      className={className ? `dl-mark ${className}` : 'dl-mark'}
      viewBox="0 0 96 96"
      width={size}
      height={size}
      role="img"
      aria-label="Duetlens"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
