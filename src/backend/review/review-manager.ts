import { EventEmitter } from 'node:events';
import type {
  CodexModelInfo,
  Discussion,
  Finding,
  Message,
  Review,
  ReviewRound,
  ReviewUiState,
  Triage,
  UiSettings,
} from '@shared/domain';
import { changedFilesBetween, parseUnifiedDiff, type DiffFile } from '@shared/diff';
import type { AddFindingInput, FindingEditInput, RecentReview, RerunInput, ReviewEvent, SubmitReviewInput, SubmitReviewResult } from '@shared/ipc';
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
  detectGitButler,
  getRepoRemote,
  inferLocalRepo,
  listLocalBranches,
  listOpenPrs,
  previewPr,
} from '../source/source-discovery';
import type {
  GitButlerStatus,
  LocalBranchList,
  PrPreview,
  PrSummary,
  RepoRemoteInfo,
} from '@shared/source-discovery';
import { GhReviewSubmitter, type GitHubSubmitter } from './github-submitter';
import { DEFAULT_SCAN_PROMPT, ReviewSession, type ReviewSessionEvents } from './review-session';

/** 首轮扫描指令:有附加上下文时拼在缺省指令之后一并注入,否则用缺省。 */
function buildScanPrompt(context?: string): string | undefined {
  const ctx = context?.trim();
  if (!ctx) return undefined;
  return `${DEFAULT_SCAN_PROMPT}\n\n用户附加上下文(审核时一并考虑):\n${ctx}`;
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
  finding: (reviewId, payload) => ({ reviewId, type: 'finding', payload }),
  discussion: (reviewId, payload) => ({ reviewId, type: 'discussion', payload }),
  message: (reviewId, payload) => ({ reviewId, type: 'message', payload }),
  status: (reviewId, payload) => ({ reviewId, type: 'status', payload }),
  'agent-event': (reviewId, payload) => ({ reviewId, type: 'agent', payload }),
};

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
  private readonly maxLiveSessions: number;
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

  detectGitButler(repoPath: string): Promise<GitButlerStatus> {
    return detectGitButler(repoPath);
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

  /** 新建一条用户发起的、锚定代码位置的 discussion(不落 finding)。 */
  addUserDiscussion(
    reviewId: string,
    anchor: { file: string; line: number; lineEnd?: number | null },
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
      category: input.category ?? undefined,
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
   * 把保留且未提交的 findings 组成一次 GitHub PR review 原子提交。
   * 成功后被提交项锁定为 submitted(增量:下次只发新的 delta);失败/被拒不改任何状态。
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
    const pending = this.store.listFindings(reviewId).filter(isSubmittable);

    // 无 finding 也可提交:Comment/Approve/Request changes 本身就是表态
    const payload = buildPrReviewPayload(fresh, pending, input.event);
    const blocked = submitBlocker(payload);
    if (blocked) return { status: 'failed', message: blocked };
    const result = await this.submitter.submit(fresh, payload);

    if (result.status === 'success') {
      for (const f of pending) {
        this.store.setSubmission(f.id, 'submitted', result.url);
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

  /** 起真实审核:按 target 建 source,拉元数据落库,后台跑首轮扫描。 */
  async startReview(target: ReviewTarget): Promise<Review> {
    const source = createSource(target);
    const prepared = await source.prepare();
    const review = this.store.createReview({
      source: target.source,
      sourceRef: target.ref,
      repoPath: target.repoPath || null,
      title: prepared.title,
      model: target.model || null,
      reasoningEffort: target.reasoningEffort || null,
      intensity: target.intensity ?? 'standard',
    });
    // 预取 diff 落库:MCP 与 renderer 共用同一份,省 codex 侧一次 get_diff 往返。
    const rawDiff = await source.getDiff();
    this.store.setDiff(review.id, rawDiff);
    // 首轮也建轮次记录:轮次表是完整履历,复审只是往后追加,不是另一套东西。
    this.store.startRound(review.id, 1, { headSha: prepared.headSha, note: target.context });
    const baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity: review.intensity });
    this.launch(review, prepared.cwd, {
      getDiff: () => rawDiff,
      getFile: (p) => source.getFile(p),
    }, () => source.dispose(), baseInstructions, buildScanPrompt(target.context), 1);
    return review;
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
    const prevRound = this.store.getRound(reviewId, review.currentRound);
    if (prevRound?.status === 'scanning') {
      throw new Error('上一轮扫描尚未结束,不能重跑');
    }

    // 本轮可调档:给出即持久化为 review 新档,使后续轮次与续接(追问的 baseInstructions)一致沿用。
    const intensity = input.intensity ?? review.intensity;
    if (input.intensity && input.intensity !== review.intensity) {
      this.store.setReviewIntensity(reviewId, input.intensity);
    }

    // 每轮新 thread:先彻底释放上一轮的会话、MCP 与 source,再重建。
    await this.teardown(reviewId);

    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
    let round: ReviewRound;
    let prepared: Awaited<ReturnType<typeof source.prepare>>;
    let rawDiff: string;
    let prompt: string;
    let baseInstructions: string;
    try {
      prepared = await source.prepare();
      rawDiff = await source.getDiff();
      const prevDiff = this.store.getRawDiff(reviewId);
      const changedFiles = changedFilesBetween(prevDiff, rawDiff);
      const codeChanged = prevDiff !== rawDiff;
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

      round = this.store.startRound(reviewId, review.currentRound + 1, {
        headSha: prepared.headSha,
        note: input.note,
      });
      prompt = buildRerunPrompt({
        round: round.round,
        prevRound,
        headSha: prepared.headSha ?? null,
        changedFiles,
        codeChanged,
        openFindings,
        dismissedFindings,
        messagesByDiscussion,
        pr: pr && pr.fetchedAt ? pr : null,
        note: input.note,
      });
      baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity });
    } catch (e) {
      await source.dispose();
      throw e;
    }

    this.launch(
      { ...review, currentRound: round.round, intensity },
      prepared.cwd,
      { getDiff: () => rawDiff, getFile: (p) => source.getFile(p) },
      () => source.dispose(),
      baseInstructions,
      prompt,
      round.round,
    );
    this.forward({ reviewId, type: 'round', payload: round });
    return round;
  }

  /** 建 session、接事件、后台跑一轮机审(首轮与重跑共用)。 */
  private launch(
    review: Review,
    cwd: string,
    providers: McpContentProviders,
    onDone: (() => void | Promise<void>) | undefined,
    baseInstructions: string | undefined,
    scanPrompt: string | undefined,
    round: number,
  ): void {
    const session = this.createSession(review.id, onDone);
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
        () => this.settleRound(review.id, round, 'done'),
        () => {
          this.settleRound(review.id, round, 'failed');
          this.forward({ reviewId: review.id, type: 'status', payload: 'failed' });
        },
      );
  }

  /** 收一轮:统计本轮新增/判定已修复的条数落库(抑制数在命中时已累加),并外发轮次事件。 */
  private settleRound(reviewId: string, round: number, status: 'done' | 'failed'): void {
    const findings = this.store.listFindings(reviewId);
    const finished = this.store.finishRound(reviewId, round, status, {
      newFindings: findings.filter((f) => f.round === round).length,
      fixedCount: findings.filter((f) => f.lastSeenRound === round && f.resolution === 'fixed').length,
    });
    if (finished) this.forward({ reviewId, type: 'round', payload: finished });
  }

  /** 按持久化的 target 重建 source 并续接 codex thread(会话已不在内存)。 */
  private async resumeSession(reviewId: string): Promise<ReviewSession> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error(`review 不存在: ${reviewId}`);
    if (!review.codexThreadId) throw new Error(`review 无 codex thread,无法续接: ${reviewId}`);

    const source = createSource({
      source: review.source,
      ref: review.sourceRef,
      repoPath: review.repoPath ?? '',
    });
    const prepared = await source.prepare();
    const baseInstructions = await loadBaseInstructions({ cwd: prepared.cwd, intensity: review.intensity });
    const session = this.createSession(reviewId, () => source.dispose());
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
    } catch (e) {
      this.sessions.delete(reviewId);
      this.cleanups.delete(reviewId);
      this.providers.delete(reviewId);
      await session.dispose();
      await source.dispose();
      throw e;
    }
    return session;
  }

  /** 建 ReviewSession、登记清理钩子、把领域事件转成 IPC ReviewEvent 外发。 */
  private createSession(reviewId: string, onDispose?: () => void | Promise<void>): ReviewSession {
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

  /** 超过上限时逐出最久未用的会话(teardown 同步先删 map,while 收敛)。 */
  private evictExcess(): void {
    while (this.sessions.size >= this.maxLiveSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      void this.teardown(oldest).catch(() => undefined);
    }
  }

  /** 拆一个会话:同步先从 map 摘除,再释放 session 与其 source 清理钩子。 */
  private async teardown(reviewId: string): Promise<void> {
    const session = this.sessions.get(reviewId);
    if (!session) return;
    this.sessions.delete(reviewId);
    this.providers.delete(reviewId);
    const cleanup = this.cleanups.get(reviewId);
    this.cleanups.delete(reviewId);
    await session.dispose();
    await cleanup?.();
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.teardown(id);
  }

  private forward(e: ReviewEvent): void {
    this.emit('review-event', e);
  }
}
