import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REVIEW_STATUS_LABELS } from '@shared/domain';
import type { ReviewTab } from '../review/tabs';
import type { TabMeta } from '../review/useTabMeta';
import { shortSourceLabel, sourceTitleRest, tabTipText } from '../review/source-ref';
import { SourceIcon } from './SourceIcon';
import './ReviewTabs.css';

/** tab 条右侧的一句轻提示;由 App 决定何时出、何时消失。 */
export interface TabNotice {
  text: string;
  /** 可选的一步回头路(如把刚关掉的那枚重新打开) */
  action?: { label: string; onRun: () => void };
  /**
   * 不自动消失。给「就地确认」用 —— 那种提示的动作是**用户还没做的决定**,
   * 定时收走等于替他选了「不关」,而他可能只是想了几秒。
   */
  sticky?: boolean;
}

/** 悬浮卡的出现延迟 */
const TIP_DELAY_MS = 420;

/**
 * 打开着的 review。**tab 只是视图的把手** —— 关掉一枚不动后端会话,那条审核继续在后台跑
 * (会话按 reviewId 存活于 main,见 ReviewManager)。所以关闭按钮不需要「确定要中止吗」这类确认。
 *
 * 状态点只给「扫描中」与「失败」两档:其余状态在 tab 这个尺寸上给不出新信息,
 * 每枚都挂个点只会让真正在跑的那一枚淹掉。
 */
