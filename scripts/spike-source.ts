/**
 * Headless 验证 source 层:真实 git 仓 → LocalGitSource 取 diff/文件 → 喂真实 codex → findings 落库。
 * 需 `codex login`;better-sqlite3 须为 Node ABI(跑过 npm start 则先 `npm rebuild better-sqlite3`)。
 *   运行:npm run spike:source
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/ReviewStore';
import { CodexAgent } from '../src/backend/agent/codex/CodexAgent';
import { ReviewSession } from '../src/backend/review/ReviewSession';
import { LocalGitSource } from '../src/backend/source/LocalGitSource';
import { parsePrRef } from '../src/backend/source/GitHubPrSource';

const BUGGY = `const db = require('./db');

async function login(username, password) {
  const query = "SELECT * FROM users WHERE name = '" + username +
    "' AND pass = '" + password + "'";
  return (await db.query(query))[0];
}

module.exports = { login };
`;

const log = (m: string) => process.stdout.write(`[source] ${m}\n`);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'duetlens-src-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'spike@duetlens.dev');
  git(repo, 'config', 'user.name', 'spike');
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature/login');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src/login.js'), BUGGY);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'add login');
  return repo;
}

async function main() {
  // parsePrRef 纯函数断言(gh 路径的解析,不走网络)
  assert.deepEqual(parsePrRef('https://github.com/acme/repo/pull/42'), { nwo: 'acme/repo', num: '42' });
  assert.deepEqual(parsePrRef('acme/repo#7'), { nwo: 'acme/repo', num: '7' });
  assert.deepEqual(parsePrRef('#9'), { nwo: '', num: '9' });
  log('parsePrRef 解析 3 种形式 ok');

  const repo = makeRepo();
  const source = new LocalGitSource({ source: 'local-branch', ref: 'feature/login', repoPath: repo, baseRef: 'main' });

  const prepared = await source.prepare();
  const diff = await source.getDiff();
  const file = await source.getFile('src/login.js');
  log(`prepare title: ${prepared.title}`);
  assert.match(diff, /src\/login\.js/, 'diff 应含新增文件');
  assert.match(diff, /SELECT \* FROM users/, 'diff 应含改动内容');
  assert.match(file, /module\.exports/, 'getFile 应返回 head 版本内容');
  log(`getDiff ${diff.length}B, getFile ${file.length}B — 内容正确`);

  // 用真实 source 跑一次完整 ReviewSession(真实 codex)
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-branch', sourceRef: 'feature/login', repoPath: repo, title: prepared.title });
  const agent = new CodexAgent();
  const session = new ReviewSession(review.id, store, agent);
  session.on('finding', (f) => log(`finding ◀ ${f.severity} · ${f.title} @ ${f.file}:${f.line}`));

  try {
    const findings = await session.start({
      cwd: prepared.cwd,
      providers: { getDiff: () => source.getDiff(), getFile: (p) => source.getFile(p) },
    });
    const persisted = store.listFindings(review.id);
    log('────────────────────────');
    log(`findings: ${findings.length};store 持久化: ${persisted.length};状态: ${store.getReview(review.id)!.status}`);
    assert.ok(persisted.length > 0, 'source 喂真实 diff 后应有 finding 落库');
    log('✅ PASS — source 层(git)→ codex → sqlite 打通');
  } finally {
    await session.dispose();
    await source.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stdout.write(`[source] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
