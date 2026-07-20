import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// 两个正交轴,见 mockup/tokens.css
export type Mode = 'dark' | 'light';
export type ColorTheme = 'duetlens' | 'github';

interface ThemeState {
  mode: Mode;
  theme: ColorTheme;
  setMode: (m: Mode) => void;
  setTheme: (t: ColorTheme) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

// 骨架期:主题存组件 state。持久化(后端 settings 表 per-user)见 frontend-components.md,待接 IPC。
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('dark');
  const [theme, setTheme] = useState<ColorTheme>('duetlens');

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', theme);
  }, [mode, theme]);

  return (
    <ThemeContext.Provider
      value={{ mode, theme, setMode, setTheme, toggleMode: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')) }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
