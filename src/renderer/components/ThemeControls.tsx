import { useSettings, type ColorTheme } from '../settings/SettingsProvider';

// 明暗 + 配色两轴控件;顶栏合并后由 App 全局栏与 review 栏共用。
export function ThemeControls() {
  const { settings, update } = useSettings();
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
        onClick={() => update({ dataMode: settings.dataMode === 'dark' ? 'light' : 'dark' })}
        aria-label="切换明暗"
      >
        {settings.dataMode === 'dark' ? '🌙' : '☀️'}
      </button>
    </div>
  );
}
