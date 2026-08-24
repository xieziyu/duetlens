import { EventEmitter } from 'node:events';
import { isProposalUndoBlocked, REVIEW_RETENTION_MS, scanDoneStatus } from '@shared/domain';
import type {
  CodexModelInfo,
  Discussion,
  Finding,
  FindingProposal,
  Message,
  ProposalBefore,
  ProposalStatus,
  ProposalTriageBefore,
  ProposalUpdateBefore,
  Review,
  ReviewIntensity,
  ReviewRound,
  ReviewUiState,
  Triage,
  UiSettings,
} from '@shared/domain';
import type { AgentErrorKind } from '@shared/agent-events';
import { changedFilesBetween, parseUnifiedDiff, type DiffFile } from '@shared/diff';
import type { AddFindingInput, BusyReview, DiffStatInput, FindingEditInput, LatestDiffResult, LiveCapacity, RecentReview, RerunInput, ReviewEvent, ReviewStartStage, SubmitReviewInput, SubmitReviewResult } from '@shared/ipc';
import { LIVE_SESSION_LIMIT_CODE, SANDBOX_NOT_APPLIED_CODE } from '@shared/ipc';
import { isCodexProtocolError } from '@shared/codex';
import type { PromptSaveInput, ReviewPromptView } from '@shared/prompt';
import { buildPrReviewPayload, hasAnchor, isSubmittable, submitBlocker } from '@shared/github-review';
import type { McpContentProviders } from '../mcp/duetlens-mcp-server';
import type { ReviewStore } from '../db/review-store';
import { CodexAgent } from '../agent/codex/codex-agent';
import { loadBaseInstructions, loadReviewPrompt, saveReviewLayer } from '../prompt/review-prompt';
import { buildRerunPrompt } from '../prompt/rerun-prompt';
import { createSource } from '../source/create-source';
import { fetchPrContextForReview } from '../source/github-pr-context';
import { checkEnvironment } from '../env/environment-check';
import type { EnvCheckOptions, EnvironmentReport } from '@shared/environment';
import { setToolPath } from '../config/tool-paths';
import type { ReviewTarget, Source } from '../source/source';
import {
  checkGhAuth,
  diffStat,
  getRepoRemote,
  prBaseChain,
  inferLocalRepo,
  inspectRepo,
  listLocalBranches,
  listOpenPrs,
  previewPr,
} from '../source/source-discovery';
import type {
  DiffStat,
  LocalBranchList,
  PrAncestor,
  PrPreview,
  PrSummary,
  RepoInspection,
  RepoRemoteInfo,
} from '@shared/source-discovery';
import { GhReviewSubmitter, type GitHubSubmitter } from './github-submitter';
import { AgentTurnError, DEFAULT_SCAN_PROMPT, ReviewSession, type ReviewSessionEvents } from './review-session';

/**
 * 已提交到 GitHub 的 finding,正文类字段锁定。UI 早就按这条画(卡片的 `writable` 排除 submitted),
 * 但提案是条**没有界面把关**的写路径 —— 不在权威层拦一道,本地记录会与已发出去的评论对不上。
 *
 * 只锁内容,不锁裁决:剔除/恢复是 reviewer 对「这条要不要继续追」的判断,
 * 已提交的追评项照样可以剔(见 findings-submit.md)。
 */
function assertContentWritable(f: Finding, action: string): void {
  if (f.submission === 'submitted')
    throw new Error(`这条 finding 已提交到 GitHub,内容已锁定,无法${action}对它的修改提案。`);
}

/**
 * 只拍这次应用**真正改动过**的那几个字段的旧值。
 * 拍全量的话,撤销会把应用之后 reviewer 自己的编辑一并回滚 —— 提案只降了个 severity,
 * 撤销却连带把他重写过的正文换回旧版。
 *
 * 按前后值比,而不是按 patch 点名的键:改写正文会连带清掉复核说明与过时的 suggestion、
 * 并把正文轮次推到本轮(见 ReviewStore.updateFinding),这几下没人点名,却同样要能撤回来。
 */
function snapshotPatched(before: Finding, after: Finding): ProposalUpdateBefore {
  const snapshot: ProposalUpdateBefore = {};
  if (after.severity !== before.severity) snapshot.severity = before.severity;
  if (after.category !== before.category) snapshot.category = before.category;
  if (after.title !== before.title) snapshot.title = before.title;
  if (after.body !== before.body) snapshot.body = before.body;
  if (after.suggestion !== before.suggestion) snapshot.suggestion = before.suggestion;
  if (after.resolutionNote !== before.resolutionNote) snapshot.resolutionNote = before.resolutionNote;
  if (after.bodyRound !== before.bodyRound) snapshot.bodyRound = before.bodyRound;
  return snapshot;
}

/**
 * 由持久化的 review 反推 source 定位。**baseRef 必须一并带上** —— 漏掉它,复审与续接会
 * 回到该 source 的默认基线,同一条 review 的第二轮起就换了一份改动面。
 */
function targetOf(review: Review): ReviewTarget {
  return {
    source: review.source,
    ref: review.sourceRef,
    baseRef: review.baseRef ?? undefined,
    repoPath: review.repoPath ?? '',
  };
}

/** 首轮扫描指令:有附加上下文时拼在缺省指令之后一并注入,否则用缺省。 */
function buildScanPrompt(context?: string): string | undefined {
  const ctx = context?.trim();
  if (!ctx) return undefined;
  return `${DEFAULT_SCAN_PROMPT}\n\n用户附加上下文(审核时一并考虑):\n${ctx}`;
}

/**
 * 活跃会话已满且**全在跑** —— 再起一个就得拆掉别人跑到一半的那轮。
 *
 * 消息里嵌 {@link LIVE_SESSION_LIMIT_CODE}:Electron IPC 只把 reject 的 message 串过去,
 * 自定义字段一律丢失,renderer 认这一段字符串才认得出「是满载,不是别的失败」。
 * 在跑的是哪几条由 renderer 回头问 `review.capacity()`,不塞进消息。
 */
export class LiveSessionLimitError extends Error {
  constructor(
    readonly busy: BusyReview[],
    readonly max: number,
  ) {
    super(
      `${LIVE_SESSION_LIMIT_CODE} 已有 ${busy.length} 个审核会话正在跑(上限 ${max}),` +
        '先等一个结束、或叫停其中一个再发起。',
    );
    this.name = 'LiveSessionLimitError';
  }
}

/**
 * 会话还在建的途中,这条 review 被释放 / 删除了(见 {@link ReviewManager.teardown})。
 * 建到一半的会话与 source 就地收掉,这个错误只负责告诉发起方「本次作废」。
 */
class SessionReleasedError extends Error {
  constructor(reviewId: string, reason = '审核会话已释放') {
    super(`${reason},本次请求作废: ${reviewId}`);
    this.name = 'SessionReleasedError';
  }
}

// 演示用内置 fixture(source 层接好前,让 app 能端到端跑一遍真实审核)。
/**
 * session 事件 → IPC ReviewEvent 的转发表。写成 keyof 映射而非一串 `session.on(...)`:
 * ReviewSessionEvents 新增一条事件却忘了在这里转发,编译期即报缺属性
 * (agent finding 的承载 discussion 就漏发过一次,整个 Discussion 栏因此是空的)。
 */
const SESSION_FORWARDERS: {
  [K in keyof ReviewSessionEvents]: (reviewId: string, payload: ReviewSessionEvents[K]) => ReviewEvent;
} = {
  review: (reviewId, payload) => ({ reviewId, type: 'review', payload }),
  finding: (reviewId, payload) => ({ reviewId, type: 'finding', payload }),
  discussion: (reviewId, payload) => ({ reviewId, type: 'discussion', payload }),
  message: (reviewId, payload) => ({ reviewId, type: 'message', payload }),
  'finding-proposal': (reviewId, payload) => ({ reviewId, type: 'finding-proposal', payload }),
  status: (reviewId, payload) => ({ reviewId, type: 'status', payload }),
  'agent-event': (reviewId, payload) => ({ reviewId, type: 'agent', payload }),
  'reply-started': (reviewId, payload) => ({ reviewId, type: 'reply-started', ...payload }),
  'reply-delta': (reviewId, payload) => ({ reviewId, type: 'reply-delta', ...payload }),
  'reply-ended': (reviewId, payload) => ({ reviewId, type: 'reply-ended', ...payload }),
  'selfcheck-skipped': (reviewId, payload) => ({
    reviewId,
    type: 'selfcheck-skipped',
    reason: payload.reason,
  }),
};

