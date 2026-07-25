import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { CodexModelInfo, SourceKind, UiSettings } from '@shared/domain';
import { DEFAULT_UI_SETTINGS, REASONING_EFFORTS, REVIEW_INTENSITIES } from '@shared/domain';
import type { EnvironmentReport } from '@shared/environment';
import { useSettings } from '../settings/SettingsProvider';
import { KbdHelp } from '../components/KbdHelp';
import './SettingsScreen.css';

// 独立设置屏。左导航分节 + 右内容;改动经 useSettings 即时去抖落库。
// 明暗只有浅色/深色两档:「跟随系统」未接,需 SettingsProvider 先支持 system 解析。

const NAV: { group: string; items: { id: SectionId; icon: string; label: string }[] }[] = [
  {
    group: '偏好',
    items: [
      { id: 'appearance', icon: '◐', label: '外观' },
      { id: 'review', icon: '▤', label: '审核默认' },
      { id: 'shortcuts', icon: '⌘', label: '快捷键' },
    ],
  },
  {
    group: '环境',
    items: [
      { id: 'codex', icon: '◆', label: 'codex' },
      { id: 'github', icon: '⑂', label: 'GitHub CLI' },
    ],
  },
  {
    group: '其它',
    items: [
      { id: 'rules', icon: '▦', label: '审核规则提示词' },
      { id: 'about', icon: '◇', label: '关于' },
    ],
  },
];

type SectionId = 'appearance' | 'review' | 'shortcuts' | 'codex' | 'github' | 'rules' | 'about';
const SECTION_IDS: SectionId[] = ['appearance', 'review', 'shortcuts', 'codex', 'github', 'rules', 'about'];

// 入口只有两档;本地这档统一存 local-branch,普通分支还是虚拟分支由发起时的仓库探测决定
const SOURCE_CHOICES: { v: SourceKind; label: string }[] = [
  { v: 'github-pr', label: 'GitHub PR' },
  { v: 'local-branch', label: '本地仓库' },
];

