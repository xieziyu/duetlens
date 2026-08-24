import { LIVE_SESSION_LIMIT_CODE, type LiveCapacity } from '@shared/ipc';
import './CapacityNotice.css';

/** 停在满载提示上时的自查间隔:别人的会话跑完不会有事件推给等着的这一屏,只能自己回头问。 */
export const CAPACITY_POLL_MS = 5000;

/**
 * 满载 = 会话位坐满且**每一个都在跑**。有空闲位时后端会静默回收,用户不必知道这回事。
 * 快照缺失(容量接口失败)一律不算满载 —— 这块提示要有真实的在跑清单才有意义。
 */
export function isAtCapacity(c: LiveCapacity | null): boolean {
  return !!c && c.live >= c.max && c.busy.length >= c.max;
}

/** 满载是可预期的拦截,不是故障:识别串由后端嵌在 message 里(见 shared/ipc)。 */
export function isLiveSessionLimit(message: string): boolean {
  return message.includes(LIVE_SESSION_LIMIT_CODE);
}

/** 任何要把这条错误原文摆到界面上的地方,先把给程序看的那段码剥掉。 */
export function stripLimitCode(message: string): string {
  return message.replace(LIVE_SESSION_LIMIT_CODE, '').trim();
}

export interface CapacityNoticeProps {
  capacity: LiveCapacity;
  /**
   * 这次被挡下的是什么。会话位是同一件事,但发起新审核 / 追问 / 重跑被挡下时
   * 用户手上停着的东西不同,只有这半句随调用方走。
   */
  blocked?: string;
  /** 直达在跑的那条 review;不给 = 渲染成不可点的纯文本(调用方没有这条通路) */
  onOpen?: (reviewId: string) => void;
  onRefresh: () => void;
  /** 给一个关掉的出口;常驻拦截(入口屏的发起门控)不该有,故可选 */
  onDismiss?: () => void;
  /** 悬浮呈现:review 屏是三栏满屏布局,没有能把它嵌进去的流式位置 */
  float?: boolean;
}

/**
 * 满载拦截:会话位坐满且全在跑机审 / 追问,再起一个就得拆掉别人跑到一半的那轮。
 * 逐条列出在跑的是谁并给直达入口 —— 只说「满了」等于让用户自己去猜该关掉哪个。
 * 有空闲位时后端静默回收,这块根本不出现。
 */
export function CapacityNotice({
  capacity,
  blocked = '暂时开不了新的',
  onOpen,
  onRefresh,
  onDismiss,
  float,
}: CapacityNoticeProps) {
  return (
    <div className={float ? 'cap-block cap-float' : 'cap-block'} role="status">
      <div className="cap-head">
        <span className="cap-ic">◔</span>
        <b>
          {capacity.max} 个审核会话都在跑,{blocked}
        </b>
        <button type="button" className="cap-refresh" onClick={onRefresh}>
          刷新
        </button>
        {onDismiss && (
          <button type="button" className="cap-x" onClick={onDismiss} aria-label="关闭">
            ✕
          </button>
        )}
      </div>
      <div className="cap-body">
        每个会话是一个常驻 codex 子进程;等其中一个跑完、或进去把它叫停,这里会自动放行。
      </div>
      <div className="cap-list">
        {capacity.busy.map((b) =>
          onOpen ? (
            <button key={b.reviewId} type="button" className="cap-item" onClick={() => onOpen(b.reviewId)}>
              <BusyRow busy={b} />
              <span className="ci-go">→</span>
            </button>
          ) : (
            <div key={b.reviewId} className="cap-item static">
              <BusyRow busy={b} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function BusyRow({ busy }: { busy: LiveCapacity['busy'][number] }) {
  return (
    <>
      <span className="pulse" />
      <span className="ci-title">{busy.title}</span>
      <span className="ci-meta mono">
        {busy.sourceRef}
        {busy.round > 1 ? ` · 第 ${busy.round} 轮` : ''} · {busy.scanning ? '机审中' : '回答中'}
      </span>
    </>
  );
}