/**
 * 冷启动收尾用的失败原因(见 {@link ReviewManager.failInterruptedRounds})。
 * 说的是这条 review 自己身上发生过的事实,不借 agent 的口气,也不塞英文错误码。
 */
const ROUND_INTERRUPTED_BY_EXIT =
  '上次退出 Duetlens 时这一轮机审还在跑,进程结束后就中断了 —— 不是 agent 报的错。';

/**
 * 轮次失败的落库形态。turn 失败带得到 agent 归因;编排层自己抛的(source/网络/gh)只有原文,
 * 归到 'other' —— 宁可不分类,也不按 message 猜。
 */
export function describeRoundFailure(cause: unknown): {
  errorMessage: string;
  errorKind: AgentErrorKind;
} {
  if (cause instanceof AgentTurnError) return { errorMessage: cause.detail, errorKind: cause.errorKind };
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  // 建会话阶段抛的是普通 Error(没有 turn,也就没有 codexErrorInfo 可映射)。不在这里认出来的话,
  // 这两类都落成 'other' —— 文案泛泛,还带 retryable,把用户往「再试一次」上引,而这两类重试必然复现。
  const kind: AgentErrorKind = message.includes(SANDBOX_NOT_APPLIED_CODE)
    ? 'sandbox-not-applied'
    : isCodexProtocolError(message)
      ? 'codex-version-mismatch'
      : 'other';
  return { errorMessage: message || '未知错误', errorKind: kind };
}

/**
 * main 侧 review 编排入口:持久化 + 活跃 ReviewSession,把领域事件归一成 IPC ReviewEvent 外发。
 * IPC 层订阅本类 'review-event' 转发到 renderer(见 backend/ipc)。
 */
export class ReviewManager extends EventEmitter {
  /** 活跃会话;按 Map 插入序当 LRU,访问时 touch 到队尾。 */
  private readonly sessions = new Map<string, ReviewSession>();
  /** source 等随会话存活的清理钩子;续问要读文件,故不在扫描结束时释放,延到 dispose。 */
  private readonly cleanups = new Map<string, () => void | Promise<void>>();
  /** 活跃会话的内容 provider(读 diff / 文件新侧);供 DiffPane 展开上下文按审核时快照读文件。 */
  private readonly providers = new Map<string, McpContentProviders>();
  /** 在途的会话续接;同一 review 的并发追问共用一次,见 {@link resumeSession}。 */
  private readonly resuming = new Map<string, Promise<ReviewSession>>();
  /**
   * 各 review 被 teardown 过的次数,即会话的「代次」。用于作废 teardown 期间在途的会话构建,
   * 见 {@link teardownEpoch}。不清理:代次归零会让在途的旧代次重新对上,反而放它登记回来。
   */
  private readonly teardowns = new Map<string, number>();
  private readonly maxLiveSessions: number;
  /** 已预留、会话还没建出来的位子数,见 {@link reserveCapacity}。 */
  private pendingSessions = 0;
  /** 进程收尾中:{@link disposeAll} 起,一律不再登记新会话。 */
  private shuttingDown = false;
  /** GitHub 提交层;可注入(spike 用假实现,不烧真 PR)。 */
  private readonly submitter: GitHubSubmitter;
  /** 正在提交的 review;PR review 是原子提交,并发两份就是把同一批评论发给作者两遍。 */
  private readonly submitting = new Set<string>();

  constructor(
    private readonly store: ReviewStore,
    private readonly codexHome?: string,
    opts?: { maxLiveSessions?: number; submitter?: GitHubSubmitter },
  ) {
    super();
    // 每个活跃会话 = 一个 codex 子进程 + MCP server;上限避免长时运行泄漏进程。
    this.maxLiveSessions = opts?.maxLiveSessions ?? 4;
    this.submitter = opts?.submitter ?? new GhReviewSubmitter();
    this.applyToolPaths(this.store.getUiSettings());
  }

  /** 把设置里的 codex / gh 路径覆盖同步到进程内解析器(exec 与 codex 启动据此取二进制)。 */
  private applyToolPaths(s: UiSettings): void {
    setToolPath('codex', s.codexPath);
    setToolPath('gh', s.ghPath);
  }

  listReviews(): Review[] {
    return this.store.listReviews();
  }

  /** 最近审核列表(附 finding/discussion/已提交计数);入口页展示用。 */
  listRecentReviews(): RecentReview[] {
    return this.store.listRecentReviews();
  }

  /** 首启环境自检(codex / app-server / gh);沿用本 manager 的 codexHome。 */
  checkEnvironment(opts?: EnvCheckOptions): Promise<EnvironmentReport> {
    return checkEnvironment({ codexHome: this.codexHome, deep: opts?.deep });
  }

  // ---- 入口发起页的来源发现(只读预检/列举,不进入 review 生命周期)----
  checkGhAuth(): Promise<boolean> {
    return checkGhAuth();
  }

  previewPr(ref: string, repoPath?: string): Promise<PrPreview> {
    return previewPr(ref, repoPath);
  }

  listOpenPrs(opts: { nwo?: string; repoPath?: string }): Promise<PrSummary[]> {
    return listOpenPrs(opts);
  }

  getRepoRemote(repoPath: string): Promise<RepoRemoteInfo> {
    return getRepoRemote(repoPath);
  }

  /** 由 PR owner/repo 反推本机 clone 路径,以历史审核用过的仓库路径为优先候选。 */
  inferLocalRepo(nwo: string): Promise<string | null> {
    return inferLocalRepo(nwo, this.store.listRepoPaths());
  }

  listLocalBranches(repoPath: string, baseRef?: string): Promise<LocalBranchList> {
    return listLocalBranches(repoPath, baseRef);
  }

  inspectRepo(repoPath: string): Promise<RepoInspection> {
    return inspectRepo(repoPath);
  }

  /** 被审 PR 的祖先链(stacked PR 的形状);非 stacked 只有一环。 */
  prBaseChain(ref: string, repoPath?: string): Promise<PrAncestor[]> {
    return prBaseChain(ref, repoPath);
  }

  /** 按所选 base 现算改动面(入口切 base 后刷新计量)。 */
  diffStat(input: DiffStatInput): Promise<DiffStat> {
    return diffStat({
      source: input.source,
      ref: input.ref,
      baseRef: input.baseRef,
      repoPath: input.repoPath ?? '',
    });
  }

  listRepoPaths(limit?: number): string[] {
    return this.store.listRepoPaths(limit);
  }

  getReview(id: string): Review | null {
    return this.store.getReview(id);
  }

  getFindings(reviewId: string): Finding[] {
    return this.store.listFindings(reviewId);
  }

  getDiscussions(reviewId: string): Discussion[] {
    return this.store.listDiscussions(reviewId);
  }

  getMessages(discussionId: string): Message[] {
    return this.store.listMessages(discussionId);
  }

  /** 本次改动的结构化 diff(供 DiffPane 渲染);未缓存时返回空。 */
  getDiff(reviewId: string): DiffFile[] {
    const raw = this.store.getRawDiff(reviewId);
    return raw ? parseUnifiedDiff(raw) : [];
  }