export function SettingsScreen({ onOpenPrompt }: { onOpenPrompt: () => void }): React.JSX.Element {
  const { settings, update } = useSettings();
  const [active, setActive] = useState<SectionId>('appearance');
  const [env, setEnv] = useState<EnvironmentReport | null>(null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [models, setModels] = useState<CodexModelInfo[] | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const runEnvCheck = useCallback(async () => {
    setCheckingCodex(true);
    try {
      setEnv(await window.duetlens.checkEnvironment({ deep: true }));
    } finally {
      setCheckingCodex(false);
    }
  }, []);

  useEffect(() => {
    void runEnvCheck();
    window.duetlens.agent.listModels().then(setModels).catch(() => setModels([]));
    window.duetlens.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, [runEnvCheck]);

  // 左导航滚动定位 + 滚动高亮(scroll-spy);按 data-sec 现取 DOM,避免 ref map 时序问题。
  const secEl = (id: SectionId): HTMLElement | null =>
    contentRef.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`) ?? null;
  const goTo = (id: SectionId): void => {
    secEl(id)?.scrollIntoView({ block: 'start' });
    setActive(id);
  };
  const onScroll = (): void => {
    const c = contentRef.current;
    if (!c) return;
    // 用 viewport 坐标比较,避免 offsetParent 差异导致的错位
    const cTop = c.getBoundingClientRect().top;
    const threshold = cTop + 80;
    // 触底后滚动被夹断,尾部分节的顶边永远越不过判定线,spy 只能算出它上面那节 ——
    // 于是点击尾部导航刚设的高亮会被这次 scroll 抢走(要点第二次才留得住)。
    // 此时只要当前高亮分节的标题还在视口里,就认它,不改。
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 1) {
      const cur = secEl(active);
      if (cur && cur.getBoundingClientRect().top >= cTop) return;
    }
    let cur: SectionId = SECTION_IDS[0];
    for (const id of SECTION_IDS) {
      const el = secEl(id);
      if (el && el.getBoundingClientRect().top <= threshold) cur = id;
    }
    setActive(cur);
  };

  // codex 路径 / gh 路径先落库(即时应用到 exec 解析),再自检,使「检测」反映刚填的路径。
  const detectCodex = async (): Promise<void> => {
    await window.duetlens.ui.saveSettings(settings);
    await runEnvCheck();
  };
  const pickCodexPath = async (): Promise<void> => {
    const f = await window.duetlens.dialog.pickFile();
    if (f) update({ codexPath: f });
  };
  const pickGhPath = async (): Promise<void> => {
    const f = await window.duetlens.dialog.pickFile();
    if (f) update({ ghPath: f });
  };

  const resetDefaults = (): void => {
    update({ ...DEFAULT_UI_SETTINGS, dataMode: settings.dataMode, dataTheme: settings.dataTheme });
  };

  return (
    <div className="settings">
      <nav className="set-nav">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="grp mono">{g.group}</div>
            {g.items.map((it) => (
              <button
                key={it.id}
                className={`set-link${active === it.id ? ' on' : ''}`}
                onClick={() => goTo(it.id)}
              >
                <span className="ic">{it.icon}</span>
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="set-content" ref={contentRef} onScroll={onScroll}>
        <div className="set-sheet">
          {/* 外观 */}
          <section className="set-sec" data-sec="appearance">
            <h2><span className="ic">◐</span> 外观</h2>
            <div className="desc">明暗模式与配色主题两个正交轴,应用启动即生效,跨所有审核一致。</div>
            <Row label="明暗模式">
              <Choice
                value={settings.dataMode}
                options={[
                  { v: 'light', label: '☀ 浅色' },
                  { v: 'dark', label: '☾ 深色' },
                ]}
                onPick={(v) => update({ dataMode: v as UiSettings['dataMode'] })}
              />
            </Row>
            <Row label="配色主题">
              <select
                className="field mono"
                value={settings.dataTheme}
                onChange={(e) => update({ dataTheme: e.target.value as UiSettings['dataTheme'] })}
              >
                <option value="duetlens">Duetlens</option>
                <option value="github">GitHub</option>
              </select>
            </Row>
          </section>

          {/* 审核默认 */}
          <section className="set-sec" data-sec="review">
            <h2><span className="ic">▤</span> 审核默认</h2>
            <div className="desc">发起与进入审核时的默认选择;单次审核内的临时改动不写回这里。</div>
            <Row label="默认来源">
              <Choice
                value={settings.defaultSource === 'github-pr' ? 'github-pr' : 'local-branch'}
                options={SOURCE_CHOICES.map((s) => ({ v: s.v, label: s.label }))}
                onPick={(v) => update({ defaultSource: v as SourceKind })}
              />
            </Row>
            <Row label="默认 diff 视图">
              <Choice
                value={settings.defaultDiffView}
                options={[
                  { v: 'unified', label: 'Unified' },
                  { v: 'split', label: 'Split' },
                ]}
                onPick={(v) => update({ defaultDiffView: v as UiSettings['defaultDiffView'] })}
              />
            </Row>
            <Row label="默认右栏 Tab">
              <Choice
                value={settings.defaultTab}
                options={[
                  { v: 'discussion', label: 'Discussion' },
                  { v: 'findings', label: 'Findings' },
                  { v: 'summary', label: 'Summary' },
                ]}
                onPick={(v) => update({ defaultTab: v as UiSettings['defaultTab'] })}
              />
            </Row>
            <Row label="Findings 默认分组">
              <Choice
                value={settings.findingsGrouping}
                options={[
                  { v: 'severity', label: '按严重度' },
                  { v: 'file', label: '按文件' },
                ]}
                onPick={(v) => update({ findingsGrouping: v as UiSettings['findingsGrouping'] })}
              />
            </Row>
            <Row label="标记「已看」后自动折叠文件">
              <Toggle on={settings.collapseViewedFiles} onToggle={() => update({ collapseViewedFiles: !settings.collapseViewedFiles })} />
            </Row>
            <Row label="完成时通知" hint="扫描完成 / 追问回复时提示(未聚焦弹原生通知,聚焦弹应用内提示)。">
              <Toggle on={settings.notifyOnComplete} onToggle={() => update({ notifyOnComplete: !settings.notifyOnComplete })} />
            </Row>
          </section>

          {/* 快捷键 */}
          <section className="set-sec" data-sec="shortcuts">
            <h2><span className="ic">⌘</span> 快捷键</h2>
            <div className="desc">键位暂不支持修改。</div>
            <Row label="键位一览">
              <button className="btn-sm" onClick={() => setHelpOpen(true)}>查看快捷键</button>
            </Row>
          </section>

          {/* codex */}
          <section className="set-sec" data-sec="codex">
            <h2><span className="ic">◆</span> codex</h2>
            <div className="desc">审核 agent 由 codex app-server 常驻会话驱动;沙箱固定只读,不可改。</div>
            <Row label="可执行文件路径" hint="留空则用 PATH 中的 codex。" col>
              <div className="path-row">
                <input
                  className="field mono"
                  spellCheck={false}
                  placeholder="/opt/homebrew/bin/codex"
                  value={settings.codexPath}
                  onChange={(e) => update({ codexPath: e.target.value })}
                />
                <button className="btn-sm" onClick={() => void pickCodexPath()}>选择…</button>
                <button className="btn-sm" onClick={() => void detectCodex()} disabled={checkingCodex}>
                  {checkingCodex ? '检测中…' : '检测'}
                </button>
              </div>
            </Row>
            <Row label="app-server 状态">
              <CodexStat env={env} checking={checkingCodex} />
            </Row>
            <Row label="模型" hint="发起表单默认模型(空=账号默认)。">
              <select
                className="field mono"
                value={settings.defaultModel}
                onChange={(e) => update({ defaultModel: e.target.value })}
              >
                <option value="">账号默认</option>
                {(models ?? []).map((m) => (
                  <option key={m.id} value={m.model}>{m.displayName || m.model}</option>
                ))}
              </select>
            </Row>
            <Row label="默认 effort">
              <select
                className="field mono"
                value={settings.defaultEffort}
                onChange={(e) => update({ defaultEffort: e.target.value as UiSettings['defaultEffort'] })}
              >
                {REASONING_EFFORTS.map((eff) => (
                  <option key={eff} value={eff}>{eff}</option>
                ))}
              </select>
            </Row>
            <Row label="默认强度" hint="对抗档:agent 以证伪立场构造反例并自检一轮,更准但 token 成倍。">
              <select
                className="field"
                value={settings.defaultIntensity}
                onChange={(e) => update({ defaultIntensity: e.target.value as UiSettings['defaultIntensity'] })}
              >
                {REVIEW_INTENSITIES.map((v) => (
                  <option key={v} value={v}>{v === 'adversarial' ? '对抗' : '标准'}</option>
                ))}
              </select>
            </Row>
            <Row label="沙箱">
              <span className="stat lock"><span className="d" />read-only · 锁定</span>
            </Row>
          </section>

          {/* github */}
          <section className="set-sec" data-sec="github">
            <h2><span className="ic">⑂</span> GitHub CLI</h2>
            <div className="desc">GitHub PR 来源与提交 review 依赖外部 gh;本地 / GitButler 来源无需登录。</div>
            <Row label="gh 路径" hint="留空则用 PATH 中的 gh。" col>
              <div className="path-row">
                <input
                  className="field mono"
                  spellCheck={false}
                  placeholder="/opt/homebrew/bin/gh"
                  value={settings.ghPath}
                  onChange={(e) => update({ ghPath: e.target.value })}
                />
                <button className="btn-sm" onClick={() => void pickGhPath()}>选择…</button>
              </div>
            </Row>
            <Row label="登录状态">
              <GhStat env={env} />
            </Row>
          </section>

          {/* 审核规则提示词 */}
          <section className="set-sec" data-sec="rules">
            <h2><span className="ic">▦</span> 审核规则提示词</h2>
            <div className="desc">project ▸ global ▸ builtin 三层提示词,决定 codex 的审核侧重;在独立编辑器中管理。</div>
            <Row label="三层提示词编辑器">
              <button className="btn-sm" onClick={onOpenPrompt}>打开编辑器 →</button>
            </Row>
          </section>

          {/* 关于 */}
          <section className="set-sec" data-sec="about">
            <h2><span className="ic">◇</span> 关于</h2>
            <div className="about">
              <div className="logo mono">duet<i>lens</i><span className="cur">_</span></div>
              <div className="vmeta">
                <div className="v">Duetlens <b>{appInfo?.version ?? '—'}</b></div>
                <div className="sub mono">
                  Electron {appInfo?.electron ?? '—'}
                  {env?.codex.version ? ` · codex ${env.codex.version}` : ''}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <footer className="set-foot">
        <div className="set-foot-in">
          <span className="msg"><span className="d" />改动即时保存到本地</span>
          <button className="btn-reset" onClick={resetDefaults}>恢复默认设置</button>
        </div>
      </footer>
      {helpOpen && <KbdHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function Row({
  label,
  hint,
  col,
  children,
}: {
  label: string;
  hint?: string;
  col?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`set-row${col ? ' col' : ''}`}>
      <div className="meta">
        <div className="lbl">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

function Choice({
  value,
  options,
  onPick,
}: {
  value: string;
  options: { v: string; label: string }[];
  onPick: (v: string) => void;
}): React.JSX.Element {
  return (
    <div className="choice">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }): React.JSX.Element {
  return <button className={`sw${on ? ' on' : ''}`} onClick={onToggle} aria-pressed={on} />;
}

function CodexStat({ env, checking }: { env: EnvironmentReport | null; checking: boolean }): React.JSX.Element {
  if (checking || !env) return <span className="stat checking"><span className="d" />检测中…</span>;
  if (env.codex.status !== 'ok') return <span className="stat err"><span className="d" />未检测到 codex</span>;
  if (env.appServer.status === 'ok') {
    return <span className="stat ok"><span className="d" />已连通{env.codex.version ? ` · v${env.codex.version}` : ''}</span>;
  }
  return <span className="stat err"><span className="d" />未连通</span>;
}

function GhStat({ env }: { env: EnvironmentReport | null }): React.JSX.Element {
  if (!env) return <span className="stat checking"><span className="d" />检测中…</span>;
  if (env.gh.status === 'ok') {
    return <span className="stat ok"><span className="d" />已登录{env.gh.user ? ` · ${env.gh.user}` : ''}</span>;
  }
  return <span className="stat warn"><span className="d" />未登录</span>;
}
