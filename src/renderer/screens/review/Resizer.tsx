import { useCallback, useRef, useState } from 'react';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface ResizerProps {
  /** 拖拽实时驱动的栏宽 CSS 变量(挂在 .rev-root) */
  cssVar: string;
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
 * 列间可拖拽分隔条。拖拽期间只命令式改 .rev-root 的栏宽 CSS 变量,
 * 不走 React state,避免每次 pointermove 重渲染整棵 DiffPane 导致卡顿;松手才提交一次落库。
 */
export function Resizer({ cssVar, width, min, max, sign, defaultWidth, onCommit }: ResizerProps) {
  const elRef = useRef<HTMLDivElement>(null);
  // 拖拽起点与实时宽度;非 state,避免触发渲染
  const drag = useRef<{ startX: number; startW: number; latest: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const host = () => elRef.current?.closest('.rev-root') as HTMLElement | null;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width, latest: width };
      setDragging(true);
      elRef.current?.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const next = clamp(d.startW + sign * (e.clientX - d.startX), min, max);
      d.latest = next;
      host()?.style.setProperty(cssVar, `${next}px`);
    },
    [cssVar, min, max, sign],
  );

  const stop = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      elRef.current?.releasePointerCapture?.(e.pointerId);
      if (d && d.latest !== width) onCommit(d.latest);
    },
    [width, onCommit],
  );

  // 双击恢复默认:拖歪了没有别的路回来 —— 拖拽期改的是 CSS 变量,这里也一并写回,
  // 免得父层落库前的一帧还停在旧宽度
  const reset = useCallback(() => {
    host()?.style.setProperty(cssVar, `${defaultWidth}px`);
    if (defaultWidth !== width) onCommit(defaultWidth);
  }, [cssVar, defaultWidth, width, onCommit]);

  return (
    <div
      ref={elRef}
      className={`resizer${dragging ? ' drag' : ''}`}
      role="separator"
      title="拖拽调整栏宽 · 双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={reset}
    />
  );
}