  /**
   * 现拉一次最新 diff 并与本轮审核的 head 比对。**不写库** —— 审核时的 diff 快照是
   * findings 锚点与 diff 屏的共同基准,推进它是复审(rerun)的职责;这里只为提交屏
   * 判定「哪条行锚点已不在最新改动上」(GitHub 的 422 不告知是哪条)提供实时依据。
   */
  async getLatestDiff(reviewId: string): Promise<LatestDiffResult> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    // **github-pr 这里刻意不带 base**:本函数的第一用途是预判 GitHub 会不会 422,而 GitHub 的
    // 判据永远是「这条锚点在不在这个 PR 自己的 diff 里」。审核时选了更宽的 base 的话,带上它
    // 拉回来的正是那份更宽的 diff —— 于是每条锚在下层 PR 上的 finding 都会被判成有效,
    // 而它们恰恰是提交时唯一会被拒的那批。
    const source = createSource(
      review.source === 'github-pr' ? { ...targetOf(review), baseRef: undefined } : targetOf(review),
    );
    try {
      const prepared = await source.prepare();
      const raw = await source.getDiff();
      const headSha = prepared.headSha ?? null;
      const roundSha = this.store.getRound(reviewId, review.currentRound)?.headSha ?? null;
      return {
        ok: true,
        diff: parseUnifiedDiff(raw),
        headSha,
        headMoved: Boolean(headSha && roundSha && headSha !== roundSha),
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await source.dispose();
    }
  }

  /**
   * 读被审文件新侧完整内容(DiffPane 展开 diff 外上下文)。
   * 活跃会话在场时用其 source(读的是审核时快照);否则按持久化 target 临时重建 source 读一次。
   */
  /**
   * 三处建 MCP providers 的共用装配。
   * searchCode 随 source 有无而定(github-pr 无本地代码树,缺省即让 MCP 不声明该工具);
   * findingFile 走库而非内存 —— 复审轮要裁决的是上一轮报的条目,不在本次会话的 findings 里。
   */
  private buildProviders(
    reviewId: string,
    source: Source,
    getDiff: () => string | Promise<string>,
  ): McpContentProviders {
    return {
      getDiff,
      getFile: (p) => source.getFile(p),
      searchCode: source.searchCode ? (input) => source.searchCode!(input) : undefined,
      findingFile: (id) => {
        // **必须限定本 review**:两条 review 并存时 agent 给出的 id 未必是自己这条的,
        // 不限定的话裁决会写到另一次审核的 finding 上(路径重名时连取证闸都挡不住)。
        const f = this.store.getFinding(id);
        return f && f.reviewId === reviewId ? f.file : null;
      },
    };
  }

  async getFileContent(reviewId: string, filePath: string): Promise<string | null> {
    const live = this.providers.get(reviewId);
    if (live) {
      this.touch(reviewId);
      // source.getFile 现在读不到就抛(取证闸要求可分);这条路是给 DiffPane 展开上下文用的,
      // 读不到回 null 就是它一直以来的语义,别把异常透到 IPC 去。
      try {
        return await live.getFile(filePath);
      } catch {
        return null;
      }
    }
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    const source = createSource(targetOf(review));
    try {
      await source.prepare();
      return await source.getFile(filePath);
    } catch {
      return null; // 同上:这条路读不到就是 null
    } finally {
      await source.dispose();
    }
  }

  /** 新建一条用户发起的 discussion(不落 finding);anchor 省略即不锚定代码的全局讨论。 */
  addUserDiscussion(
    reviewId: string,
    anchor?: { file: string; line: number; lineEnd?: number | null } | null,
  ): Discussion {
    const discussion = this.store.addUserDiscussion(reviewId, anchor);
    this.forward({ reviewId, type: 'discussion', payload: discussion });
    return discussion;
  }

  /**
   * 把一条用户 discussion 提升为 finding(origin=promoted),保留其会话历史。
   * 默认标题/正文取该讨论首条 user 消息(截断),严重度默认 medium,留待用户就地编辑。
   */
  promoteDiscussion(reviewId: string, discussionId: string): Finding {
    const firstUser = this.store.listMessages(discussionId).find((m) => m.role === 'user');
    const title = firstUser ? firstUser.text.slice(0, 60) : '待补充标题';
    const finding = this.store.promoteDiscussion(discussionId, {
      severity: 'medium',
      title,
      body: firstUser?.text ?? '',
    });
    this.forward({ reviewId, type: 'finding', payload: finding });
    const updated = this.store.getDiscussion(discussionId);
    if (updated) this.forward({ reviewId, type: 'discussion', payload: updated });
    return finding;
  }

  /**
   * 用户裁决某条 finding(保留/剔除/复位);落库后经事件流回推。
   * 剔除可带理由 —— 下一轮复审会把它注入,让 agent 明白为何不算问题、不再报同类。
   */
  setTriage(reviewId: string, findingId: string, triage: Triage, reason?: string | null): Finding {
    this.store.setTriage(findingId, triage, reason);
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new Error(`finding 不存在: ${findingId}`);
    this.forward({ reviewId, type: 'finding', payload: finding });
    return finding;
  }

  /** 一次 review 名下的全部回写提案(进 review 屏时随讨论一起拉)。 */
  getProposals(reviewId: string): FindingProposal[] {
    return this.store.listProposals(reviewId);
  }

  /**
   * 采纳一条 agent 提案:按 kind 走既有的落库路径(与用户手动操作同一条),
   * 并把旧值记进提案供「↩ 撤销」还原。
   *
   * 剔除刻意**不**记 autoClosed —— 那一格的语义是「复核判定代码里已经没有了」,
   * 而这里是 reviewer 看过 agent 的论证后点的头,属他自己的判断,下一轮不该被回归逻辑翻掉
   * (见 isAutoClosedFixed)。理由存 agent 的原话,照常注入下一轮复审。
   */
  applyProposal(reviewId: string, proposalId: string): FindingProposal {
    const p = this.requireProposal(reviewId, proposalId);
    if (p.status === 'applied') return p;

    // finding 的改动与提案的落定必须同进同退:分两次提交的话,第二步一挂就留下
    // 「finding 已改、卡片还写着待确认」的半状态,重试还会拿这个错误现状去拍新快照。
    // 事件一律等事务提交后再发 —— 回滚掉的改动不该先一步上屏。
    const written = this.store.transaction(() => {
      if (p.kind === 'create') {
        const input = p.patch;
        // 提案出自哪条讨论就落在哪条:另起一条新讨论会把这段论证过程与 finding 拆散。
        // 但只在**同一个文件**上才提升 —— 锚到别处的提案与这条讨论无关,提升会把它挂错地方。
        const disc = this.store.getDiscussion(p.discussionId);
        const promotable = disc?.kind === 'user' && disc.file === input.file && disc.line != null;
        const finding = promotable
          ? this.store.promoteDiscussion(p.discussionId, {
              severity: input.severity,
              category: input.category ?? null,
              title: input.title,
              body: input.body,
              suggestion: input.suggestion ?? null,
            })
          // 这条是 agent 在追问轮提出、reviewer 采纳后才落库的 —— 报出它的是 followup turn。
          // 不传就会和迁移前的未知存量一样留 NULL,把真实的追问产出混进「无从判断」那一堆。
          : this.store.addFinding(reviewId, input, 'agent', undefined, 'followup');
        // promoteDiscussion 用的是 discussion 的行号,而卡片上写的是提案里的 —— agent 常会在
        // 框选范围内给出更准的一行。以卡片所示为准,否则采纳到手的锚点和看到的不是一个。
        // 只在提案给了真实行号时改:setFindingAnchor 的 0 是「脱锚降级为摘要」(见 anchorDropped),
        // 而 report_finding 的 schema 允许 line=0,照传就会把一条新 finding 直接降级掉。
        if (promotable && input.line > 0 && finding.line !== input.line)
          this.store.setFindingAnchor(finding.id, input.line);
        const created = this.store.getFinding(finding.id) ?? finding;
        return {
          finding: created,
          discussion: this.store.getDiscussion(created.discussionId),
          proposal: this.resolveProposal(proposalId, 'applied', { findingId: created.id }),
        };
      }

      const before = this.store.getFinding(p.findingId);
      if (!before) throw new Error(`finding 不存在: ${p.findingId}`);
      if (p.kind === 'update') {
        assertContentWritable(before, '应用');
        this.store.updateFinding({ findingId: p.findingId, ...p.patch });
      } else {
        this.store.setTriage(
          p.findingId,
          p.kind === 'dismiss' ? 'dismiss' : 'open',
          p.kind === 'dismiss' ? p.patch.reason : null,
        );
      }
      const after = this.store.getFinding(p.findingId);
      const before_ =
        p.kind === 'update'
          ? snapshotPatched(before, after ?? before)
          : { triage: before.triage, dismissReason: before.dismissReason, autoClosed: before.autoClosed };
      return {
        finding: after,
        discussion: null,
        proposal: this.resolveProposal(proposalId, 'applied', { before: before_ }),
      };
    });
    return this.publish(reviewId, written);
  }

