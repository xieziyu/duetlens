import { useState } from 'react';

/**
 * Discussion 栏底部输入区(对齐 mockup .composer):可移除的引用选区 chip + textarea + 发送。
 * 引用 chip 由框选「追问 codex」带入;发送把文本交回上层(追问活跃 discussion 或从锚点新建)。
 */
export interface ComposerProps {
  /** 引用选区 chip 文案(如 pipeline.ts:20);null 则不显示 */
  refLabel: string | null;
  onRemoveRef: () => void;
  /** 无活跃 discussion 且无引用时禁用(锚定模型下必须先有锚点) */
  disabled: boolean;
  placeholder: string;
  /** 底部作用域说明(全局会话 · 已锚定 … · read-only sandbox) */
  scope: string;
  onSend: (text: string) => void;
}

export function Composer({ refLabel, onRemoveRef, disabled, placeholder, scope, onSend }: ComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText('');
  };

  return (
    <div className="composer">
      <div className="box">
        {refLabel && (
          <div className="refchip">
            ↳ <span className="lnref">{refLabel}</span>
            <span className="x" title="移除引用" onClick={onRemoveRef}>
              ✕
            </span>
          </div>
        )}
        <textarea
          className="composer-input"
          placeholder={disabled ? '框选左侧代码或点 finding,开始讨论…' : placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="bar">
          <button className="send" onClick={submit} disabled={disabled || !text.trim()}>
            发送 ↵
          </button>
        </div>
      </div>
      <div className="scope">{scope}</div>
    </div>
  );
}
