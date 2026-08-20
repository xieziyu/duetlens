import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/update';

/**
 * 订阅自动更新状态。preload 的 onStatus 支持多监听,所以各处各订各的,
 * 不为此再加一层 context —— 状态本身是 main 单向推的,拿到的快照必然一致。
 */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' });

  useEffect(() => {
    let alive = true;
    window.duetlens.update
      .getStatus()
      .then((s) => {
        // 订阅先于 getStatus 返回:推来的新档不该被这次快照回退
        if (alive) setStatus(s);
      })
      .catch(() => undefined);
    const off = window.duetlens.update.onStatus((s) => {
      alive = false;
      setStatus(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return status;
}