  /**
   * 忽略一条提案:只落定去向,不碰 finding。卡片留在对话里,之后仍可重新应用。
   *
   * 已应用的必须走 {@link undoProposal}:在这里直接标成 skipped 的话,改动仍留在 finding 里,
   * 卡片却写着「已忽略」并给出「重新应用」—— 那一下还会把已经被它改过的当前值拍成新快照,
   * 从此撤销回的是它自己写下的东西,留痕与撤销一起失真。
   */
  skipProposal(reviewId: string, proposalId: string): FindingProposal {
    const p = this.requireProposal(reviewId, proposalId);
    if (p.status === 'applied')
      throw new Error('该提案已应用,要收回改动请点「撤销」,不能直接标为已忽略。');
    // 只落定提案自己,没有 finding 侧的写,单条 UPDATE 本身即原子
    const next = this.resolveProposal(proposalId, 'skipped');
    this.forward({ reviewId, type: 'finding-proposal', payload: next });
    return next;
  }

  /**
   * 撤销一条已采纳的提案:按落库的旧值还原,提案退回「已忽略」(仍可重新应用)。
   * create 无从撤销 —— 新建的 finding 由用户自己剔除/删除,别在这里替他决定。
   */
  undoProposal(reviewId: string, proposalId: string): FindingProposal {
    const p = this.requireProposal(reviewId, proposalId);
    if (p.status !== 'applied' || p.kind === 'create' || !p.before || !p.findingId)
      throw new Error('该提案无法撤销');
    const written = this.store.transaction(() => {
      const current = this.store.getFinding(p.findingId);
      // 应用之后又被改过就不再撤:撤销写的是应用前的旧值,那会把后来的判断一起顶掉,
      // 而这既不是提案的功劳也不是他要的。要回退就手动改,别在这里替他做主。
      if (isProposalUndoBlocked(p, current))
        throw new Error('这条 finding 在应用之后又被改过,撤销会覆盖那次改动 —— 请手动调整。');
      if (p.kind === 'update') {
        if (current) assertContentWritable(current, '撤销');
        // 快照只含该提案动过的字段,所以这一还原不会碰 reviewer 在应用之后自己改的其他字段
        // 逐字写回,不借 updateFinding —— 那条路会把这次回滚当成一次新的正文改写,
        // 顺手清掉应用之后新写下的复核说明(见 ReviewStore.restoreFinding)
        this.store.restoreFinding(p.findingId, p.before as ProposalUpdateBefore);
      } else {
        // 走 restoreTriage 而非 setTriage:后者会把 auto_closed 清零,复核自动结案的条目
        // 撤销后就变成「reviewer 亲手剔的」,下一轮回归不再自动恢复
        this.store.restoreTriage(p.findingId, p.before as ProposalTriageBefore);
      }
      return {
        finding: this.store.getFinding(p.findingId),
        discussion: null,
        proposal: this.resolveProposal(proposalId, 'skipped'),
      };
    });
    return this.publish(reviewId, written);
  }

  private requireProposal(reviewId: string, proposalId: string): FindingProposal {
    const p = this.store.getProposal(proposalId);
    if (!p) throw new Error(`提案不存在: ${proposalId}`);
    // 串号会把改动写到另一条 review 名下的 finding 上,两边数据都被污染(同 sendMessage 的校验)
    if (p.reviewId !== reviewId) throw new Error(`提案不属于本次审核: ${proposalId}`);
    return p;
  }

  /** 落定提案状态(纯写,不发事件)—— 调用方在事务内用它,提交后再统一外发。 */
  private resolveProposal(
    proposalId: string,
    status: ProposalStatus,
    opts: { before?: ProposalBefore; findingId?: string } = {},
  ): FindingProposal {
    const next = this.store.setProposalStatus(proposalId, status, opts);
    if (!next) throw new Error(`提案不存在: ${proposalId}`);
    return next;
  }

  /** 事务提交之后再把这一批改动外发。回滚掉的东西不该先一步上屏。 */
  private publish(
    reviewId: string,
    written: { finding: Finding | null; discussion: Discussion | null; proposal: FindingProposal },
  ): FindingProposal {
    if (written.finding) this.forward({ reviewId, type: 'finding', payload: written.finding });
    if (written.discussion)
      this.forward({ reviewId, type: 'discussion', payload: written.discussion });
    this.forward({ reviewId, type: 'finding-proposal', payload: written.proposal });
    return written.proposal;
  }

  /**
   * 用户手动新增一条锚定 finding(origin=manual):与 agent finding 同 schema、同提交路径,
   * 并建承载 discussion(可后续追问)。外发 finding + discussion 事件。
   */
  addManualFinding(reviewId: string, input: AddFindingInput): Finding {
    const finding = this.store.addFinding(
      reviewId,
      {
        severity: input.severity,
        category: input.category ?? undefined,
        title: input.title,
        body: input.body ?? '',
        file: input.file,
        line: input.line,
        suggestion: input.suggestion ?? undefined,
      },
      'manual',
    );
    this.forward({ reviewId, type: 'finding', payload: finding });
    const discussion = this.store.getDiscussion(finding.discussionId);
    if (discussion) this.forward({ reviewId, type: 'discussion', payload: discussion });
    return finding;
  }

  /** 用户就地编辑 finding 可编辑字段(与 codex update_finding 共用 store 路径)。 */
  updateFinding(reviewId: string, input: FindingEditInput): Finding {
    const finding = this.store.updateFinding({
      findingId: input.findingId,
      severity: input.severity,
      // null 要原样透到 store(清空 category),压成 undefined 就成了「不改」
      category: input.category,
      title: input.title,
      body: input.body,
      suggestion: input.suggestion,
    });
    if (!finding) throw new Error(`finding 不存在: ${input.findingId}`);
    this.forward({ reviewId, type: 'finding', payload: finding });
    return finding;
  }

  /**
   * 改一条 finding 的行锚点(提交屏处理 422 失效锚点):line>0 改锚到新行,line=0 脱锚
   * (降级为 review 摘要评论)。落库后外发 `finding` 事件。
   */
  setFindingAnchor(reviewId: string, findingId: string, line: number): Finding {
    this.store.setFindingAnchor(findingId, line);
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new Error(`finding 不存在: ${findingId}`);
    this.forward({ reviewId, type: 'finding', payload: finding });
    return finding;
  }

