/**
 * 两个 agent 走同一条装配链路(见 docs/design/pi-integration.md 的 P3 判据)。烧 token。
 *   运行:npm run spike:agents
 *
 * 同一个仓库、同一个 ReviewManager,分别用 codex 与 pi 各发起一轮 → 两边 findings 都落进同一张表、
 * agent 种类落库;然后新开一个 manager 指向同一份库(模拟 app 重启),两条都续接并各追问一句。
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { piExtensionPath } from '../src/backend/agent/pi/pi-agent';
import type { AgentKind } from '../src/shared/domain';

const log = (m: string) => process.stdout.write(`[agents] ${m}\n`);

/** 每家用便宜的档:这里验的是装配,不是审得好不好 */
const MODELS: Record<AgentKind, string | undefined> = {
  codex: undefined,
  pi: 'anthropic/claude-haiku-4-5-20251001',
};
const SCAN_TIMEOUT_MS = 600_000;

const SRC = `const db = require('./db');

async function login(username, password) {
  const query = "SELECT * FROM users WHERE name = '" + username +
    "' AND pass = '" + password + "'";
  return (await db.query(query))[0];
}

module.exports = { login };
`;

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duetlens-agents-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'spike@example.com');
  git('config', 'user.name', 'spike');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feature/login');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/login.js'), SRC);
  git('add', '.');
  git('commit', '-q', '-m', 'add login');
  return dir;
}

function managerOn(dbPath: string, sessionDir: string): { manager: ReviewManager; store: ReviewStore } {
  const store = new ReviewStore(openDatabase(dbPath));
  const manager = new ReviewManager(store, undefined, {
    pi: {
      extensionPath: piExtensionPath({ packaged: false, resourcesPath: '', appPath: path.resolve(__dirname, '..') }),
      sessionDir,
    },
  });
  return { manager, store };
}

/** 收轮后的父状态由 manager 统一写(见 ReviewSession.runStart 的注释),轮询它最直接 */
async function settled(store: ReviewStore, reviewId: string): Promise<string> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  for (;;) {
    const status = store.getReview(reviewId)!.status;
    if (status !== 'scanning') return status;
    if (Date.now() > deadline) throw new Error(`${reviewId} 扫描超时`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main(): Promise<void> {
  const repo = gitRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetlens-agents-'));
  const dbPath = path.join(tmp, 'duetlens.db');
  const sessionDir = path.join(tmp, 'pi-sessions');
  const ids: Record<string, string> = {};

  try {
    const first = managerOn(dbPath, sessionDir);
    try {
      for (const agent of ['codex', 'pi'] as const) {
        const t0 = Date.now();
        const review = await first.manager.startReview({
          source: 'local-branch',
          ref: 'feature/login',
          repoPath: repo,
          baseRef: 'main',
          agent,
          model: MODELS[agent],
        });
        ids[agent] = review.id;
        const status = await settled(first.store, review.id);
        const r = first.store.getReview(review.id)!;
        const findings = first.store.listFindings(review.id);
        log(`${agent}: ${status},${findings.length} 条 finding,模型 ${r.model},用时 ${Math.round((Date.now() - t0) / 1000)}s`);
        assert.equal(status, 'completed', `${agent} 这一轮没跑完`);
        assert.equal(r.agent, agent, 'agent 种类应落库');
        assert.ok(r.agentSessionId, `${agent} 的会话 id 应落库`);
        assert.ok(findings.length > 0, `${agent} 没有 finding 落库`);
      }
    } finally {
      await first.manager.disposeAll();
    }
    log('两家各跑一轮,findings 落进同一张表 ✓');

    // 模拟重启:新 manager、新连接,内存里什么都没有,只有库
    const second = managerOn(dbPath, sessionDir);
    try {
      for (const agent of ['codex', 'pi'] as const) {
        const id = ids[agent];
        await second.manager.resumeReview(id);
        const discussionId = second.store.listFindings(id)[0].discussionId!;
        const reply = await second.manager.sendMessage(id, discussionId, '用一句话说:这条问题最直接的修法是什么?');
        log(`${agent} 续接后追问 → ${reply.role}:${reply.text.slice(0, 80).replace(/\n/g, ' ')}`);
        assert.equal(reply.role, 'agent', `${agent} 续接后没有给出回复`);
      }
    } finally {
      await second.manager.disposeAll();
    }
    log('重启后两家都能续接并回答追问 ✓');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e: Error) => {
  process.stderr.write(`[agents] 失败:${e.stack ?? e.message}\n`);
  process.exitCode = 1;
});
