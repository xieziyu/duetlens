import { useEffect, useRef } from 'react';
import { imeComposing } from '../../keys';
import type { FindOptions } from './diff-find';

export interface DiffFindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  options: FindOptions;
  onOptionsChange: (o: FindOptions) => void;
  /** 命中总数与当前项下标(无命中为 -1) */
  total: number;
  current: number;
  capped: boolean;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  /** ⌘F 每次按下自增:据此把焦点抢回输入框并全选(重复按 ⌘F 换词的常见手势) */
  focusNonce: number;
}

/**
 * diff 内容检索条。浮在中栏右上,**不在滚动容器内** —— 放进去的话它会随内容滚,
 * 点上一处 / 下一处时搜索条自己先跑掉。定位由 .diff-col 承担。
 */
export function DiffFindBar({
  query,
  onQueryChange,
  options,
  onOptionsChange,
  total,
  current,
  capped,
  onStep,
  onClose,
  focusNonce,
}: DiffFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  const empty = query.length > 0 && total === 0;
  const count = !query
    ? ''
    : total === 0
      ? '无结果'
      : `${current + 1} / ${total}${capped ? '+' : ''}`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <div className={`dfind${empty ? ' none' : ''}`} role="search" aria-label="在 diff 中查找">
      <span className="dfi">
        <SearchIcon />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在 diff 中查找"
          spellCheck={false}
          aria-label="在 diff 中查找"
        />
      </span>
      {count && (
        <span className="cnt" aria-live="polite">
          {count}
        </span>
      )}
      {/* 两枚开关整组进退:中栏被挤窄时一起收起,保住输入框与前后跳(见 .dopts 的容器查询) */}
      <span className="dopts">
        <span className="dsep" />
        <button
          className={`dopt${options.caseSensitive ? ' on' : ''}`}
          aria-pressed={options.caseSensitive}
          title="区分大小写(关闭时:查询含大写才区分)"
          onClick={() => onOptionsChange({ ...options, caseSensitive: !options.caseSensitive })}
        >
          Aa
        </button>
        <button
          className={`dopt${options.wholeWord ? ' on' : ''}`}
          aria-pressed={options.wholeWord}
          title="全词匹配"
          onClick={() => onOptionsChange({ ...options, wholeWord: !options.wholeWord })}
        >
          ab|
        </button>
      </span>
      <span className="dsep" />
      <button className="dnav" disabled={total === 0} title="上一处 (⇧↵ / ⌘⇧G)" onClick={() => onStep(-1)}>
        <ChevronIcon up />
      </button>
      <button className="dnav" disabled={total === 0} title="下一处 (↵ / ⌘G)" onClick={() => onStep(1)}>
        <ChevronIcon />
      </button>
      <button className="dnav" title="关闭 (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

const SearchIcon = () => (
  <svg className="mag" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const ChevronIcon = ({ up }: { up?: boolean }) => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    style={up ? { transform: 'rotate(180deg)' } : undefined}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);
