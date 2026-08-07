import { useEffect, useState } from 'react';
import type { ReviewStartStage } from '@shared/ipc';
import './StartProgress.css';

/**
 * 起一轮机审的阶段进度条:首次发起(入口浮层)与重跑(重跑面板)共用同一套视觉与计时。
 *
 * 阶段来自后端真实回调(不是定时器编的);卡在某一档超过 6s 就把该档的等待预期讲出来,
 * 让「大 PR 拉 diff 要十几秒」看起来是正常的,而不是像卡死。
 * 只画进度本身,扫描动画与外框由宿主拼(两处的头部信息不一样)。
 */

export interface StartStep {
  stage: ReviewStartStage;
  label: string;
  /** 该档滞留过久时的等待预期 */
  slow: string;
}

/** 一次性发起 id:阶段事件按它回关,过期的发起不会再往当前等待画面里灌。 */
export function newStartId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 当前阶段在步骤表中的序号(未知阶段按第一档),宿主据此点亮扫描动画的行数。 */
export function stepIndex(steps: StartStep[], stage: ReviewStartStage): number {
  const i = steps.findIndex((s) => s.stage === stage);
  return i < 0 ? 0 : i;
}

export function StartSteps({
  steps,
  stage,
  /** 未进入慢档时的常态提示 */
  hint,
}: {
  steps: StartStep[];
  stage: ReviewStartStage;
  hint: string;
}) {
  const activeIndex = stepIndex(steps, stage);
  const elapsed = useStageElapsed(stage);

  return (
    <>
      <ol className="start-steps">
        {steps.map((s, i) => {
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
        {elapsed >= 6 ? steps[activeIndex]?.slow : hint}
      </p>
    </>
  );
}

/** 当前阶段已耗时(秒)。阶段一变就归零 —— 报的是「这一步卡了多久」,不是总时长。 */
function useStageElapsed(stage: ReviewStartStage): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const from = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - from) / 1000), 250);
    return () => window.clearInterval(id);
  }, [stage]);
  return elapsed;
}
