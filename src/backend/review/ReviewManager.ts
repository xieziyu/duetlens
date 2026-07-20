import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding, Review, UiSettings } from '@shared/domain';
import type { ReviewEvent } from '@shared/ipc';
import type { McpContentProviders } from '../mcp/DuetlensMcpServer';
import type { ReviewStore } from '../db/ReviewStore';
import { CodexAgent } from '../agent/codex/CodexAgent';
import { createSource } from '../source/createSource';
import type { ReviewTarget } from '../source/Source';
import { ReviewSession } from './ReviewSession';

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
  private readonly sessions = new Map<string, ReviewSession>();

  constructor(
    private readonly store: ReviewStore,
    private readonly codexHome?: string,
  ) {
    super();
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
    this.launch(review, prepared.cwd, {
      getDiff: () => source.getDiff(),
      getFile: (p) => source.getFile(p),
    }, () => source.dispose());
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
    this.launch(review, workdir, { getDiff: () => DEMO_DIFF, getFile: () => DEMO_SRC });
    return review;
  }

  /** 建 session、接事件、后台跑首轮扫描(startReview / startDemoReview 共用)。 */
  private launch(
    review: Review,
    cwd: string,
    providers: McpContentProviders,
    onDone?: () => void | Promise<void>,
  ): void {
    const agent = new CodexAgent({ codexHome: this.codexHome });
    const session = new ReviewSession(review.id, this.store, agent);
    this.sessions.set(review.id, session);

    session.on('finding', (payload: Finding) => this.forward({ reviewId: review.id, type: 'finding', payload }));
    session.on('status', (payload: Review['status']) =>
      this.forward({ reviewId: review.id, type: 'status', payload }),
    );
    session.on('agent-event', (payload) => this.forward({ reviewId: review.id, type: 'agent', payload }));

    // 不 await:扫描后台跑,调用方(IPC)立即返回
    session
      .start({ cwd, providers })
      .catch(() => this.forward({ reviewId: review.id, type: 'status', payload: 'failed' }))
      .finally(() => onDone?.());
  }

  async disposeAll(): Promise<void> {
    for (const s of this.sessions.values()) await s.dispose();
    this.sessions.clear();
  }

  private forward(e: ReviewEvent): void {
    this.emit('review-event', e);
  }
}
