import { useSettings } from '../settings/SettingsProvider';
import './AppRail.css';

export type RailScreen = 'entry' | 'review' | 'history' | 'prompt' | 'settings';

// 全局导航 rail(→ mockup/diff-review.html 左侧 rail):所有工作屏共用,
// 让 review 屏也能一键回入口 / 进设置。配色主题(两轴中的 data-theme)只在设置屏里改。
export function AppRail({
  active,
  reviewAvailable,
  onNavigate,
}: {
  active: RailScreen;
  /** 无活跃 review 时「当前审核」不可达 */
  reviewAvailable: boolean;
  onNavigate: (s: RailScreen) => void;
}): React.JSX.Element {
  const { settings, update } = useSettings();
  const dark = settings.dataMode === 'dark';

  const item = (id: RailScreen, label: string, icon: React.JSX.Element, disabled = false) => (
    <button
      className={`rail-btn${active === id ? ' on' : ''}`}
      onClick={() => onNavigate(id)}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-current={active === id ? 'page' : undefined}
    >
      {icon}
    </button>
  );

  return (
    <nav className="app-rail" aria-label="主导航">
      {item('entry', '入口 · 发起新审核', <HomeIcon />)}
      {item('review', '当前审核', <ReviewIcon />, !reviewAvailable)}
      {item('history', '审核历史', <HistoryIcon />)}
      {item('prompt', '审核规则', <RulesIcon />)}
      <span className="rail-gap" />
      <button
        className="rail-btn"
        onClick={() => update({ dataMode: dark ? 'light' : 'dark' })}
        title={dark ? '切换为浅色' : '切换为深色'}
        aria-label="切换明暗"
      >
        {dark ? <MoonIcon /> : <SunIcon />}
      </button>
      {item('settings', '设置', <GearIcon />)}
    </nav>
  );
}

const S = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const HomeIcon = () => (
  <svg {...S}>
    <path d="M3 10.2 12 3l9 7.2" />
    <path d="M5 9.5V20h14V9.5" />
  </svg>
);

const ReviewIcon = () => (
  <svg {...S}>
    <path d="M4 5h11l5 5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    <path d="M14 5v6h6" />
    <path d="M7 15h7" />
  </svg>
);

const HistoryIcon = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5.2l3.4 2" />
  </svg>
);

const RulesIcon = () => (
  <svg {...S}>
    <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z" />
    <path d="M8.8 10h7M8.8 13.6h7M8.8 17h4" />
  </svg>
);

const MoonIcon = () => (
  <svg {...S}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2z" />
  </svg>
);

const SunIcon = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6 6 18M18 6l1.6-1.6" />
  </svg>
);

const GearIcon = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.1 14.4a1.6 1.6 0 0 0 .32 1.8l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.8-.32 1.6 1.6 0 0 0-.97 1.47v.17a2 2 0 0 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.8.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.8 1.6 1.6 0 0 0-1.47-.97H2.8a2 2 0 0 1 0-4h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.8l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.8.32h.08A1.6 1.6 0 0 0 9.7 3.7v-.17a2 2 0 0 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.8-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.8v.08a1.6 1.6 0 0 0 1.47.97h.17a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.47.97z" />
  </svg>
);
