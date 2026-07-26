import { EventEmitter } from 'node:events';
import { REVIEW_RETENTION_MS } from '@shared/domain';
import type {
  CodexModelInfo,
  Discussion,
  Finding,
  Message,
  Review,
  ReviewIntensity,
  ReviewRound,
  ReviewUiState,
  Triage,
  UiSettings,
} from '@shared/domain';
import type { AgentErrorKind } from '@shared/agent-events';
import { changedFilesBetween, parseUnifiedDiff, type DiffFile } from '@shared/diff';
import type { AddFindingInput, BusyReview, FindingEditInput, LatestDiffResult, LiveCapacity, RecentReview, RerunInput, ReviewEvent, ReviewStartStage, SubmitReviewInput, SubmitReviewResult } from '@shared/ipc';
import { LIVE_SESSION_LIMIT_CODE } from '@shared/ipc';
import type { PromptSaveInput, ReviewPromptView } from '@shared/prompt';
import { buildPrReviewPayload, isSubmittable, submitBlocker } from '@shared/github-review';
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
import type { ReviewTarget } from '../source/source';
import {
  checkGhAuth,
  getRepoRemote,
  inferLocalRepo,
  inspectRepo,
  listLocalBranches,
  listOpenPrs,
  previewPr,
} from '../source/source-discovery';
import type {
  LocalBranchList,
  PrPreview,
  PrSummary,
  RepoInspection,
  RepoRemoteInfo,
} from '@shared/source-discovery';
import { GhReviewSubmitter, type GitHubSubmitter } from './github-submitter';
import { AgentTurnError, DEFAULT_SCAN_PROMPT, ReviewSession, type ReviewSessionEvents } from './review-session';

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
  status: (reviewId, payload) => ({ reviewId, type: 'status', payload }),
  'agent-event': (reviewId, payload) => ({ reviewId, type: 'agent', payload }),
};

/**
 * 轮次失败的落库形态。turn 失败带得到 agent 归因;编排层自己抛的(source/网络/gh)只有原文,
 * 归到 'other' —— 宁可不分类,也不按 message 猜。
 */
function describeRoundFailure(cause: unknown): { errorMessage: string; errorKind: AgentErrorKind } {
  if (cause instanceof AgentTurnError) return { errorMessage: cause.detail, errorKind: cause.errorKind };
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return { errorMessage: message || '未知错误', errorKind: 'other' };
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
    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
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
  async getFileContent(reviewId: string, filePath: string): Promise<string | null> {
    const live = this.providers.get(reviewId);
    if (live) {
      this.touch(reviewId);
      return live.getFile(filePath);
    }
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
    try {
      await source.prepare();
      return await source.getFile(filePath);
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

  /** 编辑审核总结正文(提交屏 review body 来源);落库后外发 `review` 事件。 */
  updateSummary(reviewId: string, body: string): Review {
    this.store.setReviewSummary(reviewId, body);
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    this.forward({ reviewId, type: 'review', payload: review });
    return review;
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
    // summary 若有改动,先落库(review body 来源),再一并回推
    if (input.summaryBody !== undefined && input.summaryBody !== review.summaryBody) {
      this.updateSummary(reviewId, input.summaryBody);
    }
    const fresh = this.store.getReview(reviewId)!;
    const pending = this.store.listFindings(reviewId).filter((f) => isSubmittable(f, fresh.currentRound));

    // 无 finding 也可提交:Comment/Approve/Request changes 本身就是表态
    const payload = buildPrReviewPayload(fresh, pending, input.event);
    const blocked = submitBlocker(payload);
    if (blocked) return { status: 'failed', message: blocked };
    const result = await this.submitter.submit(fresh, payload);

    if (result.status === 'success') {
      for (const f of pending) {
        this.store.setSubmission(f.id, 'submitted', result.url, fresh.currentRound);
        const updated = this.store.getFinding(f.id);
        if (updated) this.forward({ reviewId, type: 'finding', payload: updated });
      }
      this.store.setReviewStatus(reviewId, 'submitted');
      this.forward({ reviewId, type: 'status', payload: 'submitted' });
    }
    return result;
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
      const baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity: review.intensity });
      launched = true;
      this.launch(review, prepared.cwd, {
        getDiff: () => rawDiff,
        getFile: (p) => source.getFile(p),
      }, () => source.dispose(), baseInstructions, buildScanPrompt(target.context), 1,
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
   */
  async rerunReview(reviewId: string, input: RerunInput = {}): Promise<ReviewRound> {
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
    },
  ): Promise<ReviewRound> {
    const reviewId = review.id;
    const prevRound = opts.round > 1 ? this.store.getRound(reviewId, opts.round - 1) : null;

    // 每轮新 thread:先彻底释放上一轮的会话、MCP 与 source,再重建。
    await this.teardown(reviewId);
    // 代次在 teardown 之后取:本轮要作废的是这次拆完之后又来的释放/删除。
    const epoch = this.teardownEpoch(reviewId);
    // 刚腾出的位子立刻占住:下面还要 await 好几步拉取,期间被别的发起抢走的话,
    // 轮次已经落库、却只能收成一条莫名其妙的失败。
    const release = this.reserveCapacity();

    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
    let round: ReviewRound;
    let prepared: Awaited<ReturnType<typeof source.prepare>>;
    let rawDiff: string;
    let prompt: string | undefined;
    let baseInstructions: string;
    try {
      prepared = await source.prepare();
      rawDiff = await source.getDiff();
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
      baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity: opts.intensity });
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
        { getDiff: () => rawDiff, getFile: (p) => source.getFile(p) },
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
        () => this.settleRound(review.id, round, session.isStopped() ? 'stopped' : 'done'),
        (e: unknown) => {
          this.settleRound(review.id, round, 'failed', e);
          this.forward({ reviewId: review.id, type: 'status', payload: 'failed' });
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
    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
    const prepared = await source.prepare();
    const baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity: review.intensity });
    let session: ReviewSession;
    try {
      session = this.createSession(reviewId, () => source.dispose(), epoch);
    } catch (e) {
      await source.dispose(); // 建不出会话(如满载/已被释放)时 source 还没交给任何清理钩子,自己收
      throw e;
    }
    const providers: McpContentProviders = {
      getDiff: () => source.getDiff(),
      getFile: (p) => source.getFile(p),
    };
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
   */
  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.sessions.keys()]) await this.teardown(id);
  }

  private forward(e: ReviewEvent): void {
    this.emit('review-event', e);
  }
}
