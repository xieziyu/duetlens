import { useEffect, useRef, useState } from 'react';
import type { ReviewStartStage } from '@shared/ipc';
import './StartOverlay.css';

/**
 * 发起审核后的等待浮层:期间禁止其他操作。
 *
 * 阶段来自后端真实回调(不是定时器编的),大 PR 卡住的那一档(拉 diff)会自己报时并给出等待预期;
 * 失败原地转错误态,让用户带着上下文改参数重试,而不是把人扔回一片空白的表单。
 */

const STEPS: { stage: ReviewStartStage; label: string; slow: string }[] = [
  { stage: 'resolve', label: '连接来源 · 读取目标元信息', slow: '正在解析仓库与目标引用' },
  { stage: 'diff', label: '拉取本次改动的 diff', slow: '改动量大时 diff 要下载十几秒,这是正常的' },
  { stage: 'record', label: '解析 diff · 建立审核记录', slow: '正在切分文件与 hunk' },
  { stage: 'agent', label: '装配审核规则 · 启动 agent 会话', slow: '正在拉起 codex 会话' },
];

/** 扫描动画里的代码行:宽度与 diff 属性只为画面节奏,不代表真实改动 */
const ART_ROWS: { w: number; kind?: 'add' | 'del' }[] = [
  { w: 72 },
  { w: 54, kind: 'add' },
  { w: 88 },
  { w: 46, kind: 'del' },
  { w: 66, kind: 'add' },
];

export function StartOverlay({
  stage,
  target,
  error,
  onRetry,
  onBack,
}: {
  stage: ReviewStartStage;
  /** 正在准备的目标(PR / 分支名),让用户确认自己等的是对的东西 */
  target: string;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const activeIndex = STEPS.findIndex((s) => s.stage === stage);
  const elapsed = useStageElapsed(stage, !!error);

  useEffect(() => {
    panelRef.current?.focus();
  }, [error]);

  // 运行中吞掉 Esc(此时没有可取消的动作);错误态下 Esc = 返回修改
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (error) onBack();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [error, onBack]);

  const lit = error ? 0 : Math.min(ART_ROWS.length, activeIndex + 1);

  return (
    <div className="start-veil" role="dialog" aria-modal="true" aria-busy={!error} aria-label="正在准备审核">
      <div className="start-panel" ref={panelRef} tabIndex={-1}>
        <div className={error ? 'start-art failed' : 'start-art'} aria-hidden="true">
          <div className="art-rows">
            {ART_ROWS.map((r, i) => (
              <span
                key={i}
                className={`art-row${r.kind ? ` ${r.kind}` : ''}${i < lit ? ' lit' : ''}`}
                style={{ width: `${r.w}%` }}
              />
            ))}
          </div>
          <div className="art-sweep">
            <div className="art-rows">
              {ART_ROWS.map((r, i) => (
                <span
                  key={i}
                  className={`art-row${r.kind ? ` ${r.kind}` : ''}`}
                  style={{ width: `${r.w}%` }}
                />
              ))}
            </div>
          </div>
          <div className="art-track">
            <span className="art-lens" />
          </div>
        </div>

        <div className="start-head">
          <h2>{error ? '没能启动这次审核' : '正在准备这次审核'}</h2>
          <div className="start-target mono" title={target}>
            {target}
          </div>
        </div>

        {error ? (
          <>
            <p className="start-err mono">{error}</p>
            <div className="start-actions">
              <button type="button" className="sbtn" onClick={onBack}>
                返回修改
              </button>
              <button type="button" className="sbtn primary" onClick={onRetry}>
                重试
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="start-steps">
              {STEPS.map((s, i) => {
                const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
                return (
                  <li key={s.stage} className={state}>
                    <span className="sdot" />
                    <span className="slabel">{s.label}</span>
                    {state === 'active' && elapsed >= 1.5 && (
                      <span className="stime mono">{elapsed.toFixed(0)}s</span>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className={elapsed >= 6 ? 'start-hint slow' : 'start-hint'}>
              {elapsed >= 6 ? STEPS[activeIndex]?.slow : '进入后首轮机审继续在后台跑,不用等它结束'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** 当前阶段已耗时(秒)。阶段一变就归零 —— 报的是「这一步卡了多久」,不是总时长。 */
function useStageElapsed(stage: ReviewStartStage, stopped: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (stopped) return;
    setElapsed(0);
    const from = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - from) / 1000), 250);
    return () => window.clearInterval(id);
  }, [stage, stopped]);
  return elapsed;
}
