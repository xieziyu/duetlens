import { useEffect, useRef, useState } from 'react';
import {
  isAutoClosedFixed,
  type Finding,
  type FindingResolution,
  type Severity,
  type Triage,
} from '@shared/domain';
import type { FindingEditInput } from '@shared/ipc';
import { CategorySelect } from './CategorySelect';
import { renderMarkdown } from './markdown';
import { currentResolution, isNewThisRound } from './rounds';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };
const SEV_OPTIONS: Severity[] = ['high', 'medium', 'low'];

export interface InlineCardProps {
  finding: Finding;
  /** 被右栏点选定位时短暂高亮 */
  focused?: boolean;
  /** 锚点不在当前改动新侧(off-diff 区),需自带行号定位;锚定卡则行号已由 gutter 呈现,不再重复。 */
  offDiff?: boolean;
  /** 锚点新侧行的原文;有则 suggestion 预览渲染成 GitHub 式 diff(删原行 / 增 suggestion)。off-diff 无原行时缺省。 */
  originalLine?: string;
  /** review 当前轮次;用于判定卡上的「本轮新增 / 已修复」标记 */
  currentRound?: number;
  /** 用户裁决(保留/剔除/复位);剔除可带理由,注入下一轮复审。缺省时卡为纯只读(如预览/未接线场景) */
  onTriage?: (finding: Finding, triage: Triage, reason?: string | null) => void;
  /** 就地编辑保存 */
  onUpdate?: (input: FindingEditInput) => void;
  /** 就这条 finding 追问 agent:切到 Discussion 栏并选中其承载线程 */
  onDiscuss?: (finding: Finding) => void;
}

/**
 * 锚定在 diff 行处的内联 finding 卡:view / edit / dismissed 三态。
 * submitted 为只读锁定;编辑经 IPC 落库,回推事件再刷新视图(前端不臆造权威数据)。
 */
