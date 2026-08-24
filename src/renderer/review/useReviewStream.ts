import { useCallback, useEffect, useRef, useState } from 'react';
import type { Discussion, Finding, FindingProposal, Message, Review, ReviewRound } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import type { AgentEvent, TokenUsage } from '@shared/agent-events';
import {
  appendNote,
  pushActivity,
  EMPTY_ACTIVITY_LOG,
  type ActivityLog,
} from '../screens/review/scan-activity';
import { subscribeReviewEvents } from './review-event-bus';

/**
 * 一条追问在途(或刚中断)的回复。它是**未落库**的:turn 收尾成功后由权威 message 事件接手,
 * 中断的那份只留在屏上 —— 落库会让半句话被下一轮追问的历史回顾原样重述。
 */
export interface ReplyStream {
  /**
   * 本地稳定 id。turnId 顶不了这个用 —— 起跑那刻它还是空串,而这时已经要拿 key 渲染了。
   */
  id: string;
  /**
   * 这一问对应的 turn;delta 与收尾按它对号入座。**起跑那一刻还是空串** ——
   * 起跑报的是出队,而 id 要到 turn/start 应答才有,故空串一律当「还不知道」处理。
   */
  turnId: string;
  /** 已到的正文;起跑但还没出字时为空串 */
  text: string;
  startedAt: number;
  /**
   * 这一问在途期间 agent 的动作。与机审动作流分开存:合在一起的话,「本轮改动文件已读 N/M」
   * 会被讨论期读的文件顶高,而那个分母计的是**那一轮机审**取证到哪儿了。
   */
  activity: ActivityLog;
  /**
   * **这一问**产生的回写提案 id。不能拿「还没挂上消息」当判据 —— 上一问若空回复 / 失败 /
   * 被叫停,它的提案永远挂不上消息(见 ReviewSession.bindProposals),照那个判据会被算成
   * 这一问的产出,挂在一句它没说过的话下面,而卡片是真会改 finding 的。
   */
  proposalIds: string[];
  /** 失败或被叫停:文字定格保留,不再有后续 delta */
  interrupted: boolean;
  /** 定格于哪一刻。计时器必须在这里停住 —— 一个不断往上走的钟等于说它还在跑。 */
  endedAt?: number;
}

export interface ReviewStreamState {
  review: Review | null;
  findings: Finding[];
  discussions: Discussion[];
  /** 结构化 diff;首帧拉取,scan 期已落库故立即可得 */
  diff: DiffFile[];
  /**
   * diff 请求是否已回。**空 diff(无改动的分支)也算 ready** —— 不能用 `diff.length > 0`
   * 代替加载态,否则零改动的 review 会永远停在"拉取 diff"阶段。
   */
  diffReady: boolean;
  /** 按 discussionId 聚合的消息(user/agent),随 message 事件增量追加 */
  messages: Record<string, Message[]>;
  /**
   * 一条讨论的回复流,按起跑先后排。**至多一条在途**(turn 是串行的),其余都是失败 / 被叫停后
   * 定格的残文 —— 存成列表而不是一条,是因为后者会被下一问的起跑就地顶掉:
   * 卡上写着「换个问法再问一次即可」,照做那一下恰好把它抹了,而它哪儿都没落库。
   */
  streams: Record<string, ReplyStream[]>;
  /** agent 在讨论里提出的回写提案(含已落定的,它们是改动来由的凭据) */
  proposals: FindingProposal[];
  status: Review['status'] | null;
  /** 轮次履历(首轮 + 每次重跑);末条即当前轮 */
  rounds: ReviewRound[];
  tokenUsage: TokenUsage | null;
  lastTool: string | null;
  /**
   * 本轮 agent 的动作(读了哪个文件、搜了什么、报了哪条 finding)+ 累计取证路径。
   * 与 lastTool / tokenUsage 同一套换轮语义:开新轮即清空,它描述的是**这一轮**在做什么。
   */
  activity: ActivityLog;
  /**
   * agent 正在自行退避重试(codex 内部重试,可静默耗掉几十秒)。count 是本轮数到的次数;
   * 一轮结束(round 事件)即清空。
   */
  retrying: { count: number; error: string } | null;
  /** 懒加载一条 discussion 的历史消息(续接的旧 review);实时消息仍走事件流。 */
  ensureMessages: (discussionId: string) => void;
  /** 乐观插入一条本地 user 消息(立即上屏),权威 message 事件到达时按文本去重替换;返回临时 id。 */
  addPendingMessage: (discussionId: string, text: string) => string;
  /** 移除一条消息(发送失败时清理乐观占位)。 */
  dropMessage: (discussionId: string, id: string) => void;
}

