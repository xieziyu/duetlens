import type { Finding, Severity } from '@shared/domain';

const SEV_LABEL: Record<Severity, string> = { high: 'High', medium: 'Med', low: 'Low' };

type StepState = 'done' | 'active' | 'pending';
interface Step {
  label: string;
  state: StepState;
  meta?: string;
}

export interface ScanTimelineProps {
  findings: Finding[];
  /** diff 已预取落库(渲染期通常已就绪) */
  diffReady: boolean;
  /** codex 会话已起、turn 在跑(有 token 用量 / 工具调用 / 已产出 finding) */
  sessionReady: boolean;
  onPickFinding: (f: Finding) => void;
}

/**
 * 首轮机审进度:阶段 timeline + 实时 findings 流。
 * 阶段态由现有信号派生(diff 预取 / 会话就绪 / findings 数),不臆造后端没有的粒度。
 */
export function ScanTimeline({ findings, diffReady, sessionReady, onPickFinding }: ScanTimelineProps) {
  const steps: Step[] = [
    { label: '拉取 diff 与源码树', state: diffReady ? 'done' : 'active' },
    {
      label: '注入 per-thread MCP · 建立会话',
      state: sessionReady ? 'done' : diffReady ? 'active' : 'pending',
    },
    {
      label: '通读改动,上报 findings',
      state: sessionReady ? 'active' : 'pending',
      meta: `${findings.length} findings`,
    },
    { label: '就绪 · 可自由追问 / 框选提问', state: 'pending' },
  ];

  return (
    <div className="scanview">
      <div className="scan-head">
        <span className="sglyph" />
        <div className="sh-t">
          <b>首轮机审</b>
          <span className="sh-s">agent 正在通读改动</span>
        </div>
      </div>

      <div className="timeline">
        {steps.map((s, i) => (
          <div key={i} className={`tl ${s.state}`}>
            <span className="dot" />
            <span className="tl-l">{s.label}</span>
            {s.meta && <span className="tl-t">{s.meta}</span>}
          </div>
        ))}
      </div>

      <div className="scan-stream">
        <div className="ss-head">
          实时 findings <span className="ss-n">{findings.length}</span>
          <span className="typing">
            <i />
            <i />
            <i />
          </span>
        </div>
        {findings.length === 0 ? (
          <p className="ss-empty">还没有 findings —— agent 通读中,发现即刻出现。</p>
        ) : (
          findings.map((f) => (
            <div key={f.id} className="sfind" onClick={() => onPickFinding(f)}>
              <span className={`sev sev-${f.severity}`}>
                {SEV_LABEL[f.severity]}
                {f.category ? ` · ${f.category}` : ''}
              </span>
              <div className="m">
                <div className="ft">{f.title}</div>
                <div className="fp">
                  {f.file}:{f.line}
                </div>
              </div>
              <span className="go">→</span>
            </div>
          ))
        )}
      </div>

      <div className="scan-foot">
        <span className="ic">◆</span> 扫描会跑一会儿 —— 期间可点开任一 finding,或在左侧框选代码直接向 agent
        提问,无需等待机审结束。
      </div>
    </div>
  );
}
