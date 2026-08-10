import { useCallback, useEffect, useRef, useState } from 'react';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface ResizerProps {
  /** 松手时写入的栏宽 CSS 变量(挂在 .rev-root) */
  cssVar: string;
  /** 该侧栏宽的响应式上限变量(挂在 .rev-main,窄窗退化时被媒体查询压低) */
  capVar: string;
  /** 当前已提交栏宽(px);拖拽以此为起点 */
  width: number;
  min: number;
  max: number;
  /** 位移方向:左栏 +dx 变宽 = 1;右栏 -dx 变宽 = -1 */
  sign: 1 | -1;
  /** 双击恢复到的默认栏宽 */
  defaultWidth: number;
  /** 松手时提交最终栏宽(去抖持久化由父层负责) */
  onCommit: (width: number) => void;
}

/**
 * 列间可拖拽分隔条。拖拽期只用 transform 移一条虚线预览目标位置,不动 grid 栏宽 ——
 * 中栏 diff 全量在 DOM 里(无虚拟化),每次 pointermove 改栏宽都要整棵子树重排,
 * 分隔条就掉在光标后面。松手才写一次真实栏宽,只付一次重排。
 */
export function Resizer({ cssVar, capVar, width, min, max, sign, defaultWidth, onCommit }: ResizerProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);
  // 拖拽起点、有效上限与实时宽度;非 state,避免触发渲染。几何量与 cap 都在按下时量一次
  const drag = useRef<{ startX: number; startW: number; hi: number; top: number; latest: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const host = () => elRef.current?.closest('.rev-root') as HTMLElement | null;

  /** 只写 transform 用的两个变量与读数文本,不触碰任何影响布局的属性 */
  const paint = useCallback(
    (next: number, startW: number, clientY: number, top: number) => {
      const g = ghostRef.current;
      if (g) {
        g.style.setProperty('--ghost-dx', `${sign * (next - startW)}px`);
        g.style.setProperty('--ghost-y', `${clientY - top}px`);
      }
      if (readRef.current) readRef.current.textContent = `${next}px`;
    },
    [sign],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = elRef.current;
      const top = el?.getBoundingClientRect().top ?? 0;
      // 起点量实际几何宽度,不用持久化值:窄窗下媒体查询会拿 min() 把栏宽压小(见 ReviewScreen.css),
      // 以持久化值起算的虚线与读数会从一个屏幕上不存在的位置开始
      const pane = (sign === 1 ? el?.previousElementSibling : el?.nextElementSibling) as HTMLElement | null;
      // 上限还要压到响应式 cap:超过它的位置布局根本给不出来,预览到那儿就是骗人
      const cap = parseFloat(getComputedStyle(el?.parentElement ?? document.body).getPropertyValue(capVar));
      const hi = Number.isFinite(cap) ? Math.min(max, cap) : max;
      const startW = clamp(Math.round(pane?.getBoundingClientRect().width || width), min, hi);
      drag.current = { startX: e.clientX, startW, hi, top, latest: startW };
      setDragging(true);
      paint(startW, startW, e.clientY, top);
      document.body.classList.add('rz-dragging');
      el?.setPointerCapture(e.pointerId);
    },
    [capVar, width, min, max, sign, paint],
  );

  /** 收尾:提交 + 撤掉拖拽态。可能被多个事件先后触发,故必须幂等 */
  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      document.body.classList.remove('rz-dragging');
      const el = elRef.current;
      if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      // 只按下没拖动(含误点)不写回:窄窗下 startW 是被 min() 压过的值,写回会悄悄改掉用户的栏宽偏好
      if (!d || d.latest === d.startW) return;
      // 同帧写 CSS 变量:父层落库前虚线已经收掉,不写就会闪一帧旧宽度
      host()?.style.setProperty(cssVar, `${d.latest}px`);
      onCommit(d.latest);
    },
    [cssVar, onCommit],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      // 键已松开却没收到 pointerup(指针拖出窗口后在别处松手):回到页面上的第一次移动就收尾
      if (e.buttons === 0) {
        finish(e);
        return;
      }
      const next = clamp(d.startW + sign * (e.clientX - d.startX), min, d.hi);
      d.latest = next;
      paint(next, d.startW, e.clientY, d.top);
    },
    [sign, min, paint, finish],
  );

  // 拖拽中卸载(切 review / 导航)时 pointerup 永远不会来,不清就把 col-resize 与禁选留给整个 app
  useEffect(() => () => document.body.classList.remove('rz-dragging'), []);

  // 双击恢复默认:拖歪了没有别的路回来
  const reset = useCallback(() => {
    if (defaultWidth === width) return;
    host()?.style.setProperty(cssVar, `${defaultWidth}px`);
    onCommit(defaultWidth);
  }, [cssVar, defaultWidth, width, onCommit]);

  return (
    <div
      ref={elRef}
      className={`resizer${dragging ? ' drag' : ''}`}
      role="separator"
      title="拖拽调整栏宽 · 双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      // 指针捕获被静默收走(拖出窗口后在别处松手)时唯一还会来的事件 —— 没它虚线就一直挂在页面上
      onLostPointerCapture={finish}
      onDoubleClick={reset}
    >
      {/* 常驻:按下那一帧 state 还没刷,现挂的话 ref 还是空的,拿不到第一次 paint */}
      <div ref={ghostRef} className="resizer-ghost" aria-hidden="true">
        <span ref={readRef} className="rz-read" />
      </div>
    </div>
  );
}
