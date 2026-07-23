import { useCallback, useEffect, useState } from 'react';
import type { EnvironmentReport } from '@shared/environment';
import { Wordmark } from '../components/Wordmark';
import { ThemeControls } from '../components/ThemeControls';
import './OnboardingScreen.css';

// 首启环境自检屏。
// codex + app-server 必需就绪才放行;gh 可选(仅 GitHub 来源需要),缺失只提示不拦。

type StepStatus = 'checking' | 'ok' | 'fail' | 'warn' | 'wait';

interface StepView {
  key: 'codex' | 'app' | 'gh';
  ico: string;
  name: string;
  optional: boolean;
  desc: string;
  status: StepStatus;
  detail: string;
  fix: FixView | null;
}

interface FixView {
  tone: 'fail' | 'warn';
  lead: string;
  cmd: string;
  docLabel: string;
  docHref: string;
}

const CODEX_DESC = '审核 agent 的运行时;Duetlens 通过它的 app-server 常驻会话驱动机审。';
const APP_DESC = '与 codex 建立常驻 JSON-RPC 会话;由 Duetlens 自动拉起,无需手动命令。';
const GH_DESC = '仅 GitHub PR 来源与提交 review 需要;本地分支 / GitButler 来源无需登录。';

/** 后端自检报告 → 三步展示态;codex 缺失时 app-server 显示为「待前一步」。 */
function toSteps(report: EnvironmentReport | null): StepView[] {
  if (!report) {
    return [
      { key: 'codex', ico: '◆', name: 'codex CLI', optional: false, desc: CODEX_DESC, status: 'checking', detail: '正在检测…', fix: null },
      { key: 'app', ico: '⇄', name: 'app-server 连通', optional: false, desc: APP_DESC, status: 'checking', detail: '正在检测…', fix: null },
      { key: 'gh', ico: '⑂', name: 'GitHub CLI', optional: true, desc: GH_DESC, status: 'checking', detail: '正在检测…', fix: null },
    ];
  }
  const codexOk = report.codex.status === 'ok';
  const appStatus: StepStatus = !codexOk
    ? 'wait'
    : report.appServer.status === 'ok'
      ? 'ok'
      : 'fail';
  return [
    {
      key: 'codex',
      ico: '◆',
      name: 'codex CLI',
      optional: false,
      desc: CODEX_DESC,
      status: codexOk ? 'ok' : 'fail',
      detail: codexOk ? `已安装 · ${report.codex.version}` : '未检测到',
      fix: codexOk
        ? null
        : {
            tone: 'fail',
            lead: '在 PATH 中没有找到 codex。安装后点「重新检测」:',
            cmd: 'brew install codex',
            docLabel: 'codex-cli 安装文档',
            docHref: 'https://github.com/openai/codex',
          },
    },
    {
      key: 'app',
      ico: '⇄',
      name: 'app-server 连通',
      optional: false,
      desc: APP_DESC,
      status: appStatus,
      detail:
        appStatus === 'ok'
          ? '已建立会话'
          : appStatus === 'wait'
            ? '等待 codex 就绪'
            : report.appServer.error ?? '握手失败',
      fix: null,
    },
    {
      key: 'gh',
      ico: '⑂',
      name: 'GitHub CLI',
      optional: true,
      desc: GH_DESC,
      status: report.gh.status === 'ok' ? 'ok' : 'warn',
      detail: report.gh.status === 'ok' ? `已登录 · ${report.gh.user ?? '已认证'}` : '未登录',
      fix:
        report.gh.status === 'ok'
          ? null
          : {
              tone: 'warn',
              lead: '未登录 gh。不影响本地 / GitButler 来源;需要 GitHub PR 时再登录即可:',
              cmd: 'gh auth login',
              docLabel: 'gh 认证文档',
              docHref: 'https://cli.github.com/manual/gh_auth_login',
            },
    },
  ];
}

function Chip({ status }: { status: StepStatus }): React.JSX.Element {
  if (status === 'checking') return <span className="chip checking"><span className="sp" />检测中</span>;
  if (status === 'wait') return <span className="chip wait"><span className="d" />待前一步</span>;
  if (status === 'ok') return <span className="chip ok"><span className="d" />就绪</span>;
  if (status === 'warn') return <span className="chip warn"><span className="d" />可选 · 未配置</span>;
  return <span className="chip fail"><span className="d" />缺失</span>;
}

export function OnboardingScreen({
  onEnter,
  onSkip,
}: {
  onEnter: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setReport(null);
    try {
      const r = await window.duetlens.checkEnvironment({ deep: true });
      setReport(r);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const steps = toSteps(checking ? null : report);
  const ready = report != null && report.codex.status === 'ok' && report.appServer.status === 'ok';

  const copy = async (cmd: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(cmd);
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1400);
    } catch {
      // 剪贴板不可用(无焦点等):静默,用户可手动复制
    }
  };

  const hint = checking
    ? '正在检测环境…'
    : !ready
      ? '需要 codex 就绪才能开始;GitHub 登录可稍后再配。'
      : report?.gh.status !== 'ok'
        ? '已就绪。gh 未登录只影响 GitHub 来源,可稍后再登。'
        : '全部就绪,开始你的第一次审核。';

  return (
    <div className="onboarding">
      <header className="ob-topbar">
        <Wordmark />
        <span className="ob-spacer" />
        <ThemeControls />
      </header>

      <div className="ob-stage">
        <div className="ob-card">
          <div className="ob-hero">
            <Wordmark className="ob-mk" />
            <div className="tag">人 + agent 协同式 code review</div>
            <div className="sub mono">首次启动 · 环境检查</div>
          </div>

          <div className="ob-checks">
            {steps.map((s) => (
              <div className="ob-step" key={s.key}>
                <div className="srow">
                  <div className="ico mono">{s.ico}</div>
                  <div className="smeta">
                    <div className="nm">
                      {s.name}
                      {s.optional && <span className="opt mono">可选</span>}
                    </div>
                    <div className="ds">{s.desc}</div>
                    <div className="ds detail">{s.detail}</div>
                  </div>
                  <Chip status={s.status} />
                </div>
                {s.fix && (s.status === 'fail' || s.status === 'warn') && (
                  <div className={`ob-fix ${s.fix.tone}`}>
                    <div className="ft">{s.fix.lead}</div>
                    <div className="cmd">
                      <span className="p mono">$</span>
                      <code className="mono">{s.fix.cmd}</code>
                      <button
                        className={`copy${copied === s.fix.cmd ? ' done' : ''}`}
                        onClick={() => void copy(s.fix!.cmd)}
                      >
                        {copied === s.fix.cmd ? '已复制 ✓' : '复制'}
                      </button>
                    </div>
                    <div className="acts">
                      <button className="lbtn" onClick={() => void check()} disabled={checking}>
                        ↻ 重新检测
                      </button>
                      <a className="lnk" href={s.fix.docHref} target="_blank" rel="noreferrer">
                        {s.fix.docLabel} ↗
                      </a>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="ob-foot">
            <button className="ob-cta" disabled={!ready} onClick={onEnter}>
              进入 Duetlens →
            </button>
            <div className="hint">{hint}</div>
            <button className="later" onClick={onSkip}>
              跳过,稍后在设置中配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