  /**
   * 把待提交的 findings(未提交的 + 欠一条复核追评的)组成一次 GitHub PR review 原子提交。
   * 成功后记下提交轮次(增量:下次只发新的 delta 与新的复核追评);失败/被拒不改任何状态。
   */
  async submitReview(reviewId: string, input: SubmitReviewInput): Promise<SubmitReviewResult> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    if (review.source !== 'github-pr') {
      return { status: 'failed', message: '仅 github-pr source 可提交到 GitHub;本地/vbranch 请用导出。' };
    }
    // 待提交集在请求发出前就定稿,`submitted` 要等 gh 返回才落库 —— 这段窗口里再进来一次,
    // 读到的是同一份 pending,于是同样的评论发第二遍。守在这里而不是屏上:提交在途照样能
    // 离开提交屏(顶栏返回、rail 导航),屏一卸载本地的 in-flight 状态就没了。
    if (this.submitting.has(reviewId)) {
      return { status: 'failed', message: '这条 review 正在提交中,等它结束再试(别重复发给作者)。' };
    }
    this.submitting.add(reviewId);
    try {
      const pending = this.store.listFindings(reviewId).filter((f) => isSubmittable(f, review.currentRound));

      // suggestion 要按锚定行补齐缩进(见 alignSuggestion),而 GitHub 是拿 PR head 套这条补丁的
      // —— 基准只能是 head 上的那一行。审核快照会错两次:作者调过这行的缩进,或 reviewer 已按
      // 最新 diff 重锚(那个行号在快照里指向的是另一行)。提交屏预览也用最新 diff,取它才对得上。
      // 没有带 suggestion 的行评论时不拉:摘要条目不带补丁,空手 Approve 更不该为此
      // 多一次网络往返和一处失败面。
      let anchorDiff: DiffFile[] = [];
      let anchorSha: string | null = null;
      if (pending.some((f) => f.suggestion && hasAnchor(f))) {
        const latest = await this.getLatestDiff(reviewId);
        // 拉不到就**不补**,而不是退回快照:快照里的同一个行号可能已指向别的行(reviewer 按最新
        // diff 重锚过),据它补出来的缩进是凭空捏的。捏错比不补更伤,而拿不到基准就不该猜。
        if (latest.ok) {
          anchorDiff = latest.diff;
          // sha 必须跟着 diff 一起走:提交层据它钉 commit_id,免得再独立读一次 head
          anchorSha = latest.headSha;
        }
      }

      // 无 finding 也可提交:Comment/Approve/Request changes 本身就是表态
      const payload = buildPrReviewPayload(
        review,
        pending,
        input.event,
        input.body ?? '',
        anchorDiff,
        anchorSha,
      );
      const blocked = submitBlocker(payload);
      if (blocked) return { status: 'failed', message: blocked };
      const result = await this.submitter.submit(review, payload);

      if (result.status === 'success') {
        for (const f of pending) {
          this.store.setSubmission(f.id, 'submitted', result.url, review.currentRound);
          const updated = this.store.getFinding(f.id);
          if (updated) this.forward({ reviewId, type: 'finding', payload: updated });
        }
        this.store.setReviewStatus(reviewId, 'submitted');
        this.forward({ reviewId, type: 'status', payload: 'submitted' });
      }
      return result;
    } finally {
      this.submitting.delete(reviewId);
    }
  }

  /** 清空一条 discussion 的往来消息(finding 卡与锚点保留),便于重新讨论。 */
  clearDiscussion(reviewId: string, discussionId: string): void {
    this.store.clearMessages(discussionId);
    this.forward({ reviewId, type: 'messages-cleared', discussionId });
  }

  /** 向某条 discussion 追问;会话不在内存时先按 codexThreadId 续接。 */
  async sendMessage(reviewId: string, discussionId: string, text: string): Promise<Message> {
    const session = this.sessions.get(reviewId) ?? (await this.resumeSession(reviewId));
    this.touch(reviewId);
    return session.sendMessage(discussionId, text);
  }

  /** 释放某个 review 的活跃会话(codex 子进程 + MCP + source);下次追问会自动续接。 */
  async disposeReview(reviewId: string): Promise<void> {
    await this.teardown(reviewId);
  }

  /** 删除一次审核:先释放活跃会话(子进程/MCP),再连同 findings/discussions 级联删库。 */
  async deleteReview(reviewId: string): Promise<void> {
    await this.teardown(reviewId);
    this.store.deleteReview(reviewId);
    // 第一次 teardown 释放会话要 await,那期间来的追问读到的还是删除前的行,会照常续接上来。
    // 再拆一次收掉它:此后新来的续接第一步就查不到 review,这条路到此为止。
    await this.teardown(reviewId);
  }

  /**
   * 清理超出保留窗口的历史,返回删掉的条数。只在启动、尚无活跃会话时调用 ——
   * 直接删库不经 teardown,运行中调用会把子进程/MCP 指向的行抽走。
   */
  pruneExpiredReviews(nowMs = Date.now()): number {
    return this.store.pruneReviewsBefore(nowMs - REVIEW_RETENTION_MS);
  }

  /**
   * 把上次进程留下的「还在扫描中」收掉(轮次判失败、父状态补齐),返回处理的条数。
   *
   * 只在启动、尚无活跃会话时调用 —— 会话是进程内的活物,此刻库里任何 scanning 都必然是
   * 上次退出时留下的,不必去猜它是否还在跑。这条判据同时要求进程唯一,故 main 在开库之前
   * 先拿单实例锁。收尾后当前轮是 failed,失败卡上的「重试本轮」即可接手
   * (见 {@link retryRound});已上报的 findings 一条不动。
   */
  failInterruptedRounds(): number {
    let settled = 0;
    for (const review of this.store.listReviews()) {
      const current = this.store.getRound(review.id, review.currentRound);
      const roundLeftScanning = current?.status === 'scanning';
      /**
       * 父记录还在说「扫描中」也要收:轮次与父状态是**两张表两次写**,而两条路径的写序还相反
       * —— 跑完是先写父状态(ReviewSession.runStart)后收轮次,收尾是先收轮次后写父状态。
       * 崩在任一个缝里都会留下一半,只看其中一边就会漏掉另一种。压根没有轮次记录的那种
       * (createReview 与紧随的 startRound 之间崩过、或轮次表存在之前的存量行)同样落在这一支。
       */
      const reviewLeftScanning = review.status === 'scanning';
      if (!roundLeftScanning && !reviewLeftScanning) continue;
      /** 父状态已经翻过去了 = 这一轮其实跑完了,只是 done 还没落库。 */
      const scanFinished = review.status !== 'scanning' && review.status !== 'failed';
      // 这一步跑在 IPC 注册与建窗之前,settleRound 外发的轮次事件此刻没有订阅者,落地即丢;
      // renderer 起来后首次拉取读到的就是收尾后的状态。
      if (current && roundLeftScanning)
        this.settleRound(
          review.id,
          current.round,
          // 哪边已经落定就拿哪边去补另一边:拿一句「中断」盖掉真跑完的那一轮,
          // 用户会看到一条已完成的 review 顶着中断原因和重试入口
          scanFinished ? 'done' : 'failed',
          scanFinished ? undefined : new Error(ROUND_INTERRUPTED_BY_EXIT),
        );
      if (reviewLeftScanning) {
        // 反过来:轮次已经跑完(done / stopped)、只差父状态没落的,按正常口径补 ——
        // 一律判失败等于把一轮真跑出了 findings 的机审说成失败。没有轮次记录的那种才是真失败。
        const roundFinished = !roundLeftScanning && current != null && current.status !== 'failed';
        this.store.setReviewStatus(review.id, roundFinished ? scanDoneStatus(review.source) : 'failed');
      }
      settled += 1;
    }
    return settled;
  }

  /** 显式续接一个非活跃 review 的会话(app 重启后);已活跃则原样返回。 */
  async resumeReview(reviewId: string): Promise<Review> {
    if (!this.sessions.has(reviewId)) await this.resumeSession(reviewId);
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    return review;
  }

  getUiSettings(): UiSettings {
    return this.store.getUiSettings();
  }

  saveUiSettings(settings: UiSettings): void {
    this.store.saveUiSettings(settings);
    this.applyToolPaths(settings);
  }

  getReviewUiState(reviewId: string): ReviewUiState {
    return this.store.getReviewUiState(reviewId);
  }

  saveReviewUiState(reviewId: string, state: ReviewUiState): void {
    this.store.saveReviewUiState(reviewId, state);
  }

  /** 列举账号可用 codex 模型(发起表单下拉);未登录/出错向上抛,前端降级为手填。 */
  async listModels(): Promise<CodexModelInfo[]> {
    const models = await CodexAgent.listModels({ codexHome: this.codexHome });
    return models.map((m) => ({
      model: m.model,
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      isDefault: m.isDefault,
    }));
  }

  /** 读三层审核规则提示词(project 层需仓库 cwd,缺省则只有 global+builtin)。 */
  getReviewPrompt(cwd?: string): Promise<ReviewPromptView> {
    return loadReviewPrompt({ cwd });
  }

  /** 整层重写某可编辑层,再回读合并后的最新视图返回给编辑器。 */
  async saveReviewPrompt(input: PromptSaveInput): Promise<ReviewPromptView> {
    await saveReviewLayer(input.layer, input.sections, { cwd: input.cwd });
    return loadReviewPrompt({ cwd: input.cwd });
  }

  /**
   * 起真实审核:按 target 建 source,拉元数据落库,后台跑首轮扫描。
   * onStage 逐阶段回调(入口等待浮层据此显示真实进度);拉取失败时不留下半张 review 记录。
   */
  async startReview(target: ReviewTarget, onStage?: (s: ReviewStartStage) => void): Promise<Review> {
    // 会话位在**建库记录之前**先占住,拿不到就直接回绝(下面的拉取一步都不做)。
    const release = this.reserveCapacity();
    const source = createSource(target);
    let review: Review | undefined;
    // launch 之后 source 的释放归它:成功挂在 session 的 cleanup 上(续问还要读文件),
    // 失败它自己的 catch 已经收过 —— 在这之前失败才该由我们收。
    let launched = false;
    try {
      onStage?.('resolve');
      const prepared = await source.prepare();
      // 预取 diff 落库:MCP 与 renderer 共用同一份,省 codex 侧一次 get_diff 往返。
      onStage?.('diff');
      const rawDiff = await source.getDiff();
      onStage?.('record');
      review = this.store.createReview({
        source: target.source,
        sourceRef: target.ref,
        baseRef: target.baseRef || null,
        repoPath: target.repoPath || null,
        title: prepared.title,
        model: target.model || null,
        reasoningEffort: target.reasoningEffort || null,
        intensity: target.intensity ?? 'standard',
      });
      this.store.setDiff(review.id, rawDiff);
      // 首轮也建轮次记录:轮次表是完整履历,复审只是往后追加,不是另一套东西。
      this.store.startRound(review.id, 1, { headSha: prepared.headSha, note: target.context });
      onStage?.('agent');
      const baseInstructions = await loadBaseInstructions({
        cwd: prepared.cwd,
        intensity: review.intensity,
        canSearch: !!source.searchCode,
      });
      launched = true;
      this.launch(review, prepared.cwd, this.buildProviders(review.id, source, () => rawDiff),
        () => source.dispose(), baseInstructions, buildScanPrompt(target.context), 1,
        // 这条 review 刚建出来,id 还没出过本方法,外部无从释放它;代次只能是初始值。
        this.teardownEpoch(review.id));
      return review;
    } catch (e) {
      // 预留兜不住的残余(判定后有空闲会话转忙,launch 仍开不出会话)也不能留下痕迹:
      // 这一轮一步都没跑过,留在库里就是一条用户当次看不见、也不知从何而来的失败审核。
      if (review) this.store.deleteReview(review.id);
      // source 还没交给任何清理钩子就失败了,自己收 —— github-pr 的 prepare 会开一个临时
      // checkout 目录,漏收就是每失败一次在 /tmp 里留一份。收不干净不能盖掉原始错误。
      if (!launched) await source.dispose().catch(() => undefined);
      throw e;
    } finally {
      release();
    }
  }

  /** 某次 review 的全部轮次履历(首轮 + 每次重跑)。 */
  getRounds(reviewId: string): ReviewRound[] {
    return this.store.listRounds(reviewId);
  }

  /**
   * 重跑一轮机审。每轮**新开 codex thread**、**重新拉取最新 diff 做全量重扫**,
   * 上一轮的产出与 reviewer 的处置靠结构化 prompt 带过来(见 prompt/rerun-prompt.ts)。
   * 立即返回新建的轮次记录,扫描在后台跑、findings 经事件流入。
   * onStage 逐阶段回调,同首次发起(重跑面板据此显示真实进度)。
   */
  async rerunReview(
    reviewId: string,
    input: RerunInput = {},
    onStage?: (s: ReviewStartStage) => void,
  ): Promise<ReviewRound> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    const current = this.store.getRound(reviewId, review.currentRound);
    if (current?.status === 'scanning') {
      throw new Error('上一轮扫描尚未结束,不能重跑');
    }

    // 本轮可调档:给出即持久化为 review 新档,使后续轮次与续接(追问的 baseInstructions)一致沿用。
    const intensity = input.intensity ?? review.intensity;
    if (input.intensity && input.intensity !== review.intensity) {
      this.store.setReviewIntensity(reviewId, input.intensity);
    }

    return this.launchRound(review, {
      round: review.currentRound + 1,
      note: input.note ?? null,
      intensity,
      onStage,
    });
  }

  /**
   * 中途叫停当前轮机审:打断 agent 的 turn,已上报的 findings 全部保留,
   * review 就地转入人工审核(状态与跑完一轮相同,可照常追问 / 重跑)。
   */
  async stopScan(reviewId: string): Promise<void> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    const current = this.store.getRound(reviewId, review.currentRound);
    if (current?.status !== 'scanning') throw new Error('本轮机审已结束,无需停止');
    const session = this.sessions.get(reviewId);
    if (!session) throw new Error('该 review 无活跃会话,无法停止');
    // 收轮仍走 launch 那条链(叫停后 start 照常 resolve),轮次与状态经事件回推
    await session.stopScan();
  }

  /**
   * 叫停某条讨论正在跑的那一问。不动轮次与 review 状态 —— 被停的只是一句追问,
   * 那一问的 user 消息照旧留在线程里(见 ReviewSession.sendMessage 的 stopped 分支)。
   */
  async stopReply(reviewId: string, discussionId: string): Promise<void> {
    const session = this.sessions.get(reviewId);
    if (!session) throw new Error('该 review 无活跃会话,无法停止');
    await session.stopReply(discussionId);
  }

  /**
   * 重试失败的当前轮:沿用**同一轮号**与原说明重跑,不新开一轮 ——
   * 失败那次没有任何产出,再给它一个轮号只会让「第 N 轮」变成重试计数。
   */
  async retryRound(reviewId: string): Promise<ReviewRound> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    const current = this.store.getRound(reviewId, review.currentRound);
    if (!current) throw new Error('该 review 无轮次记录,无法重试');
    if (current.status !== 'failed') throw new Error('当前轮次不是失败态,无需重试');

    return this.launchRound(review, {
      round: current.round,
      note: current.note,
      intensity: review.intensity,
      // 失败那次已经把最新 diff 写进快照,再比一次只会得出"无改动";变更文件沿用该轮已记的。
      priorChanged: current,
    });
  }

  /**
   * 起一轮机审(重跑与失败重试共用)。重新拉最新 diff 做全量重扫,上一轮的产出与 reviewer 的
   * 处置靠结构化 prompt 带过来(见 prompt/rerun-prompt.ts);首轮重试则回到扫描指令。
   */
  private async launchRound(
    review: Review,
    opts: {
      round: number;
      note: string | null;
      intensity: ReviewIntensity;
      /** 重试同一轮时,该轮首次开跑记下的变更文件基线 */
      priorChanged?: ReviewRound;
      onStage?: (s: ReviewStartStage) => void;
    },
  ): Promise<ReviewRound> {
    const reviewId = review.id;
    const prevRound = opts.round > 1 ? this.store.getRound(reviewId, opts.round - 1) : null;

    // 每轮新 thread:先彻底释放上一轮的会话、MCP 与 source,再重建。
    opts.onStage?.('resolve');
    await this.teardown(reviewId);
    // 代次在 teardown 之后取:本轮要作废的是这次拆完之后又来的释放/删除。
    const epoch = this.teardownEpoch(reviewId);
    // 刚腾出的位子立刻占住:下面还要 await 好几步拉取,期间被别的发起抢走的话,
    // 轮次已经落库、却只能收成一条莫名其妙的失败。
    const release = this.reserveCapacity();

    const source = createSource(targetOf(review));
    let round: ReviewRound;
    let prepared: Awaited<ReturnType<typeof source.prepare>>;
    let rawDiff: string;
    let prompt: string | undefined;
    let baseInstructions: string;
    try {
      prepared = await source.prepare();
      opts.onStage?.('diff');
      rawDiff = await source.getDiff();
      opts.onStage?.('record');
      const prevDiff = this.store.getRawDiff(reviewId);
      const changedFiles = [
        ...new Set([...(opts.priorChanged?.changedFiles ?? []), ...changedFilesBetween(prevDiff, rawDiff)]),
      ].sort();
      const codeChanged = Boolean(opts.priorChanged?.codeChanged) || prevDiff !== rawDiff;
      this.store.setDiff(reviewId, rawDiff);

      // gh 拉不到就是空上下文,不阻断复审(见 fetchPrContextForReview)
      const pr = review.source === 'github-pr' ? await fetchPrContextForReview(review) : null;

      const findings = this.store.listFindings(reviewId);
      const openFindings = findings.filter((f) => f.triage !== 'dismiss');
      const dismissedFindings = findings.filter((f) => f.triage === 'dismiss');
      const messagesByDiscussion: Record<string, Message[]> = {};
      for (const f of openFindings) {
        const msgs = this.store.listMessages(f.discussionId);
        if (msgs.length) messagesByDiscussion[f.discussionId] = msgs;
      }

      round = this.store.startRound(reviewId, opts.round, {
        headSha: prepared.headSha,
        note: opts.note,
        changedFiles,
        codeChanged,
      });
      prompt =
        round.round === 1
          ? // 首轮重试:那轮的 note 就是入口填的附加上下文
            buildScanPrompt(opts.note ?? undefined)
          : buildRerunPrompt({
              round: round.round,
              prevRound,
              headSha: prepared.headSha ?? null,
              changedFiles,
              codeChanged,
              openFindings,
              dismissedFindings,
              messagesByDiscussion,
              pr: pr && pr.fetchedAt ? pr : null,
              note: opts.note,
            });
      opts.onStage?.('agent');
      baseInstructions = await loadBaseInstructions({
        cwd: prepared.cwd,
        intensity: opts.intensity,
        canSearch: !!source.searchCode,
      });
    } catch (e) {
      release();
      await source.dispose();
      throw e;
    }
    const intensity = opts.intensity;

    try {
      this.launch(
        { ...review, currentRound: round.round, intensity },
        prepared.cwd,
        this.buildProviders(review.id, source, () => rawDiff),
        () => source.dispose(),
        baseInstructions,
        prompt,
        round.round,
        epoch,
      );
    } finally {
      release();
    }
    this.forward({ reviewId, type: 'round', payload: round });
    return round;
  }

  /**
   * 建 session、接事件、后台跑一轮机审(首轮与重跑共用)。
   * `epoch` 要在本轮**第一个 await 之前**取,见 {@link teardownEpoch}。
   */
  private launch(
    review: Review,
    cwd: string,
    providers: McpContentProviders,
    onDone: (() => void | Promise<void>) | undefined,
    baseInstructions: string | undefined,
    scanPrompt: string | undefined,
    round: number,
    epoch: number,
  ): void {
    let session: ReviewSession;
    try {
      session = this.createSession(review.id, onDone, epoch);
    } catch (e) {
      // 起不出会话(预留之后又有空闲会话转忙,连一个可逐出的都不剩;或这条 review 已被释放)。
      // 轮次已经落库,必须就地收成 failed 并带上原因,否则它会永远挂在「扫描中」。
      this.settleRound(review.id, round, 'failed', e);
      this.forward({ reviewId: review.id, type: 'status', payload: 'failed' });
      void Promise.resolve(onDone?.()).catch(() => undefined);
      throw e;
    }
    this.providers.set(review.id, providers);
    // 不 await:扫描后台跑,调用方(IPC)立即返回。source 清理延到 dispose,续问仍能读文件。
    session
      .start({
        cwd,
        providers,
        baseInstructions,
        scanPrompt,
        model: review.model,
        reasoningEffort: review.reasoningEffort,
        intensity: review.intensity,
        round,
      })
      .then(
        () => {
          this.settleRound(review.id, round, session.isStopped() ? 'stopped' : 'done');
          // 父状态压在收轮之后写:两次写库同一个写序(失败路径亦然),崩在缝里只会留下
          // 「轮次已终态、父记录仍 scanning」这一种,冷启动据轮次结果反推即可。
          // 反过来写就分不清这一轮是跑完还是被叫停 —— 两者的父状态是同一个终态。
          const status = scanDoneStatus(review.source);
          this.store.setReviewStatus(review.id, status);
          this.forward({ reviewId: review.id, type: 'status', payload: status });
        },
        (e: unknown) => {
          this.settleRound(review.id, round, 'failed', e);
          this.forward({ reviewId: review.id, type: 'status', payload: 'failed' });
          // 会话根本没建起来(如握手时的只读校验被拒):它已入表却永远用不了,还攥着
          // codex 子进程、MCP server、source 与一个 live 名额。就地拆,别等 LRU 或用户手动释放。
          // 释放本身再失败也不能盖掉上面已落库的原始失败,更不能变成进程级 unhandled rejection
          if (!session.isOpen()) void this.teardown(review.id).catch(() => undefined);
        },
      );
  }

  /**
   * 收一轮:统计本轮新增/判定已修复的条数落库(抑制数在命中时已累加),并外发轮次事件。
   * 失败必须连原因一起落库 —— 只记一个 'failed' 状态,用户就只能看到一句「失败」而无从追问。
   */
  private settleRound(
    reviewId: string,
    round: number,
    status: 'done' | 'failed' | 'stopped',
    cause?: unknown,
  ): void {
    const findings = this.store.listFindings(reviewId);
    const finished = this.store.finishRound(reviewId, round, status, {
      newFindings: findings.filter((f) => f.round === round).length,
      fixedCount: findings.filter((f) => f.lastSeenRound === round && f.resolution === 'fixed').length,
      ...(status === 'failed' ? describeRoundFailure(cause) : {}),
    });
    if (finished) this.forward({ reviewId, type: 'round', payload: finished });
  }

  /**
   * 续接会话,同一 review 的并发调用共用同一次续接。
   *
   * 不去重的话,两条并行追问会各建一个 ReviewSession / codex 子进程去恢复同一个 thread:
   * 后建的覆盖 map,两个 turn 就不再串在同一条链上;任一次失败的清理还会把另一次
   * 已登记的会话从 map 里删掉(子进程与 source 无人释放)。
   */
  private resumeSession(reviewId: string): Promise<ReviewSession> {
    const inflight = this.resuming.get(reviewId);
    if (inflight) return inflight;
    const started = this.startResume(reviewId).finally(() => {
      if (this.resuming.get(reviewId) === started) this.resuming.delete(reviewId);
    });
    this.resuming.set(reviewId, started);
    return started;
  }

  /** 按持久化的 target 重建 source 并续接 codex thread(会话已不在内存)。 */
  private async startResume(reviewId: string): Promise<ReviewSession> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    if (!review.codexThreadId) throw new Error(`review 无 codex thread,无法续接: ${reviewId}`);

    const epoch = this.teardownEpoch(reviewId);
    const source = createSource(targetOf(review));
    const prepared = await source.prepare();
    const baseInstructions = await loadBaseInstructions({
      cwd: prepared.cwd,
      intensity: review.intensity,
      canSearch: !!source.searchCode,
    });
    let session: ReviewSession;
    try {
      session = this.createSession(reviewId, () => source.dispose(), epoch);
    } catch (e) {
      await source.dispose(); // 建不出会话(如满载/已被释放)时 source 还没交给任何清理钩子,自己收
      throw e;
    }
    const providers = this.buildProviders(reviewId, source, () => source.getDiff());
    this.providers.set(reviewId, providers);
    try {
      await session.resume({
        cwd: prepared.cwd,
        providers,
        baseInstructions,
        model: review.model,
        reasoningEffort: review.reasoningEffort,
      });
      // 续 thread 也是一段 await:期间被释放/删除的话,teardown 拆的是我们这个会话,
      // 但它拆完我们还在跑,收尾一律走下面的清理,别把一个已作废的会话交给追问。
      if (this.teardownEpoch(reviewId) !== epoch) throw new SessionReleasedError(reviewId);
    } catch (e) {
      // 只摘自己登记的那份:teardown 之后可能已有新一代会话就位,别顺手把它删了。
      if (this.sessions.get(reviewId) === session) {
        this.sessions.delete(reviewId);
        this.cleanups.delete(reviewId);
        this.providers.delete(reviewId);
      }
      await session.dispose();
      await source.dispose();
      throw e;
    }
    return session;
  }

  /**
   * 取当前会话代次。**任何 await 之前**取一次,交给 {@link createSession} 在登记时对账 ——
   * 从这里到登记之间隔着好几步拉取(续接要 prepare source,复审还要拉最新 diff),
   * 期间到来的 disposeReview / deleteReview 看不见一个还没登记的会话,只能靠代次作废它。
   */
  private teardownEpoch(reviewId: string): number {
    return this.teardowns.get(reviewId) ?? 0;
  }

  /** 建 ReviewSession、登记清理钩子、把领域事件转成 IPC ReviewEvent 外发。 */
  private createSession(
    reviewId: string,
    onDispose: (() => void | Promise<void>) | undefined,
    epoch: number,
  ): ReviewSession {
    // 退出途中不再登记:disposeAll 已经拆过一遍,这时候建出来的会话没人再来收,
    // 它开的 codex 子进程会活过 app 本身(见 main 的 before-quit)。
    if (this.shuttingDown) throw new SessionReleasedError(reviewId, '应用正在退出');
    // 代次已变:这条 review 在我们准备的途中被释放/删除了。登记回去就再没人来拆它 ——
    // codex 子进程活到进程退出,deleteReview 的话还指着一批已经没有的行。
    if (this.teardownEpoch(reviewId) !== epoch) throw new SessionReleasedError(reviewId);
    this.evictExcess();
    const agent = new CodexAgent({ codexHome: this.codexHome });
    const session = new ReviewSession(reviewId, this.store, agent);
    this.sessions.set(reviewId, session);
    if (onDispose) this.cleanups.set(reviewId, onDispose);

    const wire = <K extends keyof ReviewSessionEvents>(name: K): void => {
      session.on(name, (payload) => this.forward(SESSION_FORWARDERS[name](reviewId, payload)));
    };
    for (const name of Object.keys(SESSION_FORWARDERS) as (keyof ReviewSessionEvents)[]) wire(name);
    return session;
  }

  /** 把会话移到 LRU 队尾(标记最近使用)。 */
  private touch(reviewId: string): void {
    const s = this.sessions.get(reviewId);
    if (s) {
      this.sessions.delete(reviewId);
      this.sessions.set(reviewId, s);
    }
  }

  /**
   * 腾出一个会话位:逐出最久未用的**空闲**会话(teardown 同步先删 map,while 收敛)。
   * 忙碌会话一律避让 —— 拆掉它等于替用户打断一轮正在跑的机审,那一轮只会以一句
   * 莫名其妙的失败收场。全都在忙就抛 {@link LiveSessionLimitError},由上层告诉用户。
   */
  private evictExcess(): void {
    while (this.sessions.size >= this.maxLiveSessions) {
      const idle = [...this.sessions.entries()].find(([, s]) => !s.isBusy())?.[0];
      if (!idle) throw new LiveSessionLimitError(this.busyReviews(), this.maxLiveSessions);
      void this.teardown(idle).catch(() => undefined);
    }
  }

  /** 当前正忙(agent 有在途 turn)的 review 摘要,供容量提示逐条列出。 */
  busyReviews(): BusyReview[] {
    const out: BusyReview[] = [];
    for (const [reviewId, session] of this.sessions) {
      if (!session.isBusy()) continue;
      const review = this.store.getReview(reviewId);
      out.push({
        reviewId,
        title: review?.title ?? review?.sourceRef ?? reviewId,
        sourceRef: review?.sourceRef ?? '',
        source: review?.source ?? 'local-branch',
        round: review?.currentRound ?? 1,
        scanning: this.store.getRound(reviewId, review?.currentRound ?? 1)?.status === 'scanning',
      });
    }
    return out;
  }

  /** 并发容量快照(入口据此提前给出感知,不必等发起失败)。 */
  getLiveCapacity(): LiveCapacity {
    return { max: this.maxLiveSessions, live: this.sessions.size, busy: this.busyReviews() };
  }

  /**
   * 占住一个会话位,满载则抛 {@link LiveSessionLimitError}。返回的释放钩子幂等,
   * 会话建出来或中途失败都要调一次。
   *
   * 必须是**预留**而不是只判一下:判定与真正建出会话之间隔着 prepare、拉 diff、建库记录几个
   * await,光判不占的话,两个同时发起的请求会在只剩一个位子时双双通过,后到的那个要到
   * launch 才撞满载 —— 那时 review、diff、round 都已落库。
   *
   * 忙碌会话腾不出来,已预留的位子也不能重复分配,两者占满就没有可给新会话的位子了
   * (空闲会话由 {@link evictExcess} 静默回收,不占额度)。
   */
  private reserveCapacity(): () => void {
    const busy = this.busyReviews();
    if (busy.length + this.pendingSessions >= this.maxLiveSessions)
      throw new LiveSessionLimitError(busy, this.maxLiveSessions);
    this.pendingSessions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingSessions -= 1;
    };
  }

  /** 拆一个会话:同步先从 map 摘除,再释放 session 与其 source 清理钩子。 */
  private async teardown(reviewId: string): Promise<void> {
    // 先推代次,且**不能**因为「没有活跃会话」提前返回就跳过 —— 在途的续接/复审正是还没登记
    // 会话的那段,这一步是它唯一能得知自己已被作废的信号(见 {@link teardownEpoch})。
    this.teardowns.set(reviewId, this.teardownEpoch(reviewId) + 1);
    const session = this.sessions.get(reviewId);
    if (!session) return;
    this.sessions.delete(reviewId);
    this.providers.delete(reviewId);
    const cleanup = this.cleanups.get(reviewId);
    this.cleanups.delete(reviewId);
    await session.dispose();
    await cleanup?.();
  }

  /**
   * 拆掉所有活跃会话(进程退出前的收尾)。
   *
   * 先立起 {@link shuttingDown} 再拆:在途的续接/复审还没登记会话,teardown 一个都碰不到它们,
   * 光拆一遍表就会被那之后才登记进来的会话反超 —— 那个会话开的 codex 子进程无人再收。
   * 不等在途构建自己收完(github-pr 的临时 checkout 在 os tmpdir 里,留下也由系统清):
   * 那可能是一次几秒的 clone,不值得把用户的退出按在那里等。
   *
   * 一个会话拆失败不能拖累其余:串行 await 会在第一个 reject 处退出,排在后面的连
   * `agent.dispose()` 都轮不上,那些 codex 子进程就成了孤儿。故并发起、allSettled 等,
   * 且退出本就压着超时(见 main 的 before-quit),并发也顺带省下串行的那份等待。
   */
  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.teardown(id)));
  }

  private forward(e: ReviewEvent): void {
    this.emit('review-event', e);
  }
}
