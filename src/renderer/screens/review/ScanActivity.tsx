import { useEffect, useState } from 'react';
import { activityVerb, currentActivity, type Activity, type ActivityKind } from './scan-activity';

/**
 * 机审期的「agent 在做什么」两件展示件:常驻的一行实时播报、可回看的动作流。
 * 三处宿主(进度条横条 / 进度条展开区 / 右栏扫描空态)共用,只由 {@link Activity} 驱动。
 */

/** 动作图标:与动作流、实时行共用,免得同一件事在两处长得不一样 */
const GLYPH: Record<ActivityKind, string> = {
  read: '‹›',
  search: '⌕',
  list: '☰',
  diff: '±',
  finding: '◆',
  web: '⌘',
  shell: '$',
  tool: '⚙',
  note: '·',
};

/**
 * 超过这个静默时长就改口说「思考中」。
 * 取值依据:实测工具调用间隔 p90 约 14s —— 低于它会把正常节奏误报成卡住。
 */
const THINKING_AFTER_MS = 20_000;

/** 深目录仓库里尾巴(文件名)才是信息,所以掐头保尾。 */
function trimHead(text: string, keep: number): string {
  return text.length <= keep ? text : `…${text.slice(-keep)}`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** 从某时刻起的已耗时;时刻一变就重算 —— 报的是「这一步跑了多久」,不是总时长。 */
function useElapsed(since: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (since == null) return;
    setElapsed(Date.now() - since);
    const id = window.setInterval(() => setElapsed(Date.now() - since), 500);
    return () => window.clearInterval(id);
  }, [since]);
  return elapsed;
}

export interface ScanCoverage {
  /** 已被 agent 取证的改动文件数 */
  covered: number;
  /** 本次改动的文件总数 */
  total: number;
}

const COVERAGE_TITLE =
  '本次改动的文件里,agent 已经读过(读到原文或被检索命中)的比例。' +
  '这是覆盖面不是完成度 —— 它跑满也不代表扫描结束,agent 还会读改动之外的上下文。';

function Coverage({ covered, total }: ScanCoverage) {
  const pct = total > 0 ? Math.min(100, Math.round((covered / total) * 100)) : 0;
  return (
    <span className="sb-cover" title={COVERAGE_TITLE}>
      <span className="cv-bar">
        <span className="cv-fill" style={{ width: `${pct}%` }} />
      </span>
      <b>
        {covered}/{total}
      </b>
      {' 改动文件已读'}
    </span>
  );
}

/**
 * 进度条第二行:一句话说清 agent 此刻在干什么 + 这一步跑了多久 + 覆盖面。
 *
 * 「这一步跑了多久」不是装饰:实测每轮机审的最长静默中位 30s、p90 167s,
 * 没有这个数,静默期与卡死在界面上长得一模一样。
 */
export function ScanLiveRow({
  activity,
  coverage,
}: {
  activity: Activity[];
  coverage: ScanCoverage | null;
}) {
  const now = currentActivity(activity);
  // 在跑就从开始算,收尾了就从收尾那刻算 —— 报的是「空转了多久」,
  // 沿用开始时刻会把一条跑了 30s 的命令在刚结束时显示成「思考中 00:30」
  const elapsed = useElapsed((now?.done ? (now.endedAt ?? now.at) : now?.at) ?? null);
  // 「动作已收尾」与「这一步跑得久」是两回事,别合并:前者才是 agent 在两步之间自己想,
  // 后者只是这次调用本身慢(大文件、超时重试)—— 把在跑的动作说成「思考中」就是报假状态。
  const thinking = !!now?.done;
  const slow = elapsed >= THINKING_AFTER_MS;

  if (!now) return null;
  return (
    <div className={`sb-live${thinking || slow ? ' stale' : ''}`}>
      <span className={`lv-ic k-${now.kind}${thinking ? ' k-idle' : ''}`}>
        {thinking ? '⋯' : GLYPH[now.kind]}
      </span>
      <span className="lv-verb">
        {thinking ? `思考中,上一步是${activityVerb(now.kind)}` : activityVerb(now.kind)}
      </span>
      <span className="lv-obj" title={now.text}>
        {trimHead(now.text, 96)}
        {now.count > 1 && <em>{`  ×${now.count}`}</em>}
      </span>
      <span className="lv-el">{clock(elapsed)}</span>
      {coverage && coverage.total > 0 && <Coverage {...coverage} />}
    </div>
  );
}

/**
 * 动作流:**最新一条在最上**。
 *
 * 正序更像叙事,但它要求容器一直跟着滚到底,而这两处宿主(可收起的进度条展开区、
 * 可能不在前台的右栏)都会处于隐藏态 —— 隐藏容器的几何量是 0、scroll 也不派发,
 * 自动跟随会**静默失效**,恰好在事后展开来看时最不该失效。倒序没有这个失败模式:
 * 要回答的「它此刻在做什么」永远在固定位置,零交互可见。
 */
export function ScanActivityFeed({
  activity,
  /** 起轮时刻;每条动作的时标相对它算,给出「第几分钟做的」 */
  since,
  /** 只留最近几条(紧凑位用);缺省给全 */
  limit,
  className,
}: {
  activity: Activity[];
  since: number | null;
  limit?: number;
  className?: string;
}) {
  // 先取最新的 limit 条,再整体倒过来 —— 反过来做会截成最老的那几条
  const shown = (limit ? activity.slice(-limit) : activity).slice().reverse();
  const live = currentActivity(activity);
  return (
    <div className={`ff-list${className ? ` ${className}` : ''}`}>
      {shown.map((a, i) => (
        <div key={`${a.at}-${i}`} className={`ff-row k-${a.kind}${a === live && !a.done ? ' now' : ''}`}>
          <span className="ff-t">{since == null ? '' : clock(a.at - since)}</span>
          <span className="ff-ic">{GLYPH[a.kind]}</span>
          <span className="ff-x" title={`${activityVerb(a.kind)} ${a.text}`}>
            <em>{activityVerb(a.kind)} </em>
            {trimHead(a.text, 72)}
          </span>
          {a.count > 1 && <span className="ff-n">{`×${a.count}`}</span>}
          <span className="ff-d">{a.durationMs != null ? secs(a.durationMs) : ''}</span>
        </div>
      ))}
    </div>
  );
}
