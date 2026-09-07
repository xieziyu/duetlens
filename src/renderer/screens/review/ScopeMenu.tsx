import { useEffect, useMemo, useRef, useState } from 'react';
import { isUnscanned, UNSCANNED_LABEL } from '@shared/domain';
import type { ReviewScopes, ScopeState } from '@shared/ipc';
import { commitAge, shortOid } from '../../review/source-ref';
import { imeComposing } from '../../keys';

/**
 * 顶栏的审核范围切换器:整个 PR ⇄ PR 里的某一个提交。
 *
 * **锚在顶栏那枚 chip 上**,而不是左栏面板或三栏之上的范围条 —— 范围是「这一屏在看什么」的
 * 上下文,与来源 chip、base chip 同一级;放进左栏会与文件树抢那一列的注意力,做成常驻条则
 * 要为一件低频动作永久让出一行高度(切范围之后人是要长时间读 diff 的)。
 *
 * 列表本身由外壳持有并在打开时刷新(范围的机审状态会随后台跑完而变,而这枚弹层是唯一看得见
 * 它们的地方);拉取失败就地说明并给重试 —— 但**不挡「整个 PR」**:那一档不需要提交列表也成立。
 */

/** 弹层里出过滤框的门槛;再少就是给三五行加一个用不上的输入框。 */
const FILTER_FROM = 8;

type ScopeTone = 'idle' | 'scanning' | 'done' | 'submitted';

function toneOf(s: ScopeState): ScopeTone {
  if (s.reviewId == null || s.currentRound == null || isUnscanned({ currentRound: s.currentRound }))
    return 'idle';
  if (s.status === 'scanning') return 'scanning';
  return s.submittedCount > 0 ? 'submitted' : 'done';
}

function badgeOf(s: ScopeState): string {
  switch (toneOf(s)) {
    case 'scanning':
      return '扫描中';
    case 'submitted':
      return `已提交 ${s.submittedCount}`;
    case 'done':
      return `${s.findingCount} findings`;
    default:
      return UNSCANNED_LABEL;
  }
}

