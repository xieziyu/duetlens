import { useEffect, useState } from 'react';
import type { Finding, FindingProposal } from '@shared/domain';
import type { ReplyStream } from '../../review/useReviewStream';
import { clock, ScanActivityFeed, ScanLiveRow, useElapsed } from './ScanActivity';
import { CopyButton } from './CopyButton';
import { renderMarkdown, trimDanglingMarks } from './markdown';
import { ProposalCard } from './ProposalCard';
import { stripIpcWrapper } from './round-error';

/**
 * 一问在途时的那一格。它**不是**答案之外另开的进度条 —— 就是答案将要出现的那个气泡,
 * 从排队一路演进到落定,DOM 位置不换,所以文字到齐的那一刻屏上不跳。
 *
 * 四个阶段各答一个不同的问题:
 *   排队中 —— 还没轮到它(前面压着扫描或上一问);
 *   取证中 —— 它在读哪个文件、搜什么(实测追问中位要等 12.6s,而正文只占最后几秒,
 *             这一段过去只有三个点);
 *   回复中 —— 正文逐段到货;
 *   已中断 —— 失败或被叫停,已出的半句定格保留但不落库。
 */
export interface LiveReplyProps {
  /** 已起跑的流;为空即还排在队里 */
  stream: ReplyStream | null;
  /** 这一轮已经提出、还没挂上消息的回写提案(工具调用先于回复文本) */
  proposals?: FindingProposal[];
  findingOf?: (p: FindingProposal) => Finding | null;
  onApplyProposal?: (id: string) => Promise<unknown>;
  onSkipProposal?: (id: string) => Promise<unknown>;
  onUndoProposal?: (id: string) => Promise<unknown>;
  /** 叫停这一问;只在已起跑且未中断时给 */
  onStop?: () => Promise<unknown>;
}

export function LiveReply({
  stream,
  proposals,
  findingOf,
  onApplyProposal,
  onSkipProposal,
  onUndoProposal,
  onStop,
}: LiveReplyProps) {
  // 中断的那条钟要停住:还在往上走的计时等于说它还在跑
  const ticking = useElapsed(stream && !stream.interrupted ? stream.startedAt : null);
  const elapsed = stream?.interrupted ? (stream.endedAt ?? stream.startedAt) - stream.startedAt : ticking;
  const acts = stream?.activity.items ?? [];
  const streaming = !!stream && !stream.interrupted;

  const label = !stream
    ? '排队中'
    : stream.interrupted
      ? '已中断'
      : stream.text
        ? '回复中'
        : acts.length > 0
          ? '取证中'
          : '思考中';

  return (
    <div className="msg live-reply">
      <span className="av agent">◆</span>
      <div className="body">
        <div className="nm">
          <b className="agent-name">agent</b>
          <span className="t">{label}</span>
          {stream && <span className="lr-clock mono">{clock(elapsed)}</span>}
          {streaming && onStop && <StopButton onStop={onStop} />}
          {/* 中断的残文哪儿都没落库,离了屏就再也拿不回来 —— 复制是它唯一的出口。
              在途期间不给:那时正文还在长,复制到的是半截的半截。 */}
          {stream?.interrupted && stream.text && <CopyButton text={stream.text} />}
        </div>

        {stream && acts.length > 0 && (
          <ReplyActivity
            activity={acts}
            since={stream.startedAt}
            /* 正文一开始出,动作行就该让位 —— 此后要看的是答案,动作退成一枚可展开的角标 */
            compact={!!stream.text}
          />
        )}

        <div className="bubble agent">
          {stream?.text ? (
            <div className="c-prose">
              {/* 流式期把末行未闭合的行内标记藏起来,免得同一行字先以字面出现再变形 */}
              {renderMarkdown(streaming ? trimDanglingMarks(stream.text) : stream.text)}
            </div>
          ) : (
            <span className="typing">
              <i /> <i /> <i />
            </span>
          )}
        </div>

        {stream?.interrupted && (
          <div className="lr-cut">
            回复在此中断,<b>这半句没有落库</b> —— 换个问法再问一次即可。
          </div>
        )}

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

/**
 * 这一问期间 agent 的动作。收起态在出字前显示「它此刻在做什么」(与机审进度条同一份派生),
 * 出字后只留一枚角标 —— 展开的才是完整动作流。
 */
function ReplyActivity({
  activity,
  since,
  compact,
}: {
  activity: ReplyStream['activity']['items'];
  since: number;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`lr-act${compact ? ' compact' : ''}`}>
      <button
        className="lr-act-head"
        onClick={() => setOpen((v) => !v)}
        title="这一问期间 agent 读了什么、搜了什么"
      >
        <span className="lr-caret">{open ? '▾' : '▸'}</span>
        取证 {activity.length} 步
      </button>
      {open ? (
        <ScanActivityFeed activity={activity} since={since} className="lr-feed" />
      ) : (
        !compact && <ScanLiveRow activity={activity} coverage={null} />
      )}
    </div>
  );
}

/**
 * 叫停这一问。失败要就地回显 —— 打断有真的停不下来的分支(turn id 还没到手 /
 * agent 压根不给 id,见 ReviewSession.stopReply),静默失败会让人一直按。
 */
function StopButton({ onStop }: { onStop: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await onStop();
    } catch (e) {
      setError(stripIpcWrapper((e as Error).message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="lr-stop" disabled={busy} onClick={() => void run()} title="停止这一问">
        ■ {busy ? '停止中…' : '停止'}
      </button>
      {error && <span className="lr-stop-err">{error}</span>}
    </>
  );
}

const noop = async (): Promise<void> => undefined;
