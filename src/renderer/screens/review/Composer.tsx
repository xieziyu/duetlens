import { useState } from 'react';
import { useDraftFlag } from './useDraftFlag';

/** 一条没发出去的原文;每次失败各占一条,不互相顶掉,由用户决定何时放回输入框。 */
export interface UnsentDraft {
  id: number;
  text: string;
  reason: string;
  /**
   * 这句话本来问的是哪条讨论。必须随原文一起记:发送是异步的,失败回来时活跃线程
   * 可能早换了人,只按「当前线程」重发会把追问投进另一条线程,锚点与上下文全错。
   * null = 当时连线程都还没建出来。
   */
  discussionId: string | null;
}

/**
 * Discussion 栏底部输入区:textarea + 发送。追问活跃 discussion;
 * 无活跃线程时由调用方接成「新开一条无锚点的全局讨论」。
 */
export interface ComposerProps {
  disabled: boolean;
  placeholder: string;
  /** 底部作用域说明(全局会话 · 已锚定 … · read-only sandbox) */
  scope: string;
  /**
   * 发送;不会抛。失败原文由调用方连同目标线程一起收进待恢复列表 —— 只有它知道这一句
   * 最终发给了哪条讨论(空态下的第一句还会顺手建线程),见 ReviewScreen.onComposerSend。
   */
  onSend: (text: string) => void | Promise<void>;
  /** 待恢复的原文;由屏持有,故框选发起失败的首问也能落到同一处 */
  unsent: UnsentDraft[];
  /** 一条待恢复原文的去向说明(切线程 / 原线程已不在);null = 就在当前线程,无需多说 */
  targetNote: (d: UnsentDraft) => string | null;
  onRestore: (d: UnsentDraft) => void;
  /** 框里有没有还没发出去的字;纯空白不算。关 tab 前的拦截据此判断,故只报布尔量 */
  onDraftChange?: (hasDraft: boolean) => void;
}

export function Composer({
  disabled,
  placeholder,
  scope,
  onSend,
  unsent,
  targetNote,
  onRestore,
  onDraftChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  useDraftFlag(text.trim().length > 0, onDraftChange);

  // 先清空是因为发送可能挂着一整轮 turn(几十秒起步),不能一直锁着输入框;等待期间还能接着打下一句。
  // 因此失败时不能直接往框里塞:那句话可能早被新内容占着,多条同时失败更会互相覆盖 ——
  // 一律转成待恢复的一条,谁都不会凭空消失,放回来的时机交给用户。
  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    setText('');
    void Promise.resolve(onSend(v)).catch(() => undefined);
  };

  /** 把待恢复的原文放回输入框;框里已有内容就接在后面,不覆盖。切回原线程由调用方负责。 */
  const restore = (d: UnsentDraft) => {
    setText((cur) => (cur ? `${cur}\n\n${d.text}` : d.text));
    onRestore(d);
  };

  return (
    <div className="composer">
      {unsent.map((d) => {
        const note = targetNote(d);
        return (
          <div key={d.id} className="cs-unsent">
            <div className="cu-head">
              <span className="cu-why">✕ 没能发出:{d.reason}</span>
              <button className="cu-restore" onClick={() => restore(d)}>
                ↩ 放回输入框
              </button>
            </div>
            {note && <div className="cu-to">{note}</div>}
            <div className="cu-text">{d.text}</div>
          </div>
        );
      })}
      <div className="box">
        <textarea
          className="composer-input"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter 发送,裸 Enter 换行,避免多行追问时误发
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="bar">
          <button className="send" onClick={submit} disabled={disabled || !text.trim()}>
            发送 ⌘↵
          </button>
        </div>
      </div>
      <div className="scope">{scope}</div>
    </div>
  );
}
