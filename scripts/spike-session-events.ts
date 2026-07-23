/**
 * 确定性验证 ReviewSession 的对外事件面(不走 codex/不烧 token):
 * 用 stub agent 扮演 codex —— 从 startConversation 拿到注入的 MCP 端点,
 * 在 turn 里以 MCP client 身份调 report_finding,再发 turn-completed 结束这一轮。
 * 断言 agent 上报的 finding 会连同其**承载 discussion** 一起外发 —— 少了后者,
 * 本轮会话内 Discussion 栏就是空的(要等下次进 review 全量拉取才出现)。
 *   运行:npm run spike:session-events
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewSession } from '../src/backend/review/review-session';
import type {
  AgentEvent,
  ConversationalAgent,
  ConversationHandle,
  StartConversationOptions,
} from '../src/backend/agent/conversational-agent';
import type { Discussion, Finding } from '../src/shared/domain';

const log = (m: string) => process.stdout.write(`[session-events] ${m}\n`);

const REPORTED = {
  severity: 'high',
  category: 'correctness',
  title: 'Cell 跨 spawn 共享导致数据竞争',
  body: 'Cell<usize> 不是线程安全的。',
  file: 'src/pipeline.ts',
  line: 20,
};

/** 扮演 codex:记下注入的 MCP 端点,turn 里经真实 MCP 调 report_finding 后收工。 */
class StubAgent extends EventEmitter implements ConversationalAgent {
  private mcpUrl = '';
  private mcpToken = '';
  private turn = 0;

  async startConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    this.mcpUrl = opts.mcpUrl ?? '';
    this.mcpToken = opts.mcpToken ?? '';
    assert.ok(this.mcpUrl && this.mcpToken, 'session 应注入 MCP 端点与令牌');
    return { conversationId: 'stub-thread' };
  }
  async resumeConversation(opts: StartConversationOptions): Promise<ConversationHandle> {
    return this.startConversation(opts);
  }

  async sendMessage(): Promise<void> {
    const turnId = `t${++this.turn}`;
    const client = new Client({ name: 'stub-codex', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${this.mcpToken}` } },
      }),
    );
    await client.callTool({ name: 'report_finding', arguments: REPORTED });
    await client.close();
    // MCP 回调是同步落库的,此处紧接着收尾这一轮
    this.emit('event', { kind: 'turn-completed', turnId } satisfies AgentEvent);
  }

  streamEvents(handler: (e: AgentEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
  async interrupt(): Promise<void> {}
  approve(): void {}
  dispose(): void {}
}

async function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({
    source: 'local-branch',
    sourceRef: 'feat/x',
    title: 'stub review',
  });

  const session = new ReviewSession(review.id, store, new StubAgent());
  const findings: Finding[] = [];
  const discussions: Discussion[] = [];
  session.on('finding', (f: Finding) => findings.push(f));
  session.on('discussion', (d: Discussion) => discussions.push(d));

  await session.start({
    cwd: process.cwd(),
    providers: { getDiff: () => 'DIFF', getFile: () => 'FILE' },
  });

  log(`外发事件:finding × ${findings.length} · discussion × ${discussions.length}`);
  assert.equal(findings.length, 1, '应外发 1 条 finding');
  assert.equal(
    discussions.length,
    1,
    'agent finding 的承载 discussion 也须外发,否则本轮会话内 Discussion 栏为空',
  );
  assert.equal(discussions[0].id, findings[0].discussionId, 'discussion 应是该 finding 的承载线程');
  assert.equal(discussions[0].kind, 'finding', '承载 discussion 的 kind 应为 finding');
  assert.equal(discussions[0].file, REPORTED.file, '承载 discussion 应带 finding 的锚点');
  log('finding 与其承载 discussion 成对外发 ✓');

  // 落库侧同样能查到(下次进 review 全量拉取走这条路径)
  const stored = store.listDiscussions(review.id);
  assert.equal(stored.length, 1, '承载 discussion 应已落库');
  assert.equal(stored[0].id, findings[0].discussionId);
  log('全量拉取路径一致 ✓');

  await session.dispose();
  db.close();
  log('PASS');
}

main().catch((e) => {
  process.stderr.write(`[session-events] FAIL: ${(e as Error).message}\n`);
  process.exit(1);
});
