import { useEffect, useRef, useState } from 'react';
import type { Finding, Severity, Triage } from '@shared/domain';
import type { FindingEditInput } from '@shared/ipc';
import { renderMarkdown } from './markdown';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };
const SEV_OPTIONS: Severity[] = ['high', 'medium', 'low'];

export interface InlineCardProps {
  finding: Finding;
  /** 被右栏点选定位时短暂高亮 */
  focused?: boolean;
  /** 锚点新侧行的原文;有则 suggestion 预览渲染成 GitHub 式 diff(删原行 / 增 suggestion)。off-diff 无原行时缺省。 */
  originalLine?: string;
  /** 用户裁决(保留/剔除/复位);缺省时卡为纯只读(如预览/未接线场景) */
  onTriage?: (finding: Finding, triage: Triage) => void;
  /** 就地编辑保存 */
  onUpdate?: (input: FindingEditInput) => void;
}

/**
 * 锚定在 diff 行处的内联 finding 卡(对齐 mockup .card):view / edit / dismissed 三态。
 * submitted 为只读锁定;编辑经 IPC 落库,回推事件再刷新视图(前端不臆造权威数据)。
 */
export function InlineCard({ finding, focused, originalLine, onTriage, onUpdate }: InlineCardProps) {
  const isAgent = finding.origin === 'agent';
  const submitted = finding.submission === 'submitted';
  const dismissed = finding.triage === 'dismiss';
  const [editing, setEditing] = useState(false);
  const writable = !!(onTriage || onUpdate) && !submitted;

  const cardClass =
    `card ${isAgent ? 'agent' : 'human'} finding` +
    (focused ? ' focused' : '') +
    (submitted ? ' submitted' : '') +
    (dismissed && !editing ? ' dismissed' : '') +
    (editing ? ' editing' : '');

  return (
    <div className="inline" id={`finding-${finding.id}`}>
      <div className={cardClass}>
        {editing ? (
          <CardEdit
            finding={finding}
            onCancel={() => setEditing(false)}
            onSave={(input) => {
              onUpdate?.(input);
              setEditing(false);
            }}
          />
        ) : dismissed ? (
          <div className="c-dismissed">
            <span className="dm-x">✕</span>
            <span className="dm-t">已剔除 · {finding.title}</span>
            {onTriage && (
              <button className="f-restore" onClick={() => onTriage(finding, 'keep')}>
                ↩ 恢复
              </button>
            )}
          </div>
        ) : (
          <CardView
            finding={finding}
            isAgent={isAgent}
            submitted={submitted}
            writable={writable}
            originalLine={originalLine}
            onEdit={onUpdate ? () => setEditing(true) : undefined}
            onDismiss={onTriage ? () => onTriage(finding, 'dismiss') : undefined}
          />
        )}
      </div>
    </div>
  );
}

function CardView({
  finding,
  isAgent,
  submitted,
  writable,
  originalLine,
  onEdit,
  onDismiss,
}: {
  finding: Finding;
  isAgent: boolean;
  submitted: boolean;
  writable: boolean;
  originalLine?: string;
  onEdit?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="c-view">
      <div className="c-head">
        <span className="who">
          <span className={`av ${isAgent ? 'agent' : 'human'}`}>{isAgent ? '◆' : '●'}</span>
          {isAgent ? 'codex' : finding.origin === 'promoted' ? '你 · 提升' : '你'}
        </span>
        <span className={`sev sev-${finding.severity}`}>
          {SEV_LABEL[finding.severity]}
          {finding.category ? ` · ${finding.category}` : ''}
        </span>
      </div>
      <div className="c-body">
        <strong className="c-title">{finding.title}</strong>
        {finding.body && <div className="c-prose">{renderMarkdown(finding.body)}</div>}
      </div>
      {finding.suggestion && (
        <div className="c-sugg">
          <div className="c-sugg-lbl">
            <span className="dia">◇</span> suggestion
          </div>
          <div className="c-sugg-diff">
            {originalLine != null && (
              <div className="csd-row del">
                <span className="csd-gut">−</span>
                <span className="csd-code">{originalLine || ' '}</span>
              </div>
            )}
            {finding.suggestion.split('\n').map((l, i) => (
              <div className="csd-row add" key={i}>
                <span className="csd-gut">＋</span>
                <span className="csd-code">{l || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {writable ? (
        <div className="c-actions">
          {onEdit && (
            <button className="btn f-edit" onClick={onEdit}>
              ✎ 编辑
            </button>
          )}
          {onDismiss && (
            <button className="btn danger f-dismiss" onClick={onDismiss}>
              ✕ 剔除
            </button>
          )}
          <span className="reply-hint mono anchor-tag">
            {finding.file}:{finding.line}
          </span>
        </div>
      ) : (
        <div className="card-foot">
          <span className="mono anchor-tag">
            {finding.file}:{finding.line}
          </span>
          {submitted && <span className="sub-tag">✓ 已提交</span>}
        </div>
      )}
    </div>
  );
}

function CardEdit({
  finding,
  onSave,
  onCancel,
}: {
  finding: Finding;
  onSave: (input: FindingEditInput) => void;
  onCancel: () => void;
}) {
  const [severity, setSeverity] = useState<Severity>(finding.severity);
  const [category, setCategory] = useState(finding.category ?? '');
  const [title, setTitle] = useState(finding.title);
  const [body, setBody] = useState(finding.body);
  const [hasSugg, setHasSugg] = useState(finding.suggestion != null);
  const [suggestion, setSuggestion] = useState(finding.suggestion ?? '');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  const save = () => {
    const t = title.trim();
    if (!t) return; // 标题必填,空则不保存(与 report_finding schema 一致)
    onSave({
      findingId: finding.id,
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
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className={`c-edit${hasSugg ? ' has-sugg' : ''}`} onKeyDown={onKeyDown}>
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
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="fe-field">
        <div className="fe-cap">说明</div>
        <textarea
          className="fe-textarea"
          value={body}
          spellCheck={false}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="fe-field">
        <label className="fe-sugg-tog" onClick={() => setHasSugg((v) => !v)}>
          <span className="sw" />
          <span className="dia">◇</span> suggestion
        </label>
        <div className="fe-sugg">
          <textarea
            className="fe-textarea fe-code"
            value={suggestion}
            spellCheck={false}
            onChange={(e) => setSuggestion(e.target.value)}
          />
        </div>
      </div>
      <div className="fe-foot">
        <button className="save" onClick={save}>
          保存 <span className="kbd">⌘↵</span>
        </button>
        <button className="cancel" onClick={onCancel}>
          取消 <span className="kbd">Esc</span>
        </button>
      </div>
    </div>
  );
}
