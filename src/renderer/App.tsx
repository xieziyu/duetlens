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
import { ReviewTabs, type TabNotice } from './components/ReviewTabs';
import { CompletionToast } from './components/CompletionToast';
import { TabVisibilityProvider } from './review/TabVisibility';
import { useTabMeta } from './review/useTabMeta';
import {
  activateTab,
  activeTab as activeTabOf,
  closeTab,
  openTab,
  setTabView,
  EMPTY_TABS,
  MAX_TABS,
  type TabState,
} from './review/tabs';
import { useSettings } from './settings/SettingsProvider';
import { tabStepKey } from './keys';
import { stepTab } from './review/tabs';
import { useUpdateStatus } from './update/useUpdateStatus';
import './App.css';

// 屏路由。除 onboarding(全屏引导)外都套同一外壳:整幅顶栏 + 左侧 rail;
// review 屏用 display:contents 把自己的顶栏/主体/状态栏直接放进外壳网格。
// 提交 / 导出**不是**一个屏:它属于某一条 review,故收成 tab 内的视图(见 tabs.ts)。
type Screen = 'entry' | 'review' | 'prompt' | 'onboarding' | 'history' | 'settings';
/** preview 直达用的入参仍认 submit —— 它落地成「活跃 tab 停在提交视图」。 */
type InitialScreen = Screen | 'submit';

const SCREEN_TITLE: Partial<Record<Screen, string>> = {
  entry: '发起审核',
  prompt: '审核规则',
  history: '审核历史',
  settings: '设置',
};

const RAIL_OF: Record<Screen, RailScreen> = {
  entry: 'entry',
  review: 'review',
  prompt: 'prompt',
  history: 'history',
  settings: 'settings',
  onboarding: 'entry',
};

const NOTICE_MS = 8000;

/** 冷启动的 tab 集合;production 只可能有 0 或 1 枚,多枚来自 preview 的 `?tabs=`。 */
function initialTabState(
  initialReviewId: string | null,
  initialTabs: string[] | undefined,
  initialScreen: InitialScreen | undefined,
): TabState {
  // 恢复出来的一串同样受上限约束 —— 上限是为了压住内存,不是只压手动打开那条路
  const ids = (initialTabs?.length ? initialTabs : initialReviewId ? [initialReviewId] : []).slice(0, MAX_TABS);
  if (ids.length === 0) return EMPTY_TABS;
  const activeId = initialReviewId && ids.includes(initialReviewId) ? initialReviewId : ids[0];
  const view = initialScreen === 'submit' ? 'submit' : 'review';
  return {
    tabs: ids.map((reviewId) => ({ reviewId, view: reviewId === activeId ? view : 'review' })),
    activeId,
  };
}

