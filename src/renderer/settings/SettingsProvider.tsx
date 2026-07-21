import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '@shared/domain';

// 两个正交主题轴,见 theme/tokens.css
export type Mode = UiSettings['dataMode'];
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

/**
 * 全局 UI 偏好的唯一权威:启动时从后端 `ui_settings` 拉取,改动去抖写回。
 * 主题两轴挂在 documentElement(data-mode × data-theme)。见 frontend-components.md 持久化表。
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(DEFAULT_UI_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 主题两轴挂到根节点(两者必须同设,否则 light/theme 覆盖不匹配)
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-mode', settings.dataMode);
    root.setAttribute('data-theme', settings.dataTheme);
  }, [settings.dataMode, settings.dataTheme]);

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
