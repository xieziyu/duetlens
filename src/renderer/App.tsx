import { useEffect, useRef, useState } from 'react';
import type { CompletionNotice } from '@shared/ipc';
import { EntryScreen } from './screens/EntryScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SubmitExportScreen } from './screens/SubmitExportScreen';
import { PromptRulesScreen } from './screens/PromptRulesScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { Wordmark } from './components/Wordmark';
import { ThemeControls } from './components/ThemeControls';
import { CompletionToast } from './components/CompletionToast';
import './App.css';

// 骨架期极简屏路由;review / onboarding 屏自带顶栏,故此处不再套全局栏。
type Screen = 'entry' | 'review' | 'submit' | 'prompt' | 'onboarding' | 'history' | 'settings';

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'entry', label: '入口' },
  { id: 'review', label: '审核' },
  { id: 'submit', label: '提交/导出' },
  { id: 'prompt', label: '审核规则' },
  { id: 'history', label: '历史' },
  { id: 'settings', label: '设置' },
];

// initialReviewId / initialScreen 仅 preview 入口用于直达某屏;production main.tsx 不传。
export function App({
  initialReviewId = null,
  initialScreen,
}: { initialReviewId?: string | null; initialScreen?: Screen } = {}) {
  const [screen, setScreen] = useState<Screen>(initialScreen ?? (initialReviewId ? 'review' : 'entry'));
  const [activeReviewId, setActiveReviewId] = useState<string | null>(initialReviewId);
  const [toast, setToast] = useState<CompletionNotice | null>(null);
  // 通知点击带来的定位目标:每次请求换一个 nonce,使 ReviewScreen 即便同一 discussion 也能重触发聚焦
  const [focusDiscussion, setFocusDiscussion] = useState<{ id: string; nonce: number } | null>(null);

  const openReview = (id: string, discussionId?: string) => {
    setActiveReviewId(id);
    setScreen('review');
    setToast(null);
    if (discussionId) setFocusDiscussion({ id: discussionId, nonce: Date.now() });
  };

  // 通知点击「聚焦+定位」挂在常驻的 App:onOpenReview 打开 review;onInApp 弹轻提示。
  // 用 ref 记住当前所看,避免为订阅重挂而随导航变化。
  const viewing = useRef<{ screen: Screen; reviewId: string | null }>({ screen, reviewId: activeReviewId });
  viewing.current = { screen, reviewId: activeReviewId };
  useEffect(() => {
    const n = window.duetlens.notifications;
    if (!n) return;
    const offOpen = n.onOpenReview(({ reviewId, discussionId }) => openReview(reviewId, discussionId));
    const offInApp = n.onInApp((notice) => {
      const v = viewing.current;
      if (v.screen === 'review' && v.reviewId === notice.reviewId) return; // 正看着就不打扰
      setToast(notice);
    });
    return () => {
      offOpen();
      offInApp();
    };
  }, []);

  // 首启环境门控:非 preview 冷启动时轻量自检,缺 codex 即落到 onboarding(健康态无感)。
  useEffect(() => {
    if (initialScreen != null || initialReviewId != null) return;
    let alive = true;
    void window.duetlens.checkEnvironment({ deep: false }).then((r) => {
      if (alive && r.codex.status !== 'ok') setScreen('onboarding');
    });
    return () => {
      alive = false;
    };
  }, [initialScreen, initialReviewId]);

  return (
    <div className="app">
      {/* review / onboarding 屏自渲染顶栏;entry/submit 保留骨架期全局栏(含开发用屏切换) */}
      {screen !== 'review' && screen !== 'onboarding' && (
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
          <ReviewScreen
            reviewId={activeReviewId}
            onOpenSubmit={() => setScreen('submit')}
            focusRequest={focusDiscussion}
          />
        )}
        {screen === 'submit' && (
          <SubmitExportScreen reviewId={activeReviewId} onBack={() => setScreen('review')} />
        )}
        {screen === 'prompt' && <PromptRulesScreen onBack={() => setScreen('entry')} />}
        {screen === 'onboarding' && (
          <OnboardingScreen onEnter={() => setScreen('entry')} onSkip={() => setScreen('entry')} />
        )}
        {screen === 'history' && <HistoryScreen onOpen={openReview} />}
        {screen === 'settings' && <SettingsScreen onOpenPrompt={() => setScreen('prompt')} />}
      </main>

      {toast && (
        <CompletionToast
          notice={toast}
          onOpen={(id) => openReview(id, toast.discussionId)}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
