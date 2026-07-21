import { useEffect, useRef, useState } from 'react';
import type { Severity } from '@shared/domain';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };
const SEV_OPTIONS: Severity[] = ['high', 'medium', 'low'];

/** 手动新增 finding 时用户填写的字段(锚点由 DiffPane 的选区提供,不在此)。 */
export interface NewFindingDraft {
  severity: Severity;
  category: string | null;
  title: string;
  body: string;
  suggestion: string | null;
}

export interface NewFindingComposerProps {
  label: string;
  snippet: string;
  onCreate: (draft: NewFindingDraft) => void;
  onCancel: () => void;
}

/**
 * diff 锚点处的内联「新增 finding」卡:空白起编,复用 InlineCard 编辑态的样式(.c-edit/.fe-*)。
 * 保存即经 review:add-finding 落库(origin=manual),不留空草稿;取消不落库。
 */
export function NewFindingComposer({ label, snippet, onCreate, onCancel }: NewFindingComposerProps) {
  const [severity, setSeverity] = useState<Severity>('medium');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [hasSugg, setHasSugg] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const create = () => {
    const t = title.trim();
    if (!t) return; // 标题必填,与 report_finding schema 一致
    onCreate({
      severity,
      category: category.trim() || null,
      title: t,
      body: body.trim(),
      suggestion: hasSugg ? suggestion : null,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      create();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="inline">
      <div className="card human finding editing">
        <div className={`c-edit${hasSugg ? ' has-sugg' : ''}`} onKeyDown={onKeyDown}>
          <div className="nd-head">
            <span className="av human">●</span> 新增 finding
            <span className="tool-tag">框选 {label}</span>
          </div>
          <div className="nd-ref">
            <span className="lnref">{label}</span> · {snippet}
          </div>
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
          <div className="fe-field">
            <div className="fe-cap">说明</div>
            <textarea
              className="fe-textarea"
              value={body}
              spellCheck={false}
              placeholder="展开说明与依据(可选)…"
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="fe-field">
            <label className="fe-sugg-tog" onClick={() => setHasSugg((v) => !v)}>
              <span className="sw" />
              <span className="dia">◇</span> 附给 author 的 suggestion
            </label>
            <div className="fe-sugg">
              <div className="fe-cap">
                <span className="dia">◇</span> suggestion · 提交时渲染为 GitHub suggestion 块
              </div>
              <textarea
                className="fe-textarea fe-code"
                value={suggestion}
                spellCheck={false}
                onChange={(e) => setSuggestion(e.target.value)}
              />
            </div>
          </div>
          <div className="fe-foot">
            <button className="save" onClick={create} disabled={!title.trim()}>
              新增 <span className="kbd">⌘↵</span>
            </button>
            <button className="cancel" onClick={onCancel}>
              取消 <span className="kbd">Esc</span>
            </button>
            <span className="fe-note">新增为你手动提出的 finding</span>
          </div>
        </div>
      </div>
    </div>
  );
}
