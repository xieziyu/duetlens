import { DATA_MODE_LABELS, nextDataMode } from '@shared/domain';
import { useSettings, type ColorTheme } from '../settings/SettingsProvider';

// 明暗 + 配色两轴控件;顶栏合并后由 App 全局栏与 review 栏共用。
export function ThemeControls() {
  const { settings, update } = useSettings();
  const mode = settings.dataMode;
  const next = nextDataMode(mode);
  return (
    <div className="theme-controls">
      <select
        className="mono theme-select"
        value={settings.dataTheme}
        onChange={(e) => update({ dataTheme: e.target.value as ColorTheme })}
        aria-label="配色主题"
      >
        <option value="duetlens">duetlens</option>
        <option value="github">github</option>
        <option value="parchment">parchment</option>
      </select>
      <button
        className="mode-toggle"
        onClick={() => update({ dataMode: next })}
        title={`明暗:${DATA_MODE_LABELS[mode]} · 切换为${DATA_MODE_LABELS[next]}`}
        aria-label={`明暗模式:${DATA_MODE_LABELS[mode]}`}
      >
        {mode === 'system' ? '🖥️' : mode === 'dark' ? '🌙' : '☀️'}
      </button>
    </div>
  );
}
