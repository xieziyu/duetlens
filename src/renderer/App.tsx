import { useState } from 'react';
import { useTheme, type ColorTheme } from './theme/ThemeProvider';
import { EntryScreen } from './screens/EntryScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SubmitExportScreen } from './screens/SubmitExportScreen';
import { DevBridgeProbe } from './components/DevBridgeProbe';
import './App.css';

// 骨架期极简屏路由;后续按 frontend-components.md 三顶层屏演进。
type Screen = 'entry' | 'review' | 'submit';

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'entry', label: '入口' },
  { id: 'review', label: '审核' },
  { id: 'submit', label: '提交/导出' },
];

export function App() {
  const [screen, setScreen] = useState<Screen>('entry');
  const { mode, theme, toggleMode, setTheme } = useTheme();

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark mono">duetlens_</span>

        <nav className="screen-nav">
          {SCREENS.map((s) => (
            <button
              key={s.id}
              className={s.id === screen ? 'seg active' : 'seg'}
              onClick={() => setScreen(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="theme-controls">
          <select
            className="mono theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ColorTheme)}
            aria-label="配色主题"
          >
            <option value="duetlens">duetlens</option>
            <option value="github">github</option>
          </select>
          <button className="mode-toggle" onClick={toggleMode} aria-label="切换明暗">
            {mode === 'dark' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <main className="screen-host">
        {screen === 'entry' && <EntryScreen />}
        {screen === 'review' && <ReviewScreen />}
        {screen === 'submit' && <SubmitExportScreen />}
      </main>

      <DevBridgeProbe />
    </div>
  );
}
