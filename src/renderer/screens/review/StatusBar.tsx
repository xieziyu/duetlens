import type { ReviewStatus } from '@shared/domain';
import type { TokenUsage } from '@shared/agent-events';

const STATUS_LABEL: Record<ReviewStatus, string> = {
  scanning: '扫描中',
  reviewing: '审核中',
  completed: '已完成',
  submitted: '已提交',
  failed: '失败',
};

/**
 * review 屏底部状态栏:agent 运行态从顶栏下沉到此,顶栏只留导航与上下文。
 * diff 视图切换与通读进度归中栏列头(.diff-bar),此处不再重复。
 */
function agentTitle(model: string | null, effort: string | null): string {
  const parts = ['审阅 agent:codex', `模型 ${model ?? '账号默认'}`];
  if (effort) parts.push(`reasoning effort ${effort}`);
  return parts.join(' · ');
}

/** 状态栏空间有限,只给量级;精确值留在 title 里 */
function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  const [value, unit] = n < 1_000_000 ? [n / 1000, 'K'] : [n / 1_000_000, 'M'];
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text}${unit}`;
}

function contextTitle({ used, cumulative, total }: TokenUsage): string {
  const ctx = total
    ? `上下文 ${used.toLocaleString()} / ${total.toLocaleString()}(codex 上报的有效窗口,已按模型折算)`
    : `上下文 ${used.toLocaleString()}`;
  return `${ctx} · 本次会话累计 ${cumulative.toLocaleString()} tokens`;
}

export function ReviewStatusBar({
  status,
  round,
  model,
  effort,
  tokenUsage,
  lastTool,
  failureHint,
  onShowFailure,
  onOpenHelp,
}: {
  status: ReviewStatus | null;
  /** 多轮复审时的轮次摘要(如「第 2 轮 · 修复 3 · 新增 1」);单轮为 null */
  round: string | null;
  model: string | null;
  effort: string | null;
  tokenUsage: TokenUsage | null;
  lastTool: string | null;
  /** 失败结论一句话;这枚胶囊只是指路牌,完整原因在进度条的失败卡里 */
  failureHint: string | null;
  onShowFailure: () => void;
  onOpenHelp: () => void;
}): React.JSX.Element {
  const st = status ?? 'scanning';
  const running = st === 'scanning' || st === 'reviewing';
  const pct = tokenUsage?.total
    ? Math.min(100, Math.round((tokenUsage.used / tokenUsage.total) * 100))
    : null;

  return (
    <footer className="rev-statusbar">
      {failureHint ? (
        <button
          className={`sb-status s-${st} act`}
          onClick={onShowFailure}
          title={`${failureHint} — 点击查看原因与重试`}
        >
          {STATUS_LABEL[st]}
          <span className="sb-why">查看原因</span>
        </button>
      ) : (
        <span className={`sb-status s-${st}`}>
          {running && <span className="pulse" />}
          {STATUS_LABEL[st]}
        </span>
      )}
      {round && (
        <span className="sb-item sb-round" title="复审轮次与本轮统计">
          ↻ {round}
        </span>
      )}
      <span className="sb-item sb-agent" title={agentTitle(model, effort)}>
        <span className="glyph" />
        codex
        <span className="sb-model mono">{model ?? '默认模型'}</span>
        {effort && <span className="sb-effort mono">{effort}</span>}
      </span>
      {tokenUsage && (
        <>
          <span className="sb-sep" />
          <span className="sb-item" title={contextTitle(tokenUsage)}>
            {pct !== null && (
              <svg className="ring" viewBox="0 0 18 18" style={{ ['--ctx' as string]: (pct / 100).toString() }}>
                <circle className="bg" cx="9" cy="9" r="7" />
                <circle className="fg" cx="9" cy="9" r="7" />
              </svg>
            )}
            {/* 分母要露面:只给「63K · 24%」时,占比看着不对也没法就地核对窗口有多大 */}
            <span className="mono">
              {compactTokens(tokenUsage.used)}
              {tokenUsage.total ? ` / ${compactTokens(tokenUsage.total)}` : ''}
              {pct !== null ? ` · ${pct}%` : ''}
            </span>
          </span>
        </>
      )}
      {lastTool && (
        <span className="sb-item mono sb-tool" title={`最近工具调用:${lastTool}`}>
          ⚙ {lastTool}
        </span>
      )}

      <span className="sb-spacer" />

      <button className="sb-item act" onClick={onOpenHelp} title="键盘快捷键 (?)">
        ⌘ 快捷键
      </button>
    </footer>
  );
}