type Streams = Record<string, ReplyStream[]>;

/** 这条讨论正在跑的那一条;至多一条(turn 串行),没有则 null。 */
export function liveReplyOf(list: readonly ReplyStream[] | undefined): ReplyStream | null {
  return list?.find((s) => !s.interrupted) ?? null;
}

/** 换掉一条讨论的整份列表;空列表即摘掉这个键,不存在时原样返回(省一次重渲染)。 */
function putStreams(prev: Streams, discussionId: string, next: ReplyStream[]): Streams {
  if (next.length === 0) {
    if (!prev[discussionId]) return prev;
    const out = { ...prev };
    delete out[discussionId];
    return out;
  }
  return { ...prev, [discussionId]: next };
}

/**
 * 穷尽性哨兵:ReviewEvent 的分支被全部消费时,参数才是 never —— 新增一支而漏处理即编译失败。
 * 运行时只告警不抛:main 比 renderer 新时(热更/回滚)收到未知事件应静默跳过,而非崩掉整条事件流。
 */
function assertExhaustive(e: never): void {
  console.warn('[review-stream] 未处理的 review 事件', e);
}

/**
 * 订阅一次 review 的 server-state:先拉初值,再随 IPC review:event 增量更新。
 * 前端不臆造权威数据,只反映后端推来的领域事件(见 docs/design/architecture.md 状态分层)。
 */
