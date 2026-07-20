import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';

/**
 * 骨架期临时件:调用 window.duetlens.getAppInfo() 证明 preload contextBridge +
 * IPC 往返打通。骨架验收后删除。
 */
export function DevBridgeProbe() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.duetlens
      .getAppInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <footer className="dev-strip mono">
      {error && <span style={{ color: 'var(--sev-high)' }}>IPC 失败: {error}</span>}
      {!error && !info && <span>IPC 探测中…</span>}
      {info && (
        <span>
          ✓ IPC ok · {info.name} {info.version} · electron {info.electron} · chrome{' '}
          {info.chrome} · node {info.node} · {info.platform}
        </span>
      )}
    </footer>
  );
}
