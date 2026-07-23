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
import { AppRail, type RailScreen } from './components/AppRail';
import { CompletionToast } from './components/CompletionToast';
import './App.css';

// 屏路由。除 onboarding(全屏引导)外都套同一外壳:整幅顶栏 + 左侧 rail;
// review 屏用 display:contents 把自己的顶栏/主体/状态栏直接放进外壳网格。
type Screen = 'entry' | 'review' | 'submit' | 'prompt' | 'onboarding' | 'history' | 'settings';

const SCREEN_TITLE: Partial<Record<Screen, string>> = {
  entry: '发起审核',
  submit: '提交 / 导出',
  prompt: '审核规则',
  history: '审核历史',
  settings: '设置',
};

/** submit 是当前 review 的子流程,rail 上仍高亮「当前审核」。 */
const RAIL_OF: Record<Screen, RailScreen> = {
  entry: 'entry',
  review: 'review',
  submit: 'review',
  prompt: 'prompt',
  history: 'history',
  settings: 'settings',
  onboarding: 'entry',
};

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

  // 首启引导独占整窗(自带顶栏与交通灯留白),不套外壳
  if (screen === 'onboarding') {
    return <OnboardingScreen onEnter={() => setScreen('entry')} onSkip={() => setScreen('entry')} />;
  }

  const onRail = (s: RailScreen) => {
    if (s === 'review' && !activeReviewId) return;
    setScreen(s);
  };

  return (
    <div className="app">
      {/* review 屏自带上下文顶栏;其余屏用这条通用栏(同时是窗口拖拽区 + 交通灯留白) */}
      {screen !== 'review' && (
        <header className="app-topbar">
          <Wordmark />
          <span className="tb-sep" />
          <h1 className="tb-title">{SCREEN_TITLE[screen]}</h1>
        </header>
      )}

      <AppRail active={RAIL_OF[screen]} reviewAvailable={activeReviewId !== null} onNavigate={onRail} />

      {screen === 'review' ? (
        <ReviewScreen
          reviewId={activeReviewId}
          onOpenSubmit={() => setScreen('submit')}
          focusRequest={focusDiscussion}
        />
      ) : (
        <main className="screen-host">
          {screen === 'entry' && <EntryScreen onOpenReview={openReview} />}
          {screen === 'submit' && (
            <SubmitExportScreen reviewId={activeReviewId} onBack={() => setScreen('review')} />
          )}
          {screen === 'prompt' && <PromptRulesScreen onBack={() => setScreen('entry')} />}
          {screen === 'history' && <HistoryScreen onOpen={openReview} />}
          {screen === 'settings' && <SettingsScreen onOpenPrompt={() => setScreen('prompt')} />}
        </main>
      )}

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
