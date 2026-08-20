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
import { LogoMark } from './components/LogoMark';
import { AppRail, type RailScreen } from './components/AppRail';
import { CompletionToast } from './components/CompletionToast';
import { useUpdateStatus } from './update/useUpdateStatus';
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
  // 通知点击带来的定位目标。ReviewScreen 定位一次就把它消费掉(onFocusHandled)——
  // 留着的话,换 review 重挂或离开再回本屏时会被当成新请求再执行一遍,
  // 而那条 discussion 未必属于当下这条 review,composer 就会往一条不存在的线程发。
  const [focusDiscussion, setFocusDiscussion] = useState<{ id: string } | null>(null);
  // 提交/导出屏的「返回 diff 并重跑」:回到 review 屏后由它弹出重跑面板,兑现一次即消费。
  // 与 focusDiscussion 同理带上 reviewId —— ReviewScreen 要等 status 到了才兑现,这段空窗里
  // 若换了 review(rail 走开再从历史/通知开另一条),裸布尔会在别人的 review 上弹出面板。
  const [rerunRequest, setRerunRequest] = useState<{ reviewId: string } | null>(null);
  // 设置屏的定位请求(目前只有 rail 上那颗更新未读点会发)。与 focusDiscussion 同理兑现一次即消费:
  // 留着的话,之后每次从别处回设置屏都会被再滚一遍。
  const [settingsFocus, setSettingsFocus] = useState<{ section: 'about' } | null>(null);
  const updateStatus = useUpdateStatus();
  const updateReady = updateStatus.phase === 'ready';

  const openReview = (id: string, discussionId?: string) => {
    setActiveReviewId(id);
    setScreen('review');
    setToast(null);
    setFocusDiscussion(discussionId ? { id: discussionId } : null);
    setRerunRequest(null);
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
    // 未读点指向的是「关于」那行的重启按钮,进屏就把它滚到眼前 —— 否则用户只知道有事,不知道在哪
    if (s === 'settings' && updateReady) setSettingsFocus({ section: 'about' });
    setScreen(s);
  };

  return (
    <div className="app">
      {/* review 屏自带上下文顶栏;其余屏用这条通用栏(同时是窗口拖拽区 + 交通灯留白) */}
      {screen !== 'review' && (
        <header className="app-topbar">
          <span className="brand">
            <LogoMark size={20} />
            <Wordmark />
          </span>
          <span className="tb-sep" />
          <h1 className="tb-title">{SCREEN_TITLE[screen]}</h1>
        </header>
      )}

      <AppRail
        active={RAIL_OF[screen]}
        reviewAvailable={activeReviewId !== null}
        updateReady={updateReady}
        onNavigate={onRail}
      />

      {screen === 'review' ? (
        /* key = 换 review 即重挂:屏内一切 per-review 本地态(草稿、活跃线程、待恢复原文…)
           随实例一起作废,旧 review 的在途回调也只能写到已卸载的那个实例上。手工逐项重置
           迟早漏 —— 每加一处状态都得记得回去补,而漏掉的那次就是跨 review 写。 */
        <ReviewScreen
          key={activeReviewId ?? 'none'}
          reviewId={activeReviewId}
          onOpenSubmit={() => setScreen('submit')}
          focusRequest={focusDiscussion}
          onFocusHandled={() => setFocusDiscussion(null)}
          rerunRequest={rerunRequest}
          onRerunHandled={() => setRerunRequest(null)}
        />
      ) : (
        <main className="screen-host">
          {screen === 'entry' && <EntryScreen onOpenReview={openReview} />}
          {screen === 'submit' && (
            <SubmitExportScreen
              reviewId={activeReviewId}
              onBack={() => setScreen('review')}
              onRerun={() => {
                if (!activeReviewId) return;
                setRerunRequest({ reviewId: activeReviewId });
                setScreen('review');
              }}
            />
          )}
          {screen === 'prompt' && (
            <PromptRulesScreen reviewId={activeReviewId} onBack={() => setScreen('entry')} />
          )}
          {screen === 'history' && <HistoryScreen onOpen={openReview} />}
          {screen === 'settings' && (
            <SettingsScreen
              onOpenPrompt={() => setScreen('prompt')}
              focusSection={settingsFocus?.section ?? null}
              onFocusHandled={() => setSettingsFocus(null)}
            />
          )}
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
