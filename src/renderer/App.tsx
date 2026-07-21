import { useState } from 'react';
import { useSettings, type ColorTheme } from './settings/SettingsProvider';
import { EntryScreen } from './screens/EntryScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SubmitExportScreen } from './screens/SubmitExportScreen';
import './App.css';

// 骨架期极简屏路由;后续按 frontend-components.md 三顶层屏演进。
type Screen = 'entry' | 'review' | 'submit';

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'entry', label: '入口' },
  { id: 'review', label: '审核' },
  { id: 'submit', label: '提交/导出' },
];

// initialReviewId 仅 preview 入口用于直达审核屏;production main.tsx 不传。
export function App({ initialReviewId = null }: { initialReviewId?: string | null } = {}) {
  const [screen, setScreen] = useState<Screen>(initialReviewId ? 'review' : 'entry');
  const [activeReviewId, setActiveReviewId] = useState<string | null>(initialReviewId);
  const { settings, update } = useSettings();
  const mode = settings.dataMode;
  const theme = settings.dataTheme;

  const openReview = (id: string) => {
    setActiveReviewId(id);
    setScreen('review');
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark mono">
          duet<i>lens</i>
          <span className="cur">_</span>
        </span>

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
            onChange={(e) => update({ dataTheme: e.target.value as ColorTheme })}
            aria-label="配色主题"
          >
            <option value="duetlens">duetlens</option>
            <option value="github">github</option>
          </select>
          <button
            className="mode-toggle"
            onClick={() => update({ dataMode: mode === 'dark' ? 'light' : 'dark' })}
            aria-label="切换明暗"
          >
            {mode === 'dark' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <main className="screen-host">
        {screen === 'entry' && <EntryScreen onOpenReview={openReview} />}
        {screen === 'review' && <ReviewScreen reviewId={activeReviewId} />}
        {screen === 'submit' && <SubmitExportScreen />}
      </main>
    </div>
  );
}
