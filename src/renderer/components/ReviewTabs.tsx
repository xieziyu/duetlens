import { REVIEW_STATUS_LABELS } from '@shared/domain';
import type { ReviewTab } from '../review/tabs';
import type { TabMeta } from '../review/useTabMeta';
import { shortSourceLabel } from '../review/source-ref';
import { SourceIcon } from './SourceIcon';
import './ReviewTabs.css';

/** tab 条右侧的一句轻提示;由 App 决定何时出、何时消失。 */
export interface TabNotice {
  text: string;
  /** 可选的一步回头路(如把刚关掉的那枚重新打开) */
  action?: { label: string; onRun: () => void };
  /**
   * 不自动消失。给「就地确认」用 —— 那种提示的动作是**用户还没做的决定**,
   * 定时收走等于替他选了「不关」,而他可能只是想了几秒。
   */
  sticky?: boolean;
}

/**
 * 打开着的 review。**tab 只是视图的把手** —— 关掉一枚不动后端会话,那条审核继续在后台跑
 * (会话按 reviewId 存活于 main,见 ReviewManager)。所以关闭按钮不需要「确定要中止吗」这类确认。
 *
 * 状态点只给「扫描中」与「失败」两档:其余状态在 tab 这个尺寸上给不出新信息,
 * 每枚都挂个点只会让真正在跑的那一枚淹掉。
 */
export function ReviewTabs({
  tabs,
  activeId,
  meta,
  notice,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: readonly ReviewTab[];
  activeId: string | null;
  meta: Record<string, TabMeta>;
  notice: TabNotice | null;
  onActivate: (reviewId: string) => void;
  onClose: (reviewId: string) => void;
  /** ＋:回入口发起新审核(不直接建 tab —— 没有 review 就没有 tab) */
  onNew: () => void;
}): React.JSX.Element {
  return (
    <div className="rev-tabs" role="tablist" aria-label="打开的审核">
      <div className="tabs-strip">
        {tabs.map((t) => {
          const m = meta[t.reviewId];
          const label = m ? shortSourceLabel(m.source, m.sourceRef) : '…';
          // 本地分支的 title 就是 ref 本身,两个都画等于把同一句话说两遍、还挤掉了别的 tab
          const title = m && m.title !== label ? m.title : '';
          const on = t.reviewId === activeId;
          const dot = m?.status === 'scanning' ? 'scanning' : m?.status === 'failed' ? 'failed' : null;
          // 未读数与状态点二选一:210px 的 tab 上两样都画就谁也读不清。
          // 状态本身不会因此丢失 —— title 里一直带着它。
          const unread = !on && m ? m.unread : 0;
          return (
            <div key={t.reviewId} className={`rev-tab${on ? ' on' : ''}`}>
              <button
                className="tab-main"
                role="tab"
                aria-selected={on}
                title={[
                  label,
                  title,
                  m ? REVIEW_STATUS_LABELS[m.status ?? 'scanning'] : null,
                  unread > 0 ? `新增 ${unread} 条 finding` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => onActivate(t.reviewId)}
                onAuxClick={(e) => e.button === 1 && onClose(t.reviewId)}
              >
                <SourceIcon source={m?.source} />
                <span className="mono lbl">{label}</span>
                {title && <span className="ttl">{title}</span>}
                {unread > 0 ? (
                  <span className="tab-badge" title={`后台新报出 ${unread} 条 finding`}>
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : (
                  dot && <span className={`tab-dot ${dot}`} aria-hidden />
                )}
              </button>
              <button
                className="tab-close"
                onClick={() => onClose(t.reviewId)}
                title="关闭这枚 tab(审核不受影响)"
                aria-label={`关闭 ${label}`}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      <button className="tab-add" onClick={onNew} title="发起新审核">
        <PlusIcon />
      </button>
      {notice && (
        <span className="tab-notice">
          {notice.text}
          {notice.action && (
            <button onClick={notice.action.onRun}>{notice.action.label}</button>
          )}
        </span>
      )}
    </div>
  );
}

const CloseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" />
  </svg>
);

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
