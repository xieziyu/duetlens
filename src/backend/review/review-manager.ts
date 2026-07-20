import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Discussion, Finding, Message, Review, UiSettings } from '@shared/domain';
import type { ReviewEvent } from '@shared/ipc';
import type { McpContentProviders } from '../mcp/duetlens-mcp-server';
import type { ReviewStore } from '../db/review-store';
import { CodexAgent } from '../agent/codex/codex-agent';
import { loadReviewPrompt } from '../prompt/review-prompt';
import { createSource } from '../source/create-source';
import type { ReviewTarget } from '../source/source';
import { ReviewSession } from './review-session';

// 演示用内置 fixture(source 层接好前,让 app 能端到端跑一遍真实审核)。
const DEMO_FILE = 'src/login.js';
const DEMO_SRC = `const db = require('./db');

async function login(username, password) {
  const query = "SELECT * FROM users WHERE name = '" + username +
    "' AND pass = '" + password + "'";
  return (await db.query(query))[0];
}

module.exports = { login };
`;
const DEMO_DIFF = `diff --git a/${DEMO_FILE} b/${DEMO_FILE}
new file mode 100644
--- /dev/null
+++ b/${DEMO_FILE}
@@ -0,0 +1,10 @@
${DEMO_SRC.split('\n').map((l) => '+' + l).join('\n')}`;

/**
 * main 侧 review 编排入口:持久化 + 活跃 ReviewSession,把领域事件归一成 IPC ReviewEvent 外发。
 * IPC 层订阅本类 'review-event' 转发到 renderer(见 backend/ipc)。
 */
export class ReviewManager extends EventEmitter {
  /** 活跃会话;按 Map 插入序当 LRU,访问时 touch 到队尾。 */
  private readonly sessions = new Map<string, ReviewSession>();
  /** source 等随会话存活的清理钩子;续问要读文件,故不在扫描结束时释放,延到 dispose。 */
  private readonly cleanups = new Map<string, () => void | Promise<void>>();
  private readonly maxLiveSessions: number;

  constructor(
    private readonly store: ReviewStore,
    private readonly codexHome?: string,
    opts?: { maxLiveSessions?: number },
  ) {
    super();
    // 每个活跃会话 = 一个 codex 子进程 + MCP server;上限避免长时运行泄漏进程。
    this.maxLiveSessions = opts?.maxLiveSessions ?? 4;
  }

  listReviews(): Review[] {
    return this.store.listReviews();
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

  /** 新建一条用户发起的、锚定代码位置的 discussion(不落 finding)。 */
  addUserDiscussion(
    reviewId: string,
    anchor: { file: string; line: number; lineEnd?: number | null },
  ): Discussion {
    const discussion = this.store.addUserDiscussion(reviewId, anchor);
    this.forward({ reviewId, type: 'discussion', payload: discussion });
    return discussion;
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
    });
    const { baseInstructions } = await loadReviewPrompt({ cwd: prepared.cwd });
    this.launch(review, prepared.cwd, {
      getDiff: () => source.getDiff(),
      getFile: (p) => source.getFile(p),
    }, () => source.dispose(), baseInstructions);
    return review;
  }

  /** 起演示审核:内置 fixture provider(source 层接好前保留,给无仓库环境跑通用)。 */
  async startDemoReview(): Promise<Review> {
    const workdir = mkdtempSync(path.join(tmpdir(), 'duetlens-demo-'));
    mkdirSync(path.join(workdir, 'src'), { recursive: true });
    writeFileSync(path.join(workdir, DEMO_FILE), DEMO_SRC);

    const review = this.store.createReview({
      source: 'local-branch',
      sourceRef: 'demo/login',
      repoPath: workdir,
      title: 'Demo · login.js 审核',
    });
    const { baseInstructions } = await loadReviewPrompt({ cwd: workdir });
    this.launch(review, workdir, { getDiff: () => DEMO_DIFF, getFile: () => DEMO_SRC }, undefined, baseInstructions);
    return review;
  }

  /** 建 session、接事件、后台跑首轮扫描(startReview / startDemoReview 共用)。 */
  private launch(
    review: Review,
    cwd: string,
    providers: McpContentProviders,
    onDone?: () => void | Promise<void>,
    baseInstructions?: string,
  ): void {
    const session = this.createSession(review.id, onDone);
    // 不 await:扫描后台跑,调用方(IPC)立即返回。source 清理延到 dispose,续问仍能读文件。
    session
      .start({ cwd, providers, baseInstructions })
      .catch(() => this.forward({ reviewId: review.id, type: 'status', payload: 'failed' }));
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
    const { baseInstructions } = await loadReviewPrompt({ cwd: prepared.cwd });
    const session = this.createSession(reviewId, () => source.dispose());
    try {
      await session.resume({
        cwd: prepared.cwd,
        providers: { getDiff: () => source.getDiff(), getFile: (p) => source.getFile(p) },
        baseInstructions,
      });
    } catch (e) {
      this.sessions.delete(reviewId);
      this.cleanups.delete(reviewId);
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

    session.on('finding', (payload: Finding) => this.forward({ reviewId, type: 'finding', payload }));
    session.on('message', (payload: Message) => this.forward({ reviewId, type: 'message', payload }));
    session.on('status', (payload: Review['status']) => this.forward({ reviewId, type: 'status', payload }));
    session.on('agent-event', (payload) => this.forward({ reviewId, type: 'agent', payload }));
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