/** 一行的完整身份:sha + 标题 + 作者 + 时间;chip 与弹层共用,免得两处对同一行各说一套。 */
export function ScopeSwitcher({
  prLabel,
  activeSha,
  pending,
  onPick,
  scopes,
  loading,
  error,
  onReload,
}: {
  /** PR 的短标识(`#482`);「整个 PR」那一行拿它当身份,与顶栏来源 chip 对得上 */
  prLabel: string;
  /** 当前停在哪个 commit;null = 整个 PR */
  activeSha: string | null;
  /** 正在拉取的那个范围(切换在途);那一行显示为在途、其余仍可点 */
  pending: string | null;
  onPick: (sha: string | null) => void;
  /** 范围列表由外壳拉:切换器随三栏按范围重挂,搁在这里等于每切一次范围重拉一次 */
  scopes: ReviewScopes | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  // 每次打开刷新一次:别的范围可能已经在后台跑完了
  useEffect(() => {
    if (open) onReload();
  }, [open, onReload]);

  // 显示新→旧:人切过来多半是找最近那几个提交,倒过来它们要滚到最底下。
  // 契约本身仍是旧→新(见 ReviewScopes.commits),只在这一层翻转,别把倒序写回后端。
  const commits = useMemo(() => [...(scopes?.commits ?? [])].reverse(), [scopes]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) => c.commit.headline.toLowerCase().includes(q) || c.commit.oid.toLowerCase().includes(q),
    );
  }, [commits, query]);

  const idx = commits.findIndex((c) => c.commit.oid === activeSha);
  const current = idx >= 0 ? commits[idx] : null;
  // chip 上的 k/N 报的是它在 PR 里的第几个(旧→新计数),与首轮提示词里告诉 agent 的位置同一口径
  const ordinal = idx >= 0 ? commits.length - idx : 0;

  // 键盘选择:行的顺序 = 「整个 PR」+ 过滤后的提交,索引 0 即整个 PR
  const rows: (string | null)[] = useMemo(() => [null, ...filtered.map((c) => c.commit.oid)], [filtered]);
  // 过滤把行数缩短时光标可能落在表外
  const at = Math.min(cursor, rows.length - 1);

  // 光标跟随滚动:行区只放得下十来行,几百个提交的 PR 上光标走出可视区人就不知道自己停在哪;
  // 刚打开时光标落在当前提交那一行,同样要滚过去。`.sm-row` 的 DOM 顺序与 rows 一致
  useEffect(() => {
    if (!open) return;
    const row = rowsRef.current?.querySelectorAll<HTMLElement>('.sm-row')[at];
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, at]);

  /**
   * 键盘监听挂在**打开期间的 window** 上,而不是过滤框的 onKeyDown:过滤框只在提交多到一定
   * 数量时才出,挂在它上面等于短列表里上下键与回车全是死的(而那正是最常见的列表长度)。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // 捕获阶段收 mousedown —— 弹层里的行是在 click 上响应的,冒泡阶段关会先把行拆掉
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      // ⌥↑ / ⌥↓ 是屏上「不开弹层直接前后切」的键位,别在这里抢着再响应一次
      if (e.altKey || e.metaKey || e.ctrlKey || imeComposing(e)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
        setCursor(next);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setQuery('');
        onPick(rows[at] ?? null);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, rows, at, onPick]);

  const label = activeSha ? `@${shortOid(activeSha)}` : '整个 PR';
  const pos = activeSha
    ? ordinal
      ? `${ordinal}/${commits.length}`
      : ''
    : commits.length
      ? `${commits.length} 个提交`
      : '';

  const pick = (sha: string | null) => {
    setOpen(false);
    setQuery('');
    onPick(sha);
  };

  return (
    <span className="scopewrap" ref={wrapRef}>
      <button
        className={`scopechip${open ? ' open' : ''}`}
        onClick={() => {
          setOpen((v) => !v);
          // 光标落在当前停着的那一行:从「整个 PR」起步的话,人在第 3 个提交上按 ↓↵ 会跳到第 1 个
          setCursor(idx >= 0 ? idx + 1 : 0);
        }}
        title={
          current
            ? `${current.commit.headline} —— 切换审核范围:整个 PR 或其中一个提交 (⌥↑ / ⌥↓ 前后切)`
            : '切换审核范围:整个 PR 或其中一个提交 (⌥↑ / ⌥↓ 前后切)'
        }
      >
        {label}
        {pos && <span className="pos">{pos}</span>}
        <span className="chev" />
      </button>
      {open && (
        <div className="scope-menu" role="dialog" aria-label="审核范围">
          <div className="sm-head">
            <b>审核范围</b>
            <span>提交新 → 旧,最近的在最上面</span>
            <span className="sp" />
            <span>{commits.length ? `${commits.length} 个提交` : loading ? '拉取中…' : ''}</span>
          </div>
          {commits.length > FILTER_FROM && (
            <div className="sm-filter">
              <input
                autoFocus
                placeholder="过滤 提交信息 / sha"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
              />
            </div>
          )}
          <div className="sm-rows" ref={rowsRef}>
            <ScopeRow
              sha={null}
              label={prLabel}
              sel={activeSha === null}
              active={at === 0}
              busy={false}
              state={scopes?.pr ?? null}
              title="整个 PR"
              meta="相对 base 的全部改动 · 默认范围"
              onPick={pick}
            />
            <div className="sm-sep">提交</div>
            {error && (
              <div className="sm-error">
                <span>拉不到 PR 的提交列表:{error}</span>
                <button onClick={onReload} disabled={loading}>
                  {loading ? '重试中…' : '重试'}
                </button>
              </div>
            )}
            {!error && loading && commits.length === 0 && <div className="sm-note">正在拉取提交列表…</div>}
            {!error && !loading && commits.length === 0 && (
              <div className="sm-note">这个 PR 里没有可单独审核的提交。</div>
            )}
            {filtered.length === 0 && commits.length > 0 && <div className="sm-note">没有匹配的提交。</div>}
            {filtered.map((c, i) => (
              <ScopeRow
                key={c.commit.oid}
                sha={c.commit.oid}
                sel={c.commit.oid === activeSha}
                active={at === i + 1}
                busy={pending === c.commit.oid}
                state={c}
                title={c.commit.headline}
                meta={`@${c.commit.author}${c.commit.committedDate ? ` · ${commitAge(c.commit.committedDate)}` : ''}${c.commit.isMerge ? ' · merge' : ''}`}
                onPick={pick}
              />
            ))}
            {scopes?.capped && (
              // 截掉的是最早那段,新→旧下它们本该接在列表末尾,提示就摆在那个位置
              <div className="sm-note">这个 PR 的提交太多,只列出最新的 {commits.length} 个,更早的没有列出。</div>
            )}
          </div>
          <div className="sm-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> 移动 · <kbd>↵</kbd> 切换
            </span>
            <span className="sp" />
            <span>
              <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> 不开弹层直接前后切
            </span>
          </div>
        </div>
      )}
    </span>
  );
}

function ScopeRow({
  sha,
  label,
  sel,
  active,
  busy,
  state,
  title,
  meta,
  onPick,
}: {
  sha: string | null;
  /** 身份列的显示值;缺省取短 sha */
  label?: string;
  sel: boolean;
  /** 键盘光标停在这一行 */
  active: boolean;
  /** 这一行的 diff 正在拉 */
  busy: boolean;
  /** 还没建出来的范围没有 state,按「未机审」画 */
  state: ScopeState | null;
  title: string;
  meta: string;
  onPick: (sha: string | null) => void;
}): React.JSX.Element {
  const tone = state ? toneOf(state) : 'idle';
  return (
    <div
      className={`sm-row${sel ? ' sel' : ''}${active ? ' active' : ''}`}
      onClick={() => onPick(sha)}
      role="button"
      tabIndex={-1}
    >
      <span className={`st ${tone}`} />
      <span className="sha mono">{label ?? (sha ? shortOid(sha) : '')}</span>
      <span className="m">
        <div className="hl">{title}</div>
        <div className="meta">{meta}</div>
      </span>
      {busy ? (
        <span className="badge scanning">拉取中…</span>
      ) : state ? (
        <span className={`badge ${tone}`}>{badgeOf(state)}</span>
      ) : sha ? (
        // 列表里的 commit 没有 state = 这个范围还没被打开过,那确实就是未机审
        <span className="badge idle">{UNSCANNED_LABEL}</span>
      ) : null /* 「整个 PR」没有 state 只说明这一次没拉到,不能据此宣称它没机审过 */}
    </div>
  );
}
