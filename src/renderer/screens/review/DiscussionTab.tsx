import { useEffect, useMemo, useRef, useState } from 'react';
import type { Discussion, Finding, FindingProposal, Message } from '@shared/domain';
import { Composer, type UnsentDraft } from './Composer';
import { renderMarkdown } from './markdown';
import { ProposalCard } from './ProposalCard';
import { stripIpcWrapper } from './round-error';

const basename = (p: string) => p.split('/').pop() ?? p;

/** reviewer(用户)侧头像图标,替代原先的「你」字形 */
function UserGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
      <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.7-9 6v1h18v-1c0-3.3-4-6-9-6z" />
    </svg>
  );
}

export interface DiscussionTabProps {
  discussions: Discussion[];
  findings: Finding[];
  messages: Record<string, Message[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 有在途追问的 discussionId(显示打字指示);同一线程可以有多条,故按集合认人 */
  awaitingReply: ReadonlySet<string>;
  /** 问题已发出、agent 没能回复的线程 → 原因;就地显示在该线程末尾 */
  replyFailure: Record<string, string>;
  /** 没发出去的原文(含框选发起的首问),待用户放回输入框 */
  unsent: UnsentDraft[];
  onRestoreUnsent: (d: UnsentDraft) => void;
  scanning: boolean;
  onSend: (text: string) => void | Promise<void>;
  /** 新开一条不锚定代码的全局讨论;失败原样抛出,由按钮就地回显 */
  onStartGlobal: () => Promise<unknown>;
  onJumpToCode: (d: Discussion) => void;
  ensureMessages: (id: string) => void;
  /** 把当前用户 discussion 提升为 finding */
  onPromote: (discussionId: string) => void;
  /** 清空当前 discussion 的往来消息(finding 卡保留),重开讨论 */
  onClearMessages: (discussionId: string) => void;
  /** agent 在讨论里提出的回写提案(全 review 范围,按 discussionId 筛) */
  proposals: FindingProposal[];
  onApplyProposal: (proposalId: string) => Promise<unknown>;
  onSkipProposal: (proposalId: string) => Promise<unknown>;
  onUndoProposal: (proposalId: string) => Promise<unknown>;
}

/** 一条 discussion 的展示标题:finding 用其标题,user 用首条消息 / 兜底文案 */
function titleOf(d: Discussion, findingByDisc: Map<string, Finding>, msgs: Message[]): string {
  const f = findingByDisc.get(d.id);
  if (f) return f.title;
  const firstUser = msgs.find((m) => m.role === 'user');
  if (firstUser) return firstUser.text.slice(0, 40);
  return d.file ? 'reviewer 发起的讨论' : '关于本次改动整体';
}

/**
 * 新开全局讨论的按钮;列表顶部与空态共用,免得两处文案各说一套。
 * 建线程失败就回显在按钮下方 —— 否则点了没反应,用户只能一直点。
 *
 * 在途期间禁用:建线程要一个来回,连点会各建一条内容相同的空讨论。真正的去重在
 * ReviewScreen.startGlobalDiscussion(空态 composer 也走那条路),这里只是别让按钮看着能点。
 */
function NewGlobalButton({ onClick }: { onClick: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await onClick();
    } catch (e) {
      setError(stripIpcWrapper((e as Error).message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="disc-new" onClick={() => void run()} disabled={busy}>
        <span className="dn-plus">＋</span> 新讨论
        <span className="dn-hint">{busy ? '开启中…' : '不锚定代码'}</span>
      </button>
      {error && <div className="dn-err">✕ 开不了新讨论:{error}</div>}
    </>
  );
}

export function DiscussionTab(props: DiscussionTabProps) {
  const { discussions, findings, messages, activeId, awaitingReply, scanning, ensureMessages } = props;

  const findingByDisc = useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of findings) m.set(f.discussionId, f);
    return m;
  }, [findings]);

