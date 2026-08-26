import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '@shared/domain';

// 两个正交主题轴,见 theme/tokens.css
export type Mode = UiSettings['dataMode'];
/** `data-mode` 只认这两档;`system` 是偏好层的档,不会出现在 DOM 上 */
export type ResolvedMode = Exclude<Mode, 'system'>;
export type ColorTheme = UiSettings['dataTheme'];

interface SettingsState {
  settings: UiSettings;
  /** 局部合并并落库(去抖持久化);本地态立即更新以驱动界面。 */
  update: (patch: Partial<UiSettings>) => void;
  /** 首帧加载完成后为 true(在此之前用默认值渲染,避免闪烁) */
  loaded: boolean;
}

const SettingsContext = createContext<SettingsState | null>(null);

const SAVE_DEBOUNCE_MS = 400;

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/**
 * 从查询串取主题两轴的**首帧种子**:`ui.getSettings()` 是异步 IPC,等它回来再切,
 * 非默认档的用户必然先看见一帧深色。main 建窗时把持久化的两轴挂在 URL 上(见 main.ts),
 * preview 里则是人手写的 `?mode=` / `?theme=`。只认已知值,缺省交回调用方的基线。
 */
export function readThemeQuery(): Partial<Pick<UiSettings, 'dataMode' | 'dataTheme'>> {
  const q = new URLSearchParams(window.location.search);
  const mode = q.get('mode');
  const theme = q.get('theme');
  return {
    ...(mode === 'light' || mode === 'dark' || mode === 'system' ? { dataMode: mode } : {}),
    ...(theme === 'duetlens' ||
    theme === 'github' ||
    theme === 'parchment' ||
    theme === 'cyberpunk'
      ? { dataTheme: theme }
      : {}),
  };
}

/**
 * 全局 UI 偏好的唯一权威:启动时从后端 `ui_settings` 拉取,改动去抖写回。
 * 主题两轴挂在 documentElement(data-mode × data-theme)。见 docs/design/architecture.md 持久化表。
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(() => ({ ...DEFAULT_UI_SETTINGS, ...readThemeQuery() }));
  const [loaded, setLoaded] = useState(false);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(SYSTEM_DARK).matches);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 「跟随系统」要在运行中跟着 OS 切,不能只在启动时读一次
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_DARK);
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    setSystemDark(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 首帧拉取
  useEffect(() => {
    let alive = true;
    void window.duetlens.ui.getSettings().then((s) => {
      if (alive) {
        setSettings(s);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const resolvedMode: ResolvedMode =
    settings.dataMode === 'system' ? (systemDark ? 'dark' : 'light') : settings.dataMode;

  // 主题两轴挂到根节点(两者必须同设,否则 light/theme 覆盖不匹配)。
  // 必须是 layout effect:普通 effect 在首帧**画完之后**才跑,种子档就白种了。
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-mode', resolvedMode);
    root.setAttribute('data-theme', settings.dataTheme);
  }, [resolvedMode, settings.dataTheme]);

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void window.duetlens.ui.saveSettings(next);
      }, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, update, loaded }}>{children}</SettingsContext.Provider>
  );
}

export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings 必须在 SettingsProvider 内使用');
  return ctx;
}
