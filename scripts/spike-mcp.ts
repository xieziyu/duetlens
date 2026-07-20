/**
 * 确定性验证 MCP 工具面(不走 codex/不烧 token):MCP SDK client → DuetlensMcpServer。
 * 覆盖 report_finding 返回 id + update_finding 回写,并断言落进 ReviewStore。
 *   运行:npm run spike:mcp
 */
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/ReviewStore';
import {
  DuetlensMcpServer,
  type ReportedFinding,
  type ReportedFindingUpdate,
} from '../src/backend/mcp/DuetlensMcpServer';
import { reportFindingSchema, updateFindingSchema } from '../src/shared/domain';

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
  const url = await mcp.listen();
  log(`server ${url}`);

  const client = new Client({ name: 'spike', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

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

  await client.close();
  await mcp.close();

  log('────────────────────────');
  log('✅ PASS — MCP report_finding(带 id)+ update_finding 回环打通到 store');
}

main().catch((e) => {
  process.stdout.write(`[mcp] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
