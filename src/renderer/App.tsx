import { useState } from 'react';
import { EntryScreen } from './screens/EntryScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SubmitExportScreen } from './screens/SubmitExportScreen';
import { Wordmark } from './components/Wordmark';
import { ThemeControls } from './components/ThemeControls';
import './App.css';

// 骨架期极简屏路由;review 屏自带合并顶栏(brand + 源 + CTA + 主题 + ⌘),故此处不再套全局栏。
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

  const openReview = (id: string) => {
    setActiveReviewId(id);
    setScreen('review');
  };

  return (
    <div className="app">
      {/* review 屏自渲染合并顶栏;entry/submit 保留骨架期全局栏(含开发用屏切换) */}
      {screen !== 'review' && (
        <header className="topbar">
          <Wordmark />
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
          <span className="tb-spacer" />
          <ThemeControls />
        </header>
      )}

      <main className="screen-host">
        {screen === 'entry' && <EntryScreen onOpenReview={openReview} />}
        {screen === 'review' && (
          <ReviewScreen reviewId={activeReviewId} onOpenSubmit={() => setScreen('submit')} />
        )}
        {screen === 'submit' && (
          <SubmitExportScreen reviewId={activeReviewId} onBack={() => setScreen('review')} />
        )}
      </main>
    </div>
  );
}
