import { useCallback, useEffect, useState } from 'react';
import { anyAgentReady, codexReady, piReady, type EnvironmentReport } from '@shared/environment';
import { Wordmark } from '../components/Wordmark';
import { LogoMark } from '../components/LogoMark';
import { ThemeControls } from '../components/ThemeControls';
import './OnboardingScreen.css';

// 首启环境自检屏。
// 审核 agent 两家(codex / pi)有一家就绪就放行;gh 可选(仅 GitHub 来源需要),缺失只提示不拦。

type StepStatus = 'checking' | 'ok' | 'fail' | 'warn' | 'wait';

interface StepView {
  key: 'codex' | 'app' | 'pi' | 'gh';
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

const CODEX_DESC = '审核 agent 之一;Duetlens 通过它的 app-server 常驻会话驱动机审,走 codex 账号。';
const APP_DESC = '与 codex 建立常驻 JSON-RPC 会话;由 Duetlens 自动拉起,无需手动命令。';
const PI_DESC = '审核 agent 之一;走 pi 里配好的 provider(订阅登录或 API key),与 codex 二选一即可。';
const GH_DESC = '仅 GitHub PR 来源与提交 review 需要;本地分支 / GitButler 来源无需登录。';
const PI_DOC = 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent';

/**
 * 后端自检报告 → 展示态。两家 agent 互为备选:另一家已就绪时,这一家缺失只算「可选 · 未配置」,
 * 不该用红色把人吓住;两家都不行才是真的缺。
 */
function toSteps(report: EnvironmentReport | null): StepView[] {
  if (!report) {
    const pending = (key: StepView['key'], ico: string, name: string, optional: boolean, desc: string): StepView => ({
      key, ico, name, optional, desc, status: 'checking', detail: '正在检测…', fix: null,
    });
    return [
      pending('codex', '◆', 'codex CLI', false, CODEX_DESC),
      pending('app', '⇄', 'app-server 连通', false, APP_DESC),
      pending('pi', 'π', 'pi CLI', false, PI_DESC),
      pending('gh', '⑂', 'GitHub CLI', true, GH_DESC),
    ];
  }
  const codexOk = report.codex.status === 'ok';
  const codexUsable = codexReady(report);
  const piUsable = piReady(report);
  const missingTone = (otherReady: boolean): 'fail' | 'warn' => (otherReady ? 'warn' : 'fail');
  const appStatus: StepStatus = !codexOk
    ? 'wait'
    : report.appServer.status === 'ok'
      ? 'ok'
      : missingTone(piUsable);
  const piInstalled = report.pi.status === 'ok';
  const piStatus: StepStatus = piUsable ? 'ok' : missingTone(codexUsable);
  return [
    {
      key: 'codex',
      ico: '◆',
      name: 'codex CLI',
      optional: false,
      desc: CODEX_DESC,
      status: codexOk ? 'ok' : missingTone(piUsable),
      detail: codexOk ? `已安装 · ${report.codex.version}` : '未检测到',
      fix: codexOk
        ? null
        : {
            tone: missingTone(piUsable),
            lead: piUsable
              ? '没有找到 codex。pi 已就绪,不装也能开始;想用 codex 审时再装:'
              : '在 PATH 中没有找到 codex。安装后点「重新检测」:',
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
      key: 'pi',
      ico: 'π',
      name: 'pi CLI',
      optional: false,
      desc: PI_DESC,
      status: piStatus,
      detail: piUsable
        ? `已安装 · ${report.pi.version} · 可用 ${report.pi.models} 个模型`
        : piInstalled
          ? `已安装 · ${report.pi.version} · ${report.pi.error ?? '没有配好凭证的 provider'}`
          : '未检测到',
      fix: piUsable
        ? null
        : piInstalled
          ? {
              tone: missingTone(codexUsable),
              lead: 'pi 装好了,但还没有能用的 provider。在终端运行 pi,输入 /login 登录订阅或录入 API key:',
              cmd: 'pi',
              docLabel: 'pi provider 配置文档',
              docHref: `${PI_DOC}/docs/providers.md`,
            }
          : {
              tone: missingTone(codexUsable),
              lead: codexUsable
                ? '没有找到 pi。codex 已就绪,不装也能开始;想用 pi 审时再装:'
                : '在 PATH 中没有找到 pi。安装后点「重新检测」:',
              cmd: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
              docLabel: 'pi 安装文档',
              docHref: `${PI_DOC}/docs/quickstart.md`,
            },
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
  const ready = report != null && anyAgentReady(report);

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
      ? '需要 codex 或 pi 有一个就绪才能开始;GitHub 登录可稍后再配。'
      : !codexReady(report) || !piReady(report)
        ? `已就绪。${codexReady(report) ? 'pi' : 'codex'} 未配置,不影响用另一家审核,需要时再装。`
        : report.gh.status !== 'ok'
        ? '已就绪。gh 未登录只影响 GitHub 来源,可稍后再登。'
        : '全部就绪,开始你的第一次审核。';

  return (
    <div className="onboarding">
      <header className="ob-topbar">
        <span className="brand">
          <LogoMark size={20} />
          <Wordmark />
        </span>
        <span className="ob-spacer" />
        <ThemeControls />
      </header>

      <div className="ob-stage">
        <div className="ob-card">
          <div className="ob-hero">
            <LogoMark size={72} className="ob-logo" />
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
