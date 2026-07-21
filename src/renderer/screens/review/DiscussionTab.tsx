import { useEffect, useMemo, useRef } from 'react';
import type { Discussion, Finding, Message } from '@shared/domain';
import { Composer } from './Composer';

const basename = (p: string) => p.split('/').pop() ?? p;

export interface DiscussionTabProps {
  discussions: Discussion[];
  findings: Finding[];
  messages: Record<string, Message[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 框选「追问 codex」带入的待发引用(新建 discussion 用) */
  pendingRef: { label: string } | null;
  onClearRef: () => void;
  /** 正在等 agent 回复的 discussionId(显示打字指示) */
  awaitingReply: string | null;
  scanning: boolean;
  onSend: (text: string) => void;
  onJumpToCode: (d: Discussion) => void;
  ensureMessages: (id: string) => void;
  /** 把当前用户 discussion 提升为 finding */
  onPromote: (discussionId: string) => void;
}

/** 一条 discussion 的展示标题:finding 用其标题,user 用首条消息 / 兜底文案 */
function titleOf(d: Discussion, findingByDisc: Map<string, Finding>, msgs: Message[]): string {
  const f = findingByDisc.get(d.id);
  if (f) return f.title;
  const firstUser = msgs.find((m) => m.role === 'user');
  return firstUser ? firstUser.text.slice(0, 40) : '你发起的讨论';
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
  // 新消息 / 切换线程 / agent 打字时滚到底,始终看得到最新
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, activeMsgCount, awaitingReply]);

  if (discussions.length === 0 && !props.pendingRef) {
    return (
      <div className="tab-body">
        <p className="empty-note">
          {scanning
            ? '扫描进行中,codex 会实时上报 findings。你也可以框选左侧代码直接向 codex 提问,无需等待。'
            : '还没有讨论。框选左侧代码或点一条 finding,开始与 codex 讨论。'}
        </p>
      </div>
    );
  }

  const activeMsgs = active ? messages[active.id] ?? [] : [];
  const rootFinding = active ? findingByDisc.get(active.id) ?? null : null;
  const anchorLabel = active?.file
    ? `${basename(active.file)}:${active.line ?? ''}${active.lineEnd ? `–${active.lineEnd}` : ''}`
    : null;

  return (
    <div className="disc-tab">
      {discussions.length > 0 && (
        <div className="disc-list">
          {discussions.map((d) => {
            const f = findingByDisc.get(d.id);
            return (
              <button
                key={d.id}
                className={`disc-item${d.id === activeId ? ' on' : ''}`}
                onClick={() => props.onSelect(d.id)}
              >
                <span className={`di-glyph ${d.kind === 'finding' ? 'agent' : 'human'}`}>
                  {d.kind === 'finding' ? '◆' : '你'}
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

          {active.kind === 'user' && !rootFinding && (
            <div className="disc-actions">
              <button className="btn promote" onClick={() => props.onPromote(active.id)}>
                ⬆ 转为 finding
              </button>
              <span className="reply-hint">转为 finding 后即可随 review 提交给 author</span>
            </div>
          )}

          <div className="thread" ref={threadRef}>
            {rootFinding && (
              <MessageBubble
                role="agent"
                name="codex"
                meta="report_finding"
                text={rootFinding.body || rootFinding.title}
              />
            )}
            {activeMsgs.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                name={m.role === 'agent' ? 'codex' : '你'}
                text={m.text}
              />
            ))}
            {awaitingReply === active.id && (
              <div className="msg">
                <span className="av agent">◆</span>
                <div className="body">
                  <div className="nm">
                    <b className="agent-name">codex</b> <span className="t">正在回复</span>
                  </div>
                  <div className="bubble agent">
                    <span className="typing">
                      <i /> <i /> <i />
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="thread thread-empty">
          <p className="empty-note">
            {props.pendingRef
              ? '已引用选区,输入你的问题向 codex 发起讨论。'
              : '从上方选择一条讨论查看对话。'}
          </p>
        </div>
      )}

      <Composer
        refLabel={props.pendingRef?.label ?? null}
        onRemoveRef={props.onClearRef}
        disabled={!active && !props.pendingRef}
        placeholder="追问 codex…"
        scope={
          active?.file
            ? `◆ 全局会话 · 已锚定 ${basename(active.file)}:${active.line} · read-only sandbox`
            : props.pendingRef
              ? `◆ 全局会话 · 引用 ${props.pendingRef.label} · read-only sandbox`
              : '◆ 全局会话 · read-only sandbox'
        }
        onSend={props.onSend}
      />
    </div>
  );
}

function MessageBubble({
  role,
  name,
  meta,
  text,
}: {
  role: 'agent' | 'user';
  name: string;
  meta?: string;
  text: string;
}) {
  return (
    <div className="msg">
      <span className={`av ${role}`}>{role === 'agent' ? '◆' : '你'}</span>
      <div className="body">
        <div className="nm">
          <b className={role === 'agent' ? 'agent-name' : 'human-name'}>{name}</b>
          {meta && <span className="t mono">{meta}</span>}
        </div>
        <div className={`bubble${role === 'agent' ? ' agent' : ''}`}>{text}</div>
      </div>
    </div>
  );
}