  const active = discussions.find((d) => d.id === activeId) ?? null;
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId) ensureMessages(activeId);
  }, [activeId, ensureMessages]);

  const activeMsgCount = activeId ? (messages[activeId]?.length ?? 0) : 0;
  const activeAwaiting = !!activeId && awaitingReply.has(activeId);
  const activeFailure = activeId ? props.replyFailure[activeId] ?? null : null;
  // 新消息 / 切换线程 / agent 打字或报错时滚到底,始终看得到最新
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, activeMsgCount, activeAwaiting, activeFailure]);

  // 待恢复原文的去向:它记着自己本来问的是哪条线程,放回输入框会切回去。与当前线程一致时
  // 不必多说;原线程已不在(如换了 review 的残留)就直说会落到当前线程,别让人以为还发得回去。
  const targetNote = (d: UnsentDraft): string | null => {
    if (d.discussionId === activeId) return null;
    const target = d.discussionId ? discussions.find((x) => x.id === d.discussionId) : null;
    if (!target) return '原讨论已不在 · 放回后发给当前讨论';
    return `发往:${titleOf(target, findingByDisc, messages[target.id] ?? [])}`;
  };

  const activeMsgs = active ? messages[active.id] ?? [] : [];
  const rootFinding = active ? findingByDisc.get(active.id) ?? null : null;

  // 当前线程的提案:按消息分组挂到各自那条回复下,挂不上的(无 messageId / 消息已被清空)另收一处。
  const { proposalsByMessage, looseProposals } = useMemo(() => {
    const byMessage = new Map<string, FindingProposal[]>();
    const loose: FindingProposal[] = [];
    const known = new Set(activeMsgs.map((m) => m.id));
    for (const p of props.proposals) {
      if (!active || p.discussionId !== active.id) continue;
      if (p.messageId && known.has(p.messageId)) {
        const bucket = byMessage.get(p.messageId);
        if (bucket) bucket.push(p);
        else byMessage.set(p.messageId, [p]);
      } else loose.push(p);
    }
    return { proposalsByMessage: byMessage, looseProposals: loose };
  }, [props.proposals, active, activeMsgs]);

  // 提案要对照的是 finding 的**当前**值(可能已被就地编辑过);create 提案应用前还没有 finding。
  const findingById = useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of findings) m.set(f.id, f);
    return m;
  }, [findings]);
  const findingOf = (p: FindingProposal): Finding | null =>
    (p.findingId ? findingById.get(p.findingId) : null) ?? null;
  const anchorLabel = active?.file
    ? `${basename(active.file)}:${active.line ?? ''}${active.lineEnd ? `–${active.lineEnd}` : ''}`
    : null;

  return (
    <div className="disc-tab">
      {discussions.length > 0 && (
        <div className="disc-list">
          <NewGlobalButton onClick={props.onStartGlobal} />
          {discussions.map((d) => {
            const f = findingByDisc.get(d.id);
            return (
              <button
                key={d.id}
                className={`disc-item${d.id === activeId ? ' on' : ''}`}
                onClick={() => props.onSelect(d.id)}
              >
                <span className={`di-glyph ${d.kind === 'finding' ? 'agent' : 'human'}`}>
                  {d.kind === 'finding' ? '◆' : <UserGlyph />}
                </span>
                <span className="di-title">{titleOf(d, findingByDisc, messages[d.id] ?? [])}</span>
                {f && <span className={`di-sev sev-${f.severity}`} />}
                {d.file && (
                  <span className="di-anchor mono">
                    {basename(d.file)}:{d.line}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {active ? (
        <>
          {anchorLabel && (
            <div className="anchor-ref" title="跳到代码" onClick={() => props.onJumpToCode(active)}>
              <span className="bar" />
              <div className="ar-text">
                <div className="path mono">
                  {active.file}
                  <span className="lnref">
                    :{active.line}
                    {active.lineEnd ? `–${active.lineEnd}` : ''}
                  </span>
                  {rootFinding?.category ? ` · ${rootFinding.category}` : ''}
                </div>
              </div>
            </div>
          )}

          {!anchorLabel && (
            <div className="anchor-ref none">
              <span className="bar" />
              <div className="ar-text">
                <div className="path">关于本次改动整体 · 未锚定到具体代码</div>
              </div>
            </div>
          )}

          {/* finding 必须挂行锚点(提交时要落成 inline 评论),故无锚点的讨论不给「转为 finding」 */}
          {active.kind === 'user' && !rootFinding && active.file && (
            <div className="disc-actions">
              <button className="btn promote" onClick={() => props.onPromote(active.id)}>
                ⬆ 转为 finding
              </button>
              <span className="reply-hint">转为 finding 后即可随 review 提交给 author</span>
            </div>
          )}

          {activeMsgs.length > 0 && (
            <div className="thread-tools">
              <ClearButton key={active.id} onConfirm={() => props.onClearMessages(active.id)} />
            </div>
          )}

          <div className="thread" ref={threadRef}>
            {rootFinding && (
              <MessageBubble
                role="agent"
                name="agent"
                meta="report_finding"
                text={rootFinding.body || rootFinding.title}
              />
            )}
            {activeMsgs.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                name={m.role === 'agent' ? 'agent' : 'reviewer'}
                text={m.text}
                proposals={proposalsByMessage.get(m.id)}
                findingOf={findingOf}
                onApplyProposal={props.onApplyProposal}
                onSkipProposal={props.onSkipProposal}
                onUndoProposal={props.onUndoProposal}
              />
            ))}
            {/* 还没回挂到消息上的提案(turn 没给回复文本,或消息被清空过)接在线程末尾 ——
                挂不上就不渲染的话,一张待确认卡片会凭空消失,而它是唯一的确认入口 */}
            {looseProposals.length > 0 && (
              <div className="msg">
                <span className="av agent">◆</span>
                <div className="body">
                  {looseProposals.map((p) => (
                    <ProposalCard
                      key={p.id}
                      proposal={p}
                      finding={findingOf(p)}
                      onApply={props.onApplyProposal}
                      onSkip={props.onSkipProposal}
                      onUndo={props.onUndoProposal}
                    />
                  ))}
                </div>
              </div>
            )}
            {activeAwaiting && (
              <div className="msg">
                <span className="av agent">◆</span>
                <div className="body">
                  <div className="nm">
                    <b className="agent-name">agent</b> <span className="t">正在回复</span>
                  </div>
                  <div className="bubble agent">
                    <span className="typing">
                      <i /> <i /> <i />
                    </span>
                  </div>
                </div>
              </div>
            )}
            {/* 问题已经在上面了,缺的只是回复 —— 说清楚缺在哪,别让人以为自己没发出去。
                本线程还有别的追问在途时先不报:那句正等着回复,失败结论此刻下得太早。 */}
            {activeFailure && !activeAwaiting && (
              <div className="reply-failed">
                <span className="rf-ic">✕</span>
                <div>
                  <b>agent 没能回复这一问</b>
                  <div className="rf-why">{activeFailure}</div>
                  <div className="rf-hint">问题已记在本讨论里,可以再问一次。</div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="thread thread-empty">
          <p className="empty-note">
            {discussions.length > 0
              ? '从上方选择一条讨论查看对话。'
              : scanning
                ? '扫描进行中,agent 会实时上报 findings。不必等它 —— 框选左侧代码提问,或直接在下方问关于本次改动的问题。'
                : '还没有讨论。框选左侧代码、点一条 finding,或直接在下方提问。'}
          </p>
          {discussions.length === 0 && <NewGlobalButton onClick={props.onStartGlobal} />}
        </div>
      )}

      {/* 空态不禁用:直接开打就是一条无锚点的全局讨论(见 ReviewScreen.onComposerSend) */}
      <Composer
        disabled={false}
        placeholder={active ? '追问 agent…' : '问 agent 关于本次改动的任何问题…'}
        scope="◆ read-only sandbox · agent 仅阅读代码,不会改动"
        onSend={props.onSend}
        unsent={props.unsent}
        targetNote={targetNote}
        onRestore={props.onRestoreUnsent}
      />
    </div>
  );
}

/** 清空讨论:两步确认,避免误清;3s 未确认自动复位。挂 key={discussionId} 切换即重置。 */
function ClearButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return confirming ? (
    <button
      className="thr-clear on"
      onClick={() => {
        setConfirming(false);
        onConfirm();
      }}
    >
      确认清空?
    </button>
  ) : (
    <button
      className="thr-clear"
      title="清空本讨论的往来消息,重新开始(finding 保留)"
      onClick={() => setConfirming(true)}
    >
      ↻ 清空讨论
    </button>
  );
}

/** 复制 agent 回答原文(markdown 源码,非渲染后的富文本);成功后短暂回显。 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={`msg-copy${copied ? ' on' : ''}`}
      title="复制这条回答"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* 剪贴板不可用时静默 */
        }
      }}
    >
      {copied ? '✓ 已复制' : '⧉ 复制'}
    </button>
  );
}

function MessageBubble({
  role,
  name,
  meta,
  text,
  proposals,
  findingOf,
  onApplyProposal,
  onSkipProposal,
  onUndoProposal,
}: {
  role: 'agent' | 'user';
  name: string;
  meta?: string;
  text: string;
  /** 这一轮 agent 顺带提出的回写提案,接在气泡下方 */
  proposals?: FindingProposal[];
  findingOf?: (p: FindingProposal) => Finding | null;
  onApplyProposal?: (id: string) => Promise<unknown>;
  onSkipProposal?: (id: string) => Promise<unknown>;
  onUndoProposal?: (id: string) => Promise<unknown>;
}) {
  return (
    <div className="msg">
      <span className={`av ${role}`}>{role === 'agent' ? '◆' : <UserGlyph />}</span>
      <div className="body">
        <div className="nm">
          <b className={role === 'agent' ? 'agent-name' : 'human-name'}>{name}</b>
          {meta && <span className="t mono">{meta}</span>}
          {role === 'agent' && text.trim() && <CopyButton text={text} />}
        </div>
        <div className={`bubble${role === 'agent' ? ' agent' : ''}`}>
          <div className="c-prose">{renderMarkdown(text)}</div>
        </div>
        {proposals?.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            finding={findingOf?.(p) ?? null}
            onApply={onApplyProposal ?? noop}
            onSkip={onSkipProposal ?? noop}
            onUndo={onUndoProposal ?? noop}
          />
        ))}
      </div>
    </div>
  );
}

const noop = async (): Promise<void> => undefined;
