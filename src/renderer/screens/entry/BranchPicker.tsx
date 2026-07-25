import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitButlerIcon, LocalBranchIcon } from './icons';

/** 一个可审核目标(普通 git 分支或 GitButler 虚拟分支)在选择器里的展示形态。 */
export interface BranchOption {
  name: string;
  kind: 'git' | 'vbranch';
  isHead?: boolean;
  /** 行尾标签:← base / vbranch */
  tag: string;
  /** 计量段:N commits ahead / N files */
  meta: string;
  /** 补充说明:commit 标题 / 未提交改动等 */
  detail: string;
  updatedAt?: number;
}

/**
 * 分支选择器:形态是下拉而非卡片列表 —— 卡片列表看不出「要点选」,
 * 且没有默认值时底部 CTA 一直是灰的。展开后带筛选,收起后由 BranchSummary 补回细节。
 */
export function BranchPicker({
  options,
  value,
  onChange,
  emptyHint,
  loading,
}: {
  options: BranchOption[];
  value: string;
  onChange: (name: string) => void;
  emptyHint: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ up: boolean; rowsMax: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.name === value) ?? null;
  const disabled = loading || options.length === 0;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // 候选变空(换仓库 / 改 base)时收起,免得浮层挂在一个不再存在的列表上
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // 浮层落在会裁切的祖先(入口卡片 overflow:hidden)里,按可用空间定高、必要时上翻
  useLayoutEffect(() => {
    if (!open || !boxRef.current) {
      setPlace(null);
      return;
    }
    const trig = boxRef.current.getBoundingClientRect();
    const clip = clipBounds(boxRef.current);
    const filterH = filterRef.current?.offsetHeight ?? 0;
    const room = (edge: number) => Math.floor(edge - MENU_GAP - ROWS_PAD - EDGE_INSET - filterH);
    const below = room(clip.bottom - trig.bottom);
    const above = room(trig.top - clip.top);
    // 下方不够舒展才上翻;两边都挤时按实际空间收,不硬撑出边界之外
    const up = below < ROWS_COMFORT && above > below;
    const space = up ? above : below;
    setPlace({ up, rowsMax: Math.min(ROWS_MAX, Math.max(ROWS_FLOOR, space)) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    const next = !open;
    setOpen(next);
    if (next) {
      setQuery('');
      setActive(Math.max(0, options.findIndex((o) => o.name === value)));
    }
  };

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = shown[active];
      if (hit) pick(hit.name);
    }
  };

  return (
    <div className={open ? 'bpick open' : 'bpick'} ref={boxRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="bp-trig"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <BranchIcon kind={selected.kind} />
            <span className="bp-name mono">{selected.name}</span>
            {selected.isHead && <span className="headtag mono">HEAD</span>}
          </>
        ) : (
          <span className="bp-placeholder">{loading ? '列举分支…' : emptyHint}</span>
        )}
        <span className="chev" />
      </button>

      {open && (
        <div
          className={place?.up ? 'bp-menu up' : 'bp-menu'}
          style={place ? ({ '--bp-rows-max': `${place.rowsMax}px` } as React.CSSProperties) : undefined}
        >
          <div className="bp-filter" ref={filterRef}>
            <input
              value={query}
              spellCheck={false}
              autoFocus
              placeholder="筛选分支…"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          </div>
          <div className="bp-rows" role="listbox">
            {shown.length === 0 && <div className="bp-none">没有匹配的分支。</div>}
            {shown.map((o, i) => (
              <div
                key={o.name}
                role="option"
                aria-selected={o.name === value}
                className={`bp-row${o.name === value ? ' sel' : ''}${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.name)}
              >
                <BranchIcon kind={o.kind} />
                <div className="m">
                  <div className="bn mono">
                    {o.name}
                    {o.isHead && <span className="headtag mono">HEAD</span>}
                  </div>
                  <div className="bd">{[o.meta, o.detail].filter(Boolean).join(' · ')}</div>
                </div>
                <span className="cmp mono">{o.tag}</span>
                <span className="tick">{o.name === value ? '✓' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 选中项摘要:把收进下拉里的计量信息留在屏上。 */
export function BranchSummary({ option, base }: { option: BranchOption; base?: string }) {
  return (
    <div className="bp-summary">
      <span className="mono s-cmp">
        {option.name}
        {base && (
          <>
            {' '}
            <i>←</i> {base}
          </>
        )}
      </span>
      <span className="dot">·</span>
      <span>{option.meta}</span>
      {option.detail && (
        <>
          <span className="dot">·</span>
          <span className="mono s-sub">{option.detail}</span>
        </>
      )}
      {option.updatedAt ? <span className="ago">{relTime(option.updatedAt)}</span> : null}
    </div>
  );
}

/** 浮层与触发器的间距(与 CSS 里的 6px 一致)、列表自身的上下内边距、离裁切边留白、列表高度上下限。 */
const MENU_GAP = 6;
const ROWS_PAD = 10;
const EDGE_INSET = 10;
/** 低于这个高度就考虑上翻;真的两边都不够时不再低于 ROWS_FLOOR(列表自己能滚)。 */
const ROWS_COMFORT = 108;
const ROWS_FLOOR = 72;
const ROWS_MAX = 232;

/** 会裁切内容的各层祖先与视口的交集;取不到边界时不设限(交给 ROWS_MAX 收口)。 */
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight || document.documentElement.clientHeight || Number.POSITIVE_INFINITY;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (!/hidden|auto|scroll|clip/.test(overflowY) && !/hidden|auto|scroll|clip/.test(overflowX)) continue;
    const r = p.getBoundingClientRect();
    // display:contents 之类的壳没有自己的盒子,拿它当边界会把浮层挤成 0 高
    if (r.height === 0) continue;
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

function BranchIcon({ kind }: { kind: BranchOption['kind'] }) {
  return (
    <span className={kind === 'vbranch' ? 'bp-ic v' : 'bp-ic b'}>
      {kind === 'vbranch' ? <GitButlerIcon /> : <LocalBranchIcon />}
    </span>
  );
}

function relTime(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