export function InlineCard({
  finding,
  focused,
  offDiff,
  originalLine,
  currentRound = 1,
  onTriage,
  onUpdate,
  onDiscuss,
}: InlineCardProps) {
  const isAgent = finding.origin === 'agent';
  const submitted = finding.submission === 'submitted';
  const dismissed = finding.triage === 'dismiss';
  const [editing, setEditing] = useState(false);
  const writable = !!(onTriage || onUpdate) && !submitted;
  const resolution = currentResolution(finding, currentRound);

  const cardClass =
    `card ${isAgent ? 'agent' : 'human'} finding` +
    (focused ? ' focused' : '') +
    (submitted ? ' submitted' : '') +
    (dismissed && !editing ? ' dismissed' : '') +
    (resolution === 'wont_fix' && !editing ? ' resolved' : '') +
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
          <DismissedCard finding={finding} onTriage={onTriage} />
        ) : (
          <CardView
            finding={finding}
            isAgent={isAgent}
            submitted={submitted}
            writable={writable}
            offDiff={offDiff}
            originalLine={originalLine}
            resolution={resolution}
            isNew={isNewThisRound(finding, currentRound)}
            onEdit={onUpdate ? () => setEditing(true) : undefined}
            onDismiss={onTriage ? () => onTriage(finding, 'dismiss') : undefined}
            onAccept={
              onTriage
                ? () => onTriage(finding, 'dismiss', finding.resolutionNote ?? null)
                : undefined
            }
            onDiscuss={onDiscuss ? () => onDiscuss(finding) : undefined}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 已剔除态。理由是**事后可选补充**而非剔除时的必填门槛 ——
 * 一键剔除的速度不能被输入框拖慢,但填了理由下一轮的同类抑制会准得多。
 * 复核判定已修复而自动结案的另标一套字样:它不是"你认为这不是问题",别让人以为自己剔过。
 */
function DismissedCard({
  finding,
  onTriage,
}: {
  finding: Finding;
  onTriage?: (finding: Finding, triage: Triage, reason?: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [reason, setReason] = useState(finding.dismissReason ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = () => {
    onTriage?.(finding, 'dismiss', reason.trim() || null);
    setEditing(false);
  };

  const autoClosed = isAutoClosedFixed(finding);

  return (
    <div className={`c-dismissed${autoClosed ? ' auto' : ''}`}>
      <div className="dm-row">
        <span className="dm-x">{autoClosed ? '✓' : '✕'}</span>
        <span className="dm-t">
          {autoClosed ? '已修复 · 自动剔除' : '已剔除'} · {finding.title}
        </span>
        {onTriage && (
          <>
            {/* 自动结案的理由是系统写的固定文案,没什么可补的;真要改口径走「恢复」再手动剔除 */}
            {!autoClosed && (
              <button className="dm-why" onClick={() => setEditing((v) => !v)} title="理由会注入下一轮复审">
                {finding.dismissReason ? '✎ 理由' : '＋ 理由'}
              </button>
            )}
            <button className="f-restore" onClick={() => onTriage(finding, 'open')}>
              ↩ 恢复
            </button>
          </>
        )}
      </div>
      {/* 自动结案时标题行已说明缘由,这里改挂 agent 的复核说明 —— 那才是新信息 */}
      {!editing && (autoClosed ? finding.resolutionNote : finding.dismissReason) && (
        <div className="dm-reason">{autoClosed ? finding.resolutionNote : finding.dismissReason}</div>
      )}
      {editing && (
        <div className="dm-edit">
          <input
            ref={inputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                setReason(finding.dismissReason ?? '');
                setEditing(false);
              }
            }}
            placeholder="为什么这不算问题?下一轮 agent 会据此不再报同类"
          />
          <button className="dm-save" onClick={save}>
            保存
          </button>
        </div>
      )}
      {/* 剔除只写 triage 与理由,原文一直都在库里 —— 但收起态只剩一个划掉的标题,
          于是「当初到底报的是什么」在屏上无处可查。展开即可,不必先恢复再剔一遍。 */}
      {finding.body.trim() && (
        <div className="dm-src">
          <button onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? '▴ 收起原文' : '▾ 展开原文'}
          </button>
          {/* 标题已在上面那行(划掉的那条)给过,这里只补正文 —— 再印一遍就是同一句话说两次 */}
          {showOriginal && (
            <div className="dm-orig">
              <div className="c-prose">{renderMarkdown(finding.body)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CardView({
  finding,
  isAgent,
  submitted,
  writable,
  offDiff,
  originalLine,
  resolution,
  isNew,
  onEdit,
  onDismiss,
  onAccept,
  onDiscuss,
}: {
  finding: Finding;
  isAgent: boolean;
  submitted: boolean;
  writable: boolean;
  offDiff?: boolean;
  originalLine?: string;
  resolution: FindingResolution | null;
  isNew: boolean;
  onEdit?: () => void;
  onDismiss?: () => void;
  onAccept?: () => void;
  onDiscuss?: () => void;
}) {
  return (
    <div className="c-view">
      <div className="c-head">
        <span className="who">
          <span className={`av ${isAgent ? 'agent' : 'human'}`}>{isAgent ? '◆' : '●'}</span>
          {isAgent ? 'agent' : finding.origin === 'promoted' ? '你 · 提升' : '你'}
        </span>
        <span className={`sev sev-${finding.severity}`}>
          {SEV_LABEL[finding.severity]}
          {finding.category ? ` · ${finding.category}` : ''}
        </span>
        {isNew && <span className="round-tag new">本轮新增</span>}
        {/* 刻意没有「已修复」一格:判定 fixed 连带自动剔除,那一态由 DismissedCard 呈现。
            走到这里说明它仍是保留态(reviewer 恢复过 / 他先剔除过),右栏的 isFixedResolved
            照样把它排进待处理 —— 这边挂徽标就成了两套口径。agent 的结论由下面的「复核」说明照常给出。 */}
        {resolution === 'still_present' && <span className="round-tag still">本轮复核 · 仍存在</span>}
        {resolution === 'wont_fix' && <span className="round-tag wontfix">◇ 作者已回应</span>}
      </div>
      <div className="c-body">
        <strong className="c-title">{finding.title}</strong>
        {finding.body && <div className="c-prose">{renderMarkdown(finding.body)}</div>}
        {resolution && finding.resolutionNote && (
          <div className={`c-resnote${resolution === 'wont_fix' ? ' wontfix' : ''}`}>
            <span className="crn-lbl">{resolution === 'wont_fix' ? '作者' : '复核'}</span>
            {finding.resolutionNote}
          </div>
        )}
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
      {/* 追问不受 writable 约束:已提交的 finding 内容锁定,但仍该能接着聊 */}
      {writable || onDiscuss ? (
        <div className="c-actions">
          {onDiscuss && (
            <button className="btn f-ask" onClick={onDiscuss} title="切到 Discussion 栏就这条 finding 追问">
              ↳ 追问
            </button>
          )}
          {writable && onEdit && (
            <button className="btn f-edit" onClick={onEdit}>
              ✎ 编辑
            </button>
          )}
          {/* 作者已回应时给一键出口:剔除并把 agent 摘录的作者原话存为剔除理由,
              下一轮据此不再报同类。是否采纳仍是 reviewer 点了才算。 */}
          {writable && onAccept && resolution === 'wont_fix' && (
            <button className="btn f-accept" onClick={onAccept} title="剔除此条,并把作者的说明记为剔除理由">
              ✓ 采纳作者说明
            </button>
          )}
          {writable && onDismiss && (
            <button className="btn danger f-dismiss" onClick={onDismiss}>
              ✕ 剔除
            </button>
          )}
          {offDiff && <span className="reply-hint mono anchor-tag">L{finding.line}</span>}
          {submitted && <span className="sub-tag">✓ 已提交</span>}
        </div>
      ) : (
        (offDiff || submitted) && (
          <div className="card-foot">
            {offDiff && <span className="mono anchor-tag">L{finding.line}</span>}
            {submitted && <span className="sub-tag">✓ 已提交</span>}
          </div>
        )
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
  const [category, setCategory] = useState<string | null>(finding.category);
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
      category,
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
        <CategorySelect value={category} onChange={setCategory} />
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
        {/* 真按钮:label 不带关联控件时不进 Tab 顺序,键盘用户展不开 suggestion */}
        <div className="fe-sugg-row">
          <button
            type="button"
            className="fe-sugg-tog"
            aria-pressed={hasSugg}
            onClick={() => setHasSugg((v) => !v)}
          >
            <span className="sw" />
            <span className="dia">◇</span> suggestion
          </button>
          <span className="fe-sugg-hint">替换锚点行的代码,提交后作者可一键采纳</span>
        </div>
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
