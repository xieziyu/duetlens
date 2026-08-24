import { useEffect, useRef } from 'react';

/**
 * 把「输入框里还躺着没发出去的字」上报给屏一级(关 tab 前的拦截据此判断)。
 *
 * 只报布尔量、且只在空↔非空翻转时报:草稿文本抬到上层会让整棵 review 树(挂着整份 diff)
 * 跟着每次击键重渲染。回调用 ref 存,免得上层每帧换新函数时把上报又变回每帧一次。
 */
export function useDraftFlag(hasDraft: boolean, onChange?: (has: boolean) => void): void {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });

  const reported = useRef(false);
  useEffect(() => {
    if (reported.current === hasDraft) return;
    reported.current = hasDraft;
    cb.current?.(hasDraft);
  }, [hasDraft]);

  useEffect(
    () => () => {
      // 卸载 = 这段草稿随组件一起没了;拦截方不该继续挂着一条永远不会被撤销的「有未保存」
      if (reported.current) cb.current?.(false);
    },
    [],
  );
}
