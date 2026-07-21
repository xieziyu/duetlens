import { useCallback, useRef, useState } from 'react';

export interface ResizerProps {
  /** 拖拽时回调:相对本次拖拽起点的水平位移(px,右为正) */
  onDrag: (deltaX: number) => void;
}

/**
 * 列间可拖拽分隔条(对齐 mockup .resizer)。用 pointer capture 跟踪拖拽,
 * 把位移交给父组件换算成栏宽;宽度约束/持久化由父层负责。
 */
export function Resizer({ onDrag }: ResizerProps) {
  const startX = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    startX.current = e.clientX;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      onDrag(e.clientX - startX.current);
      startX.current = e.clientX;
    },
    [dragging, onDrag],
  );

  const stop = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <div
      className={`resizer${dragging ? ' drag' : ''}`}
      role="separator"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
    />
  );
}
