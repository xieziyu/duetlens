import { useEffect, useRef, useState } from 'react';

/**
 * diff 主区锚点处的内联新建 discussion 卡(对齐 mockup .card.new-disc):
 * 引用块 + textarea + 发送/取消。发送即创建一条 user discussion 并向 codex 发出首问,
 * 随后由 Discussion 栏承载后续对话(见 ReviewScreen.onStartDiscussion)。
 */
export interface InlineComposerProps {
  label: string;
  snippet: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function InlineComposer({ label, snippet, onSend, onCancel }: InlineComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const v = text.trim();
    if (v) onSend(v);
  };

  return (
    <div className="inline">
      <div className="card human new-disc stagger">
        <div className="nd-head">
          <span className="av human">你</span> 新建 discussion
          <span className="tool-tag">框选 {label}</span>
        </div>
        <div className="nd-ref">
          <span className="lnref">{label}</span> · {snippet}
        </div>
        <div className="nd-body">
          <textarea
            ref={ref}
            className="fe-textarea"
            placeholder="描述你的疑问,codex 会在此讨论里回应…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </div>
        <div className="nd-foot">
          <button className="send" onClick={submit} disabled={!text.trim()}>
            发送 ↵
          </button>
          <button className="cancel" onClick={onCancel}>
            取消
          </button>
          <span className="fe-note">发送后成为一条你发起的 discussion</span>
        </div>
      </div>
    </div>
  );
}
