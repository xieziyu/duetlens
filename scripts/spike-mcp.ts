/**
 * 确定性验证 MCP 工具面(不走 codex/不烧 token):MCP SDK client → DuetlensMcpServer。
 * 覆盖 report_finding 返回 id + update_finding 回写,并断言落进 ReviewStore。
 *   运行:npm run spike:mcp
 */
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import {
  DuetlensMcpServer,
  type ReportedFinding,
  type ReportedFindingResolution,
  type ReportedFindingUpdate,
} from '../src/backend/mcp/duetlens-mcp-server';
import { reportFindingSchema, resolveFindingSchema, updateFindingSchema } from '../src/shared/domain';

const log = (m: string) => process.stdout.write(`[mcp] ${m}\n`);

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === 'text')?.text ?? '';
}

async function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' });

  const mcp = new DuetlensMcpServer({ getDiff: () => 'DIFF', getFile: () => 'FILE' });
  // 复刻 ReviewSession 的落库接线(此处专测 MCP↔store,不引 codex)
  mcp.on('finding', (raw: ReportedFinding) => {
    const p = reportFindingSchema.safeParse(raw);
    if (p.success) store.addFinding(review.id, p.data, 'agent', raw.id);
  });
  mcp.on('finding-update', (raw: ReportedFindingUpdate) => {
    const p = updateFindingSchema.safeParse(raw);
    if (p.success) store.updateFinding(p.data);
  });
  mcp.on('finding-resolution', (raw: ReportedFindingResolution) => {
    const p = resolveFindingSchema.safeParse(raw);
    if (!p.success) return;
    const round = store.getReview(review.id)!.currentRound;
    store.setFindingResolution(p.data.findingId, round, p.data.status, p.data.note);
  });
  const url = await mcp.listen();
  log(`server ${url} (token=${mcp.token.slice(0, 8)}…)`);

  // 鉴权面:无令牌 / 错令牌一律 401(隔离本地其他进程)
  const noAuth = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401, '无 bearer 应 401');
  const badAuth = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal(badAuth.status, 401, '错 bearer 应 401');
  log('鉴权:无/错令牌 → 401 ✓');

  const client = new Client({ name: 'spike', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } },
    }),
  );

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  log(`tools: ${tools.join(', ')}`);
  assert.ok(tools.includes('report_finding') && tools.includes('update_finding'), '应含 report/update');

  // get_diff 走 provider
  const diff = textOf((await client.callTool({ name: 'get_diff', arguments: {} })) as never);
  assert.equal(diff, 'DIFF');

  // report_finding → 拿 id
  const rep = textOf(
    (await client.callTool({
      name: 'report_finding',
      arguments: { severity: 'high', category: 'security', title: 'SQL 注入', body: 'x', file: 'a.js', line: 3 },
    })) as never,
  );
  const id = rep.match(/id=([0-9a-f-]+)/)?.[1];
  assert.ok(id, 'report_finding 应回传 id');
  log(`report_finding → id=${id}`);

  let stored = store.getFinding(id!);
  assert.ok(stored, 'finding 应落库');
  assert.equal(stored!.title, 'SQL 注入');
  assert.equal(stored!.severity, 'high');

  // update_finding 回写
  await client.callTool({
    name: 'update_finding',
    arguments: { finding_id: id, title: 'SQL 注入(可绕过认证)', severity: 'medium' },
  });
  stored = store.getFinding(id!);
  assert.equal(stored!.title, 'SQL 注入(可绕过认证)', 'title 应被 update');
  assert.equal(stored!.severity, 'medium', 'severity 应被 update');
  log(`update_finding → title/severity 已回写`);

  // resolve_finding:still_present 的 note 会原样取代首轮正文发给作者,缺了就只剩一句没依据的结论。
  // 提示词是软约束,这里验的是硬约束 —— 拒收并把原因回给 agent,而不是静默落库。
  const blank = (await client.callTool({
    name: 'resolve_finding',
    arguments: { finding_id: id, status: 'still_present', note: '   ' },
  })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  assert.equal(blank.isError, true, '空白 note 的 still_present 应被拒');
  assert.match(textOf(blank), /未记录/, '拒收要让 agent 知道这条没记上');
  assert.equal(store.getFinding(id!)!.resolution, null, '被拒的表态不得落库');

  const missing = (await client.callTool({
    name: 'resolve_finding',
    arguments: { finding_id: id, status: 'wont_fix' },
  })) as { isError?: boolean };
  assert.equal(missing.isError, true, 'wont_fix 缺 note 同样被拒(要摘录作者原话)');

  const resolved = (await client.callTool({
    name: 'resolve_finding',
    arguments: { finding_id: id, status: 'still_present', note: '改成了预编译占位符,但拼接分支还在。' },
  })) as { isError?: boolean };
  assert.notEqual(resolved.isError, true, '带自足 note 的表态应被接收');
  stored = store.getFinding(id!);
  assert.equal(stored!.resolution, 'still_present');
  assert.match(stored!.resolutionNote ?? '', /拼接分支/, 'note 落库,供正文取代首轮正文');
  log('resolve_finding:缺 note 拒收并回错 / 自足 note 落库 ✓');

  // fixed 不在必填之列:它不进评论正文,写清改在哪只是提示
  const fixedRep = textOf(
    (await client.callTool({
      name: 'report_finding',
      arguments: { severity: 'low', title: '命名', body: 'x', file: 'a.js', line: 9 },
    })) as never,
  );
  const fixedId = fixedRep.match(/id=([0-9a-f-]+)/)?.[1];
  const fixedRes = (await client.callTool({
    name: 'resolve_finding',
    arguments: { finding_id: fixedId, status: 'fixed' },
  })) as { isError?: boolean };
  assert.notEqual(fixedRes.isError, true, 'fixed 无 note 照常接收');
  assert.equal(store.getFinding(fixedId!)!.resolution, 'fixed');

  await client.close();
  await mcp.close();

  log('────────────────────────');
  log('✅ PASS — MCP report_finding(带 id)+ update_finding 回环打通到 store');
}

main().catch((e) => {
  process.stdout.write(`[mcp] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
