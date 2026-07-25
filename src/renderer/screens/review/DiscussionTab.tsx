import { useEffect, useMemo, useRef, useState } from 'react';
import type { Discussion, Finding, Message } from '@shared/domain';
import { Composer } from './Composer';
import { renderMarkdown } from './markdown';

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
  /** 清空当前 discussion 的往来消息(finding 卡保留),重开讨论 */
  onClearMessages: (discussionId: string) => void;
}

/** 一条 discussion 的展示标题:finding 用其标题,user 用首条消息 / 兜底文案 */
function titleOf(d: Discussion, findingByDisc: Map<string, Finding>, msgs: Message[]): string {
  const f = findingByDisc.get(d.id);
  if (f) return f.title;
  const firstUser = msgs.find((m) => m.role === 'user');
  return firstUser ? firstUser.text.slice(0, 40) : 'reviewer 发起的讨论';
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
            ? '扫描进行中,agent 会实时上报 findings。你也可以框选左侧代码直接向 agent 提问,无需等待。'
            : '还没有讨论。框选左侧代码或点一条 finding,开始与 agent 讨论。'}
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

          {active.kind === 'user' && !rootFinding && (
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
              />
            ))}
            {awaitingReply === active.id && (
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
          </div>
        </>
      ) : (
        <div className="thread thread-empty">
          <p className="empty-note">
            {props.pendingRef
              ? '已引用选区,输入你的问题向 agent 发起讨论。'
              : '从上方选择一条讨论查看对话。'}
          </p>
        </div>
      )}

      <Composer
        refLabel={props.pendingRef?.label ?? null}
        onRemoveRef={props.onClearRef}
        disabled={!active && !props.pendingRef}
        placeholder="追问 agent…"
        scope="◆ read-only sandbox · agent 仅阅读代码,不会改动"
        onSend={props.onSend}
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
}: {
  role: 'agent' | 'user';
  name: string;
  meta?: string;
  text: string;
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
      </div>
    </div>
  );
}
