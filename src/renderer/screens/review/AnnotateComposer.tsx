import { useEffect, useRef, useState } from 'react';
import type { Severity } from '@shared/domain';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };
const SEV_OPTIONS: Severity[] = ['high', 'medium', 'low'];
/** 升格时正文首行提为标题的长度上限;超长则整段留在说明里,标题由用户自己写。 */
const TITLE_MAX = 120;

/** 手动新增 finding 时用户填写的字段(锚点由 DiffPane 的选区提供,不在此)。 */
export interface NewFindingDraft {
  severity: Severity;
  category: string | null;
  title: string;
  body: string;
  suggestion: string | null;
}

export interface AnnotateComposerProps {
  label: string;
  snippet: string;
  /** 提问态发送:创建一条 user discussion 并向 codex 发出首问 */
  onSend: (text: string) => void;
  /** finding 态提交:经 review:add-finding 落库(origin=manual) */
  onCreate: (draft: NewFindingDraft) => void;
  onCancel: () => void;
}

/**
 * diff 锚点处的批注 composer:框选与行内 ＋ 共用的唯一入口。
 *
 * 一张卡两态,finding 是提问的**超集** —— 默认只有引用块 + 正文,打开「记为 finding」就地长出
 * severity / category / 标题 / suggestion,正文原地变成「说明」。升格是加法不是切换,已写的字不丢:
 * 开关来回切时正文与标题按首行分/合,与后端 promoteDiscussion(discussion → finding)是同一条语义。
 */
export function AnnotateComposer({ label, snippet, onSend, onCreate, onCancel }: AnnotateComposerProps) {
  const [up, setUp] = useState(false);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [category, setCategory] = useState('');
  const [hasSugg, setHasSugg] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // 挂载与每次升/降格后把光标放到该继续打字的那一栏(升格若已带出标题,光标留在说明)
  useEffect(() => {
    if (!up) {
      textRef.current?.focus();
      return;
    }
    (titleRef.current?.value ? textRef : titleRef).current?.focus();
  }, [up]);

  const toggleUp = () => {
    if (up) {
      // 降回提问:标题并回正文首行,一个字都不丢
      setText([title.trim(), text].filter(Boolean).join('\n'));
      setTitle('');
      setUp(false);
      return;
    }
    // 升格:正文首行提为标题(标题已有则尊重现值),余下留在说明
    const lines = text.split('\n');
    const head = lines[0].trim();
    if (!title.trim() && head && head.length <= TITLE_MAX) {
      setTitle(head);
      setText(lines.slice(1).join('\n').replace(/^\n+/, ''));
    }
    setUp(true);
  };

  const canSubmit = up ? !!title.trim() : !!text.trim();

  const submit = () => {
    if (!canSubmit) return;
    if (up) {
      onCreate({
        severity,
        category: category.trim() || null,
        title: title.trim(),
        body: text.trim(),
        suggestion: hasSugg ? suggestion : null,
      });
    } else {
      onSend(text.trim());
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="inline">
      <div className={`card human ${up ? 'finding editing' : 'new-disc'}`}>
        <div className="nd-head">
          <span className="av human">{up ? '●' : '你'}</span> {up ? '新增 finding' : '就此处批注'}
          <span className="tool-tag">{label}</span>
        </div>
        <div className="nd-ref">
          <span className="lnref">{label}</span> · {snippet}
        </div>
        <div className={`c-edit${hasSugg ? ' has-sugg' : ''}`} onKeyDown={onKeyDown}>
          {up && (
            <div className="fe-meta">
              <span className="fe-sev">
                {SEV_OPTIONS.map((s) => (
                  <button
                    key={s}
                    className={`${s === 'medium' ? 'med' : s}${severity === s ? ' on' : ''}`}
                    onClick={() => setSeverity(s)}
                  >
                    {SEV_LABEL[s]}
                  </button>
                ))}
              </span>
              <input
                className="fe-cat"
                value={category}
                spellCheck={false}
                aria-label="category"
                placeholder="category"
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
          )}
          {up && (
            <div className="fe-field">
              <div className="fe-cap">标题</div>
              <input
                ref={titleRef}
                className="fe-input"
                value={title}
                spellCheck={false}
                placeholder="一句话点出问题…"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          )}
          <div className="fe-field">
            {up && <div className="fe-cap">说明</div>}
            <textarea
              ref={textRef}
              className="fe-textarea"
              value={text}
              spellCheck={false}
              placeholder={
                up ? '展开说明与依据(可选)…' : '有疑问就直接问 agent;要记成 finding 打开右下开关…'
              }
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {up && (
            <div className="fe-field">
              {/* 同 .ac-up:真按钮,否则开关不进 Tab 顺序,键盘用户展不开 suggestion */}
              <button
                type="button"
                className="fe-sugg-tog"
                aria-pressed={hasSugg}
                onClick={() => setHasSugg((v) => !v)}
              >
                <span className="sw" />
                <span className="dia">◇</span> suggestion
              </button>
              <div className="fe-sugg">
                <textarea
                  className="fe-textarea fe-code"
                  value={suggestion}
                  spellCheck={false}
                  onChange={(e) => setSuggestion(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="fe-foot">
            {up ? (
              <button className="save" onClick={submit} disabled={!canSubmit}>
                新增 finding <span className="kbd">⌘↵</span>
              </button>
            ) : (
              <button className="send" onClick={submit} disabled={!canSubmit}>
                发送给 agent <span className="kbd">⌘↵</span>
              </button>
            )}
            <button className="cancel" onClick={onCancel}>
              取消 <span className="kbd">Esc</span>
            </button>
            {/* 真按钮而非 label:它是进入 finding 态的唯一入口,不可键盘触达等于键盘用户无法手动新增 */}
            <button
              type="button"
              className={`ac-up${up ? ' on' : ''}`}
              aria-pressed={up}
              onClick={toggleUp}
            >
              <span className="sw" />⚑ 记为 finding
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