// initialReviewId / initialTabs / initialScreen 仅 preview 入口用于直达某屏;production main.tsx 不传。
export function App({
  initialReviewId = null,
  initialScreen,
  initialTabs,
}: { initialReviewId?: string | null; initialScreen?: InitialScreen; initialTabs?: string[] } = {}) {
  const [tabState, setTabState] = useState<TabState>(() =>
    initialTabState(initialReviewId, initialTabs, initialScreen),
  );
  const [screen, setScreen] = useState<Screen>(() => {
    if (initialScreen === 'submit') return 'review';
    return initialScreen ?? (initialReviewId || initialTabs?.length ? 'review' : 'entry');
  });
  const [toast, setToast] = useState<CompletionNotice | null>(null);
  /**
   * 通知点击带来的定位目标。带上 reviewId:多 tab 之后所有已开 tab 都挂着,不认 id 的话
   * 这条请求会被每一枚 tab 都当成自己的,往一条不属于它的 discussion 上定位。
   * ReviewScreen 定位一次就把它消费掉(onFocusHandled)—— 留着的话下次回本屏会再执行一遍。
   */
  const [focusDiscussion, setFocusDiscussion] = useState<{ reviewId: string; id: string } | null>(null);
  // 提交/导出视图的「返回 diff 并重跑」:回到 review 视图后由它弹出重跑面板,兑现一次即消费。
  const [rerunRequest, setRerunRequest] = useState<{ reviewId: string } | null>(null);
  // 设置屏的定位请求(目前只有 rail 上那颗更新未读点会发);同样兑现一次即消费。
  const [settingsFocus, setSettingsFocus] = useState<{ section: 'about' } | null>(null);
  /** tab 条上的一句轻提示(满载 / 关掉了一条在跑的审核),到点自己消失。 */
  const [notice, setNotice] = useState<TabNotice | null>(null);
  /**
   * 哪几枚 tab 里还有「关掉就没了」的东西(未发出的原文)。由各 ReviewScreen 上报 ——
   * 那些草稿一个字都不落库,关 tab 的人看不见它们还在。
   */
  const [unsaved, setUnsaved] = useState<Record<string, boolean>>({});
  const { settings, update: saveSettings, loaded: settingsLoaded } = useSettings();
  /**
   * tab 集合是否已从上次的记录恢复完。preview 用 `?tabs=` 直接给定,就不再从库里恢复 ——
   * 恢复会把它指定的那几枚顶掉。
   */
  const [restored, setRestored] = useState(initialTabs != null || initialReviewId != null);
  const updateStatus = useUpdateStatus();
  const updateReady = updateStatus.phase === 'ready';

  /**
   * 最新的 tab 集合。通知订阅是挂载时装一次的,它捕获的 `openReview` 里那份 `tabState`
   * 永远停在冷启动那一刻(生产上就是空集)。用它算新集合,等于用户点一下通知就把已开的
   * tab 全抹掉 —— 连同那几枚里不落库的在途回复、草稿、滚动位置。故开合一律读这里。
   */
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;

  const tab = activeTabOf(tabState);
  const activeReviewId = tab?.reviewId ?? null;
  /** review 视图此刻是否占着屏:决定通用顶栏出不出、以及哪一枚 tab 拿到「我是活跃的」。 */
  const showReview = screen === 'review' && tab?.view === 'review';
  // 未读数按「此刻正看着谁」清零:人在入口 / 历史 / 设置 / 提交视图时谁都没在看,
  // 传 activeId 会让那枚 tab 期间新报出的 finding 被当成已读,回来就不知道后台有过动静
  const meta = useTabMeta(
    tabState.tabs.map((t) => t.reviewId),
    showReview ? tabState.activeId : null,
  );

  /**
   * 挂载过就常驻:后台 tab 的在途回复残文、动作流、草稿、滚动位置都只活在组件里,卸载即归零。
   * 反过来,**没被激活过的 tab 先不挂**(恢复出来的一堆 tab 不该在冷启动一次性挂上 N 份 diff)。
   */
  const [everActive, setEverActive] = useState<string[]>(() => (tabState.activeId ? [tabState.activeId] : []));
  useEffect(() => {
    const id = tabState.activeId;
    if (id && !everActive.includes(id)) setEverActive((prev) => [...prev, id]);
  }, [tabState.activeId, everActive]);

  useEffect(() => {
    if (!notice || notice.sticky) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * 冷启动恢复上次开着的 tab。**逐条核对 review 还在不在** —— 30 天保留会清掉旧的、用户也可能
   * 删过,拿一个空壳 tab 占着位子,点进去是一屏永远加载不完的空白。
   * 只做一次;恢复完落到 review 屏(缺 codex 时首启自检会照常把整窗换成引导,那条优先)。
   */
  useEffect(() => {
    if (!settingsLoaded || restored) return;
    const ids = settings.openReviewIds.slice(0, MAX_TABS);
    if (ids.length === 0) {
      setRestored(true);
      return;
    }
    let alive = true;
    void Promise.all(
      ids.map((id) =>
        window.duetlens.review
          .get(id)
          // 只有**明确查到不存在**才剔除。读失败(库被锁住 / IPC 抖一下)不是「它没了」——
          // 当成没了的话,这次恢复少一枚,紧接着的写回还会把这份残缺当成新的记录落库,
          // 用户的 tab 布局就此永久少一块。宁可留着,那枚 tab 自己会再拉一次
          .then((r) => (r ? id : null))
          .catch(() => id),
      ),
    ).then((list) => {
      if (!alive) return;
      const live = list.filter((x): x is string => x !== null);
      if (live.length > 0) {
        const active = live.includes(settings.activeReviewId) ? settings.activeReviewId : live[0];
        setTabState({ tabs: live.map((reviewId) => ({ reviewId, view: 'review' })), activeId: active });
        setEverActive([active]);
        // 环境自检是另一条异步链,两者谁先回来不定。缺 codex 时它已经把整窗换成引导了,
        // 这里再无条件盖回 review 就等于绕过首启门控 —— 引导优先,读最新的 screen 判
        setScreen((prev) => (prev === 'onboarding' ? prev : 'review'));
      }
      setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, [settingsLoaded, restored, settings.openReviewIds, settings.activeReviewId]);

  // 开合与切换即写回(SettingsProvider 自己去抖)。**恢复完成前不写** ——
  // 那会儿 tabState 还是空的,写回去就是拿一份空记录把上次的 tab 抹了。
  useEffect(() => {
    if (!restored) return;
    saveSettings({
      openReviewIds: tabState.tabs.map((t) => t.reviewId),
      activeReviewId: tabState.activeId ?? '',
    });
  }, [restored, tabState, saveSettings]);

  /**
   * ⌃⇥ / ⌃⇧⇥ 前后切 tab。模态开着时让位:与屏内 ⌘F / ⌘E 遇模态让位是同一条规矩,
   * 而**判据要排除隐藏 tab 里那些开着的模态** —— 它们还在 DOM 里,却连屏都不在。
   */
  useEffect(() => {
    if (tabState.tabs.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const step = tabStepKey(e);
      if (step === null) return;
      const modal = [...document.querySelectorAll('[role="dialog"]')].some((el) =>
        el.checkVisibility ? el.checkVisibility() : (el as HTMLElement).offsetParent !== null,
      );
      if (modal) return;
      e.preventDefault();
      setTabState((prev) => stepTab(prev, step));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabState.tabs.length]);

  const openReview = (id: string, discussionId?: string) => {
    const r = openTab(tabStateRef.current, id);
    if (!r.ok) {
      // 提示只画在 tab 条上,而 tab 条只在 review 屏 —— 停在入口 / 历史屏原地不动地
      // 设一条看不见的提示,在用户那儿就是「点了没反应」。所以连人一起带过去
      setNotice({ text: `最多同时开 ${MAX_TABS} 枚,先关掉一枚再打开这条` });
      setScreen('review');
      return;
    }
    setTabState(setTabView(r.state, id, 'review'));
    setScreen('review');
    setToast(null);
    setFocusDiscussion(discussionId ? { reviewId: id, id: discussionId } : null);
    setRerunRequest(null);
  };

  /**
   * 关 tab 只摘视图。**不调 `review.release()`** —— 那条路(disposeReview → teardown)不看忙闲,
   * 会把正在跑的机审拆在半路;会话何时回收由后端按 LRU 决定,与 tab 无关。
   */
  const onCloseTab = (id: string, force = false) => {
    // 有没发出去的原文就先拦一下,把「仍然关闭」摆在同一句话里 —— 用弹窗问一遍太重,
    // 而这批草稿一个字都不落库,关掉就真没了
    if (!force && unsaved[id]) {
      setNotice({
        text: '这枚 tab 里还有没发出去的原文,关掉就没了',
        action: { label: '仍然关闭', onRun: () => onCloseTab(id, true) },
        sticky: true,
      });
      return;
    }
    // 就地算出新状态(而不是在 updater 里顺手 setScreen):updater 必须是纯的,
    // StrictMode 下它会被跑两遍
    const next = closeTab(tabStateRef.current, id);
    setTabState(next);
    setNotice(null); // 关成了,那条确认没有留下的理由
    // 关掉最后一枚:review 屏此刻什么都没有,回入口(rail 上的「当前审核」也随之不可达)
    if (next.tabs.length === 0) setScreen('entry');
    setEverActive((prev) => prev.filter((x) => x !== id));
    setUnsaved((prev) => (id in prev ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)) : prev));
    // 在跑的时候关掉最容易被读成「我把它停了」,给一句话说清,并留一步回头路
    if (meta[id]?.status === 'scanning')
      setNotice({
        text: '这条审核继续在后台跑,完成会通知你',
        action: { label: '重新打开', onRun: () => openReview(id) },
      });
  };

  // 通知点击「聚焦+定位」挂在常驻的 App:onOpenReview 打开 review;onInApp 弹轻提示。
  // 用 ref 记住当前所看,避免为订阅重挂而随导航变化。
  const viewing = useRef<{ reviewId: string | null }>({ reviewId: null });
  viewing.current = { reviewId: showReview ? activeReviewId : null };
  useEffect(() => {
    const n = window.duetlens.notifications;
    if (!n) return;
    const offOpen = n.onOpenReview(({ reviewId, discussionId }) => openReview(reviewId, discussionId));
    const offInApp = n.onInApp((notice) => {
      // 「正看着」= 那条 review 就是屏上这一枚 tab;开着但在后台的照旧提示
      if (viewing.current.reviewId === notice.reviewId) return;
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
    if (s === 'review' && tabState.tabs.length === 0) return;
    // 未读点指向的是「关于」那行的重启按钮,进屏就把它滚到眼前 —— 否则用户只知道有事,不知道在哪
    if (s === 'settings' && updateReady) setSettingsFocus({ section: 'about' });
    setScreen(s);
  };

  return (
    <div className="app">
      {/* review 视图自带上下文顶栏;其余屏(含 tab 内的提交/导出)用这条通用栏 */}
      {!showReview && (
        <header className="app-topbar">
          <span className="brand">
            <LogoMark size={20} />
            <Wordmark />
          </span>
          <span className="tb-sep" />
          <h1 className="tb-title">{screen === 'review' ? '提交 / 导出' : SCREEN_TITLE[screen]}</h1>
        </header>
      )}

      <AppRail
        active={RAIL_OF[screen]}
        reviewAvailable={tabState.tabs.length > 0}
        updateReady={updateReady}
        onNavigate={onRail}
      />

      {screen === 'review' && tabState.tabs.length > 0 && (
        <ReviewTabs
          tabs={tabState.tabs}
          activeId={tabState.activeId}
          meta={meta}
          notice={notice}
          onActivate={(id) => {
            setNotice(null); // 去看别处了 = 那条待办的确认作罢
            setTabState((prev) => activateTab(prev, id));
          }}
          onClose={(id) => onCloseTab(id)}
          onNew={() => setScreen('entry')}
        />
      )}

      {/* 已开的 tab 全部挂着,只有活跃那枚可见(见 TabVisibility)。key 仍是 reviewId ——
          一枚 tab 的 reviewId 不会变,重挂只发生在关掉它的时候。 */}
      {tabState.tabs
        .filter((t) => everActive.includes(t.reviewId))
        .map((t) => (
          <TabVisibilityProvider
            key={t.reviewId}
            active={showReview && t.reviewId === tabState.activeId}
          >
            <ReviewScreen
              reviewId={t.reviewId}
              onOpenSubmit={() => setTabState((prev) => setTabView(prev, t.reviewId, 'submit'))}
              focusRequest={focusDiscussion?.reviewId === t.reviewId ? { id: focusDiscussion.id } : null}
              onFocusHandled={() => setFocusDiscussion(null)}
              rerunRequest={rerunRequest?.reviewId === t.reviewId ? rerunRequest : null}
              onRerunHandled={() => setRerunRequest(null)}
              onOpenReview={openReview}
              onUnsavedChange={(has) =>
                setUnsaved((prev) => (!!prev[t.reviewId] === has ? prev : { ...prev, [t.reviewId]: has }))
              }
            />
          </TabVisibilityProvider>
        ))}

      {screen !== 'review' && (
        <main className="screen-host">
          {screen === 'entry' && <EntryScreen onOpenReview={openReview} />}
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

      {/* 提交/导出:活跃 tab 的子视图,tab 条仍在上方,回退即回到这条 review 的 diff */}
      {screen === 'review' && tab?.view === 'submit' && (
        <main className="screen-host">
          <SubmitExportScreen
            reviewId={tab.reviewId}
            onBack={() => setTabState((prev) => setTabView(prev, tab.reviewId, 'review'))}
            onRerun={() => {
              setRerunRequest({ reviewId: tab.reviewId });
              setTabState((prev) => setTabView(prev, tab.reviewId, 'review'));
            }}
          />
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