export function useReviewStream(reviewId: string | null): ReviewStreamState {
  const [review, setReview] = useState<Review | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [diff, setDiff] = useState<DiffFile[]>([]);
  const [diffReady, setDiffReady] = useState(false);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [streams, setStreams] = useState<Streams>({});
  const streamSeq = useRef(0);
  const newStream = useCallback(
    (turnId = '', text = ''): ReplyStream => ({
      id: `s-${streamSeq.current++}`,
      turnId,
      text,
      startedAt: Date.now(),
      activity: EMPTY_ACTIVITY_LOG,
      proposalIds: [],
      interrupted: false,
    }),
    [],
  );
  /**
   * 正在跑的那条追问。agent 事件流本身不带讨论归属,而 turn 是串行的(见 ReviewSession.turnChain),
   * 故「此刻有没有一条追问在跑」就足以给这段时间里的动作定归属。
   */
  const activeReply = useRef<{ discussionId: string } | null>(null);
  const [proposals, setProposals] = useState<FindingProposal[]>([]);
  const [status, setStatus] = useState<Review['status'] | null>(null);
  const [rounds, setRounds] = useState<ReviewRound[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [lastTool, setLastTool] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityLog>(EMPTY_ACTIVITY_LOG);
  const [retrying, setRetrying] = useState<ReviewStreamState['retrying']>(null);
  // 已发起过历史拉取的 discussionId,避免重复 fetch(实时消息由事件流补充)
  const fetched = useRef<Set<string>>(new Set());

  const ensureMessages = useCallback(
    (discussionId: string) => {
      if (!reviewId || fetched.current.has(discussionId)) return;
      fetched.current.add(discussionId);
      void window.duetlens.review.messages(discussionId).then((list) => {
        if (list.length === 0) return;
        setMessages((prev) => {
          const bucket = prev[discussionId] ?? [];
          const seen = new Set(bucket.map((m) => m.id));
          const merged = [...bucket, ...list.filter((m) => !seen.has(m.id))];
          merged.sort((a, b) => a.createdAt - b.createdAt);
          return { ...prev, [discussionId]: merged };
        });
      });
    },
    [reviewId],
  );

  const pendingSeq = useRef(0);
  const addPendingMessage = useCallback((discussionId: string, text: string): string => {
    const id = `pending-${pendingSeq.current++}`;
    const msg: Message = { id, discussionId, role: 'user', text, createdAt: Date.now() };
    setMessages((prev) => ({ ...prev, [discussionId]: [...(prev[discussionId] ?? []), msg] }));
    return id;
  }, []);

  const dropMessage = useCallback((discussionId: string, id: string) => {
    setMessages((prev) => {
      const bucket = prev[discussionId];
      if (!bucket) return prev;
      return { ...prev, [discussionId]: bucket.filter((m) => m.id !== id) };
    });
  }, []);

  useEffect(() => {
    if (!reviewId) return;
    let alive = true;
    // 切 review 必须把**全部** review-scoped state 打回初值:reviewId 可在组件不卸载的情况下变
    // (点另一条 review 的完成通知 → App 只换 prop),漏清的字段会让新 review 的首批 IPC 返回前
    // 短暂顶着上一条的 status/轮次/findings 渲染 —— 进度头会把旧 review 明确展示成当前审核。
    setReview(null);
    setStatus(null);
    setFindings([]);
    setDiscussions([]);
    setRounds([]);
    setTokenUsage(null);
    setLastTool(null);
    setActivity(EMPTY_ACTIVITY_LOG);
    setRetrying(null);
    setMessages({});
    setStreams({});
    activeReply.current = null;
    setProposals([]);
    setDiff([]);
    setDiffReady(false);
    fetched.current = new Set();

    // 失败也要把 diffReady 落定:否则进度永远停在"拉取 diff",且锚点写操作被一直锁住
    const loadDiff = () => {
      void window.duetlens.review
        .diff(reviewId)
        .then((d) => {
          if (!alive) return;
          setDiff(d);
          setDiffReady(true);
        })
        .catch(() => alive && setDiffReady(true));
    };

    void window.duetlens.review.get(reviewId).then((r) => {
      if (alive) {
        setReview(r);
        setStatus(r?.status ?? null);
      }
    });
    void window.duetlens.review.findings(reviewId).then((f) => alive && setFindings(f));
    void window.duetlens.review.discussions(reviewId).then((d) => alive && setDiscussions(d));
    void window.duetlens.review.proposals(reviewId).then((p) => alive && setProposals(p));
    loadDiff();
    void window.duetlens.review.rounds(reviewId).then((r) => alive && setRounds(r));

    // switch + 兜底哨兵:ReviewEvent 新增一支而这里漏处理,编译期即报错(见 assertExhaustive)
    // 过滤交给事件总线:多 tab 各挂一份 onEvent 会在同一条 IPC 频道上堆到告警线(见 review-event-bus)
    const off = subscribeReviewEvents(reviewId, (e) => {
      switch (e.type) {
        case 'finding': {
          // upsert:新 finding 追加,已存在的(update_finding 回写)就地替换
          const f = e.payload;
          setFindings((prev) => {
            const i = prev.findIndex((x) => x.id === f.id);
            if (i < 0) return [...prev, f];
            const next = prev.slice();
            next[i] = f;
            return next;
          });
          return;
        }
        case 'discussion': {
          // upsert:新 discussion 追加,已存在的(如 promote 后 kind 变更)就地替换
          const d = e.payload;
          setDiscussions((prev) => {
            const i = prev.findIndex((x) => x.id === d.id);
            if (i < 0) return [...prev, d];
            const next = prev.slice();
            next[i] = d;
            return next;
          });
          return;
        }
        case 'message': {
          const m = e.payload;
          setMessages((prev) => {
            const bucket = prev[m.discussionId] ?? [];
            if (bucket.some((x) => x.id === m.id)) return prev;
            // 权威 user 消息到达:替换掉同文本的乐观占位(pending-*),避免重复
            const cleaned =
              m.role === 'user'
                ? bucket.filter((x) => !(x.id.startsWith('pending-') && x.text === m.text))
                : bucket;
            return { ...prev, [m.discussionId]: [...cleaned, m] };
          });
          // 权威回复接手,在途那份就地退场 —— 同批提交,不会有一帧两个气泡。
          // **只摘在途的**:定格的残文属于更早那一问,与这条回复无关。
          if (m.role === 'agent')
            setStreams((prev) => {
              const list = prev[m.discussionId];
              if (!list) return prev;
              const next = list.filter((s) => s.interrupted);
              return next.length === list.length ? prev : putStreams(prev, m.discussionId, next);
            });
          return;
        }
        case 'finding-proposal': {
          // upsert:新提案追加,落定(applied/skipped)或回挂 messageId 后就地替换
          const p = e.payload;
          // 在途期间产生的记到这一问名下,好让它只挂在**产生它的**那条回复下
          if (activeReply.current?.discussionId === p.discussionId)
            setStreams((prev) => {
              const list = prev[p.discussionId] ?? [];
              const i = list.findIndex((x) => !x.interrupted);
              if (i < 0 || list[i].proposalIds.includes(p.id)) return prev;
              const next = list.slice();
              next[i] = { ...next[i], proposalIds: [...next[i].proposalIds, p.id] };
              return putStreams(prev, p.discussionId, next);
            });
          setProposals((prev) => {
            const i = prev.findIndex((x) => x.id === p.id);
            if (i < 0) return [...prev, p];
            const next = prev.slice();
            next[i] = p;
            return next;
          });
          return;
        }
        case 'messages-cleared': {
          const { discussionId } = e;
          setMessages((prev) => (prev[discussionId] ? { ...prev, [discussionId]: [] } : prev));
          // 定格的中断残文也一并清掉:它挂在这条线程上,清空讨论就该连它一起
          setStreams((prev) => putStreams(prev, discussionId, []));
          return;
        }
        case 'reply-started': {
          const { discussionId } = e;
          activeReply.current = { discussionId };
          setStreams((prev) => {
            const list = prev[discussionId] ?? [];
            // 上一条按说已经收过尾。真漏了也不能让它挡着新的那条:有字就定格留下,没字才丢。
            const kept = list.flatMap((s) =>
              s.interrupted ? [s] : s.text ? [{ ...s, interrupted: true, endedAt: Date.now() }] : [],
            );
            return putStreams(prev, discussionId, [...kept, newStream()]);
          });
          return;
        }
        case 'reply-delta': {
          const { discussionId, turnId, text } = e;
          // 起跑事件可能落在本组件挂载之前(中途切走再切回来),据此把动作归属补回来
          activeReply.current = { discussionId };
          setStreams((prev) => {
            const list = prev[discussionId] ?? [];
            const i = list.findIndex((x) => !x.interrupted);
            // 起跑事件必然在前(runTurn 出队即报),漏了也别把正文丢掉
            if (i < 0) return putStreams(prev, discussionId, [...list, newStream(turnId, text)]);
            const cur = list[i];
            // 空串 = id 还没到手,认下即可;后端只会把属于这一问的 delta 喂进来(见 isMine)
            if (cur.turnId && cur.turnId !== turnId) return prev;
            const next = list.slice();
            next[i] = { ...cur, turnId, text: cur.text + text };
            return putStreams(prev, discussionId, next);
          });
          return;
        }
        case 'reply-ended': {
          const { discussionId, turnId, outcome } = e;
          if (activeReply.current?.discussionId === discussionId) activeReply.current = null;
          setStreams((prev) => {
            const list = prev[discussionId];
            // 一个字都没出的那一问,stream 上的 id 仍是空串 —— 按不匹配丢掉就再也清不干净
            const i =
              list?.findIndex((x) => !x.interrupted && (!x.turnId || x.turnId === turnId)) ?? -1;
            if (!list || i < 0) return prev;
            const next = list.slice();
            // 落定的交给权威 message;一个字都没出的中断也没什么可留,失败原因由 replyFailure 说
            if (outcome === 'ok' || !next[i].text) next.splice(i, 1);
            else next[i] = { ...next[i], interrupted: true, endedAt: Date.now() };
            return putStreams(prev, discussionId, next);
          });
          return;
        }
        case 'round': {
          // upsert:开轮时插入,收轮时(带统计)就地替换
          const r = e.payload;
          setRounds((prev) => {
            const i = prev.findIndex((x) => x.round === r.round);
            if (i < 0) return [...prev, r].sort((a, b) => a.round - b.round);
            const next = prev.slice();
            next[i] = r;
            return next;
          });
          // 开新一轮(status=scanning 的 round 事件每轮只发一次):上一轮的 agent 运行态与 diff
          // 都不再代表当前轮 —— 每轮换新 codex thread(上下文重新计)且后端已重拉 diff 落库,
          // 不清掉的话新轮一起步就顶着旧 token/工具调用,进度会直接跳过"建立会话"阶段。
          if (r.status === 'scanning') {
            setTokenUsage(null);
            setLastTool(null);
            setActivity(EMPTY_ACTIVITY_LOG);
            setRetrying(null);
            setDiffReady(false);
            loadDiff();
          }
          // 收轮(成功或失败)也要清重试提示:那是"正在挣扎"的态,轮次已落定就不该再挂着
          if (r.status !== 'scanning') setRetrying(null);
          // 开新一轮会改 review.currentRound,重拉一次让轮次角标与后端一致
          void window.duetlens.review.get(reviewId).then((rv) => rv && setReview(rv));
          return;
        }
        case 'review':
          setReview(e.payload);
          setStatus(e.payload.status);
          return;
        case 'status':
          setStatus(e.payload);
          return;
        case 'agent':
          // agent 流是 firehose,只挑要上屏的几支;其余 kind 有意不处理
          applyAgentEvent(e.payload);
          return;
        case 'selfcheck-skipped':
          // 跳过条件是「没有待裁的条目」而非「一条 finding 都没有」(已剔除 / 已结案的不算),
          // 且首轮与复审轮都会触发 —— 文案两头都不能写死。
          setActivity((prev) => appendNote(prev, '本轮无待裁 finding,已跳过对抗自检轮', Date.now()));
          return;
        default:
          assertExhaustive(e);
      }
    });

    function applyAgentEvent(ev: AgentEvent): void {
      // token 是整条 thread 的账,不分轮次归属
      if (ev.kind === 'token-usage')
        setTokenUsage({ used: ev.used, cumulative: ev.cumulative, total: ev.total });
      if (ev.kind === 'tool-call') setLastTool(`${ev.server}/${ev.tool} · ${ev.status}`);
      const now = Date.now();
      const live = activeReply.current;
      if (live) {
        // 追问在跑:这段时间里的动作属于那条讨论,不并进机审动作流 ——
        // 并进去的话「本轮改动文件已读 N/M」会被讨论期读的文件顶高,而那个分母计的是机审。
        const note =
          ev.kind === 'turn-retrying' ? `agent 正在自行重试:${ev.error}` : null;
        setStreams((prev) => {
          const list = prev[live.discussionId] ?? [];
          const i = list.findIndex((x) => !x.interrupted);
          if (i < 0) return prev;
          const cur = list[i];
          const activity = note
            ? appendNote(cur.activity, note, now)
            : pushActivity(cur.activity, ev, now);
          if (activity === cur.activity) return prev;
          const next = list.slice();
          next[i] = { ...cur, activity };
          return putStreams(prev, live.discussionId, next);
        });
        return;
      }
      // 动作流自己认哪些 kind 该上屏(工具调用 / shell 命令 / web 检索),这里不重复判别
      setActivity((prev) => pushActivity(prev, ev, now));
      // codex 不上报第几次重试,只说"还会再试";次数由我们数事件得出
      if (ev.kind === 'turn-retrying')
        setRetrying((prev) => ({ count: (prev?.count ?? 0) + 1, error: ev.error }));
      if (ev.kind === 'turn-completed' || ev.kind === 'turn-failed') setRetrying(null);
    }

    return () => {
      alive = false;
      off();
    };
  }, [reviewId]);

  return {
    review,
    findings,
    discussions,
    diff,
    diffReady,
    messages,
    streams,
    proposals,
    status,
    rounds,
    tokenUsage,
    lastTool,
    activity,
    retrying,
    ensureMessages,
    addPendingMessage,
    dropMessage,
  };
}
