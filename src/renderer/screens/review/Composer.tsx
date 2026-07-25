import { useState } from 'react';

/**
 * Discussion 栏底部输入区:textarea + 发送,只用于追问活跃 discussion。
 * 新讨论一律从中栏就地发起(锚定模型下必须先有锚点)。
 */
export interface ComposerProps {
  /** 无活跃 discussion 时禁用 */
  disabled: boolean;
  placeholder: string;
  /** 底部作用域说明(全局会话 · 已锚定 … · read-only sandbox) */
  scope: string;
  onSend: (text: string) => void;
}

export function Composer({ disabled, placeholder, scope, onSend }: ComposerProps) {
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
        <textarea
          className="composer-input"
          placeholder={disabled ? '框选左侧代码或点 finding,开始讨论…' : placeholder}
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