export function ReviewTabs({
  tabs,
  activeId,
  meta,
  notice,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: readonly ReviewTab[];
  activeId: string | null;
  meta: Record<string, TabMeta>;
  notice: TabNotice | null;
  onActivate: (reviewId: string) => void;
  onClose: (reviewId: string) => void;
  /** ＋:回入口发起新审核(不直接建 tab —— 没有 review 就没有 tab) */
  onNew: () => void;
}): React.JSX.Element {
  const tip = useTabTip();
  const strip = useStripScroll(activeId, tabs.length);
  return (
    <div className="rev-tabs" role="tablist" aria-label="打开的审核">
      {/* 横向滚动会把卡片留在原处指向已经移开的那枚 tab */}
      <div
        className="tabs-strip"
        ref={strip.ref}
        data-fade={strip.fade}
        onScroll={() => {
          tip.hide();
          strip.sync();
        }}
        onWheel={strip.onWheel}
      >
        {tabs.map((t) => {
          const m = meta[t.reviewId];
          const label = m ? shortSourceLabel(m.source, m.sourceRef) : '…';
          const rest = m ? sourceTitleRest(m.source, m.sourceRef, m.title) : '';
          const tipText = m ? tabTipText(m) : '';
          const on = t.reviewId === activeId;
          const dot = m?.status === 'scanning' ? 'scanning' : m?.status === 'failed' ? 'failed' : null;
          // 未读数与状态点二选一:210px 的 tab 上两样都画就谁也读不清
          const unread = !on && m ? m.unread : 0;
          return (
            <div key={t.reviewId} className={`rev-tab${on ? ' on' : ''}`}>
              <button
                className="tab-main"
                role="tab"
                aria-selected={on}
                // 状态与未读也得进这里:显式 aria-label 会盖掉后代,挂在角标 / 状态点上的说明读不到
                aria-label={
                  m
                    ? [
                        tipText,
                        rest,
                        REVIEW_STATUS_LABELS[m.status ?? 'scanning'],
                        unread > 0 ? `新增 ${unread} 条 finding` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : label
                }
                onMouseEnter={(e) => m && tip.show(e.currentTarget, tipText, rest)}
                onMouseLeave={tip.hide}
                onFocus={(e) => m && tip.show(e.currentTarget, tipText, rest)}
                onBlur={tip.hide}
                onClick={() => {
                  tip.hide();
                  onActivate(t.reviewId);
                }}
                onAuxClick={(e) => {
                  // 元素被移除不会派发 mouseleave,不先收的话卡片会留在原地指着一枚已经没了的 tab
                  if (e.button !== 1) return;
                  tip.hide();
                  onClose(t.reviewId);
                }}
              >
                <SourceIcon source={m?.source} />
                <span className="mono lbl">{label}</span>
                {rest && <span className="ttl">{rest}</span>}
                {unread > 0 ? (
                  <span className="tab-badge" aria-hidden>
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : (
                  dot && <span className={`tab-dot ${dot}`} aria-hidden />
                )}
              </button>
              <button
                className="tab-close"
                onClick={() => onClose(t.reviewId)}
                aria-label={`关闭 ${label}(审核不受影响)`}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      <button className="tab-add" onClick={onNew} aria-label="发起新审核">
        <PlusIcon />
      </button>
      {notice && (
        <span className="tab-notice">
          {notice.text}
          {notice.action && (
            <button onClick={notice.action.onRun}>{notice.action.label}</button>
          )}
        </span>
      )}
      {tip.at && (
        <div
          className="tab-tip"
          role="tooltip"
          style={{ left: tip.at.left, right: tip.at.right, top: tip.at.y }}
        >
          <span className="mono tip-id">{tip.at.id}</span>
          {tip.at.title && <span className="tip-ttl">{tip.at.title}</span>}
        </div>
      )}
    </div>
  );
}

/** 两端渐隐的宽度;滚动落位也留这么多,免得刚滚进来的那枚正压在渐隐底下。 */
const FADE_PX = 26;

/**
 * tab 条的横向滚动。上限放到二十几枚之后「一屏放不下」是常态(1280 窗口约 9 枚到顶),
 * 于是两件事必须由代码兜住:
 *
 * 1. **活跃那枚要自己滚进视野**。⌃⇥ 切过去、或关掉活跃 tab 后右邻接位时,正文换了而 tab 条
 *    不动的话,条上一枚活跃的都看不见 —— 人会以为切错了。
 * 2. **两端要有「后面还有」的迹象**。滚动条是藏掉的(34px 的条上摆一根横滚条太吵),
 *    没有渐隐就完全看不出溢出。
 *
 * 落位自己按实测矩形算,不用 `scrollIntoView`:后者会连带滚祖先,且平滑滚动在预览面板里是 no-op。
 */
function useStripScroll(
  activeId: string | null,
  count: number,
): {
  ref: React.RefObject<HTMLDivElement>;
  fade: 'l' | 'r' | 'lr' | undefined;
  sync: () => void;
  onWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<'l' | 'r' | 'lr' | undefined>(undefined);

  const sync = useCallback(() => {
    const s = ref.current;
    if (!s) return;
    // 1px 容差:缩放下 scrollWidth 带小数,严格比较会让不该出现的那侧渐隐常驻
    const l = s.scrollLeft > 1;
    const r = s.scrollLeft < s.scrollWidth - s.clientWidth - 1;
    setFade(l && r ? 'lr' : l ? 'l' : r ? 'r' : undefined);
  }, []);

  /** 幂等:已经在视野里就一动不动 —— 点一枚看得见的 tab 不该把整条甩一下。 */
  const keepVisible = useCallback(() => {
    const s = ref.current;
    const el = s?.querySelector<HTMLElement>('.rev-tab.on');
    if (!s || !el) return;
    // offsetLeft 不可靠(strip 没定位,offsetParent 是更外面的某个祖先),一律用实测矩形的差
    const sr = s.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // 首尾那枚会被浏览器自己夹回 0 / 上限,不必单独判
    if (r.left < sr.left + FADE_PX) s.scrollLeft += r.left - sr.left - FADE_PX;
    else if (r.right > sr.right - FADE_PX) s.scrollLeft += r.right - sr.right + FADE_PX;
  }, []);

  /**
   * 布局期做:留到 effect 才滚的话,活跃那枚会先在屏外绘出一帧。
   *
   * **不跟着标题异步补齐重跑**:能滚的时候每枚 tab 都顶在 min-width 上(见 ReviewTabs.css),
   * 内容宽恒等于 116×N,标题从 '…' 补成全称一个像素都不动。
   */
  useLayoutEffect(() => {
    keepVisible();
    sync();
  }, [activeId, count, keepVisible, sync]);

  /**
   * 可视宽变了同样要重新落位 —— 窗口缩窄、右侧那句轻提示出现都会挤掉宽度,而 scrollLeft 不动,
   * 活跃那枚就这么被留在屏外。用 ResizeObserver 而非 window.resize:提示进出不发 resize,
   * 而要量的本来就是这一条 strip。
   */
  useEffect(() => {
    const s = ref.current;
    if (!s) return;
    const ro = new ResizeObserver(() => {
      keepVisible();
      sync();
    });
    ro.observe(s);
    return () => ro.disconnect();
  }, [keepVisible, sync]);

  // 竖向滚轮也拿来横滚:鼠标只有这一个轴,不接的话二十几枚 tab 只剩触控板横扫一条路
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const s = ref.current;
    if (!s || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    s.scrollLeft += e.deltaY;
  }, []);

  return { ref, fade, sync, onWheel };
}

interface TipAt {
  /** 项目名 + 完整身份 */
  id: string;
  /** 去重后的完整标题;tab 上那份多半被截过 */
  title: string;
  y: number;
  /** 左右二选一:贴左边缘的那枚从左对齐,贴右边缘的从右对齐 */
  left?: number;
  right?: number;
}

/**
 * tab 的悬浮卡。**不用原生 `title`** —— 它在这条栏上不出现,而且排不了版;
 * 位置用 fixed + 实测矩形算:tab 条自己会横向滚动,绝对定位会被 strip 的 overflow 裁掉。
 */
function useTabTip(): {
  at: TipAt | null;
  show: (el: HTMLElement, id: string, title: string) => void;
  hide: () => void;
} {
  const [at, setAt] = useState<TipAt | null>(null);
  const timer = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setAt(null);
  }, []);

  const show = useCallback((el: HTMLElement, id: string, title: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // 等待期间这枚 tab 可能已被关掉:脱离文档的元素量出来是 0×0,卡片会飞到左上角
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      // 右半边的 tab 改为右对齐:卡片宽度要等它排完版才知道,靠估宽去夹会把卡片推离它指的那枚 tab
      const toRight = r.left > window.innerWidth / 2;
      setAt({
        id,
        title,
        y: r.bottom + 4,
        left: toRight ? undefined : Math.max(6, r.left),
        right: toRight ? Math.max(6, window.innerWidth - r.right) : undefined,
      });
    }, TIP_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return { at, show, hide };
}

const CloseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" />
  </svg>
);

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
