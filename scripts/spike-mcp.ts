/**
 * 确定性验证 MCP 工具面(不走 codex/不烧 token):MCP SDK client → DuetlensMcpServer。
 * 覆盖 report_finding 返回 id + update_finding 回写 + write_summary 落总结,并断言落进 ReviewStore。
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
import {
  isSummaryStale,
  reportFindingSchema,
  resolveFindingSchema,
  SUMMARY_FILES_LIMIT,
  updateFindingSchema,
  type WriteSummaryInput,
} from '../src/shared/domain';

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
  mcp.on('summary', (raw: WriteSummaryInput) => {
    store.writeAgentSummary(review.id, raw.body, raw.files);
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

  // write_summary:总结此前只存在于 agent 的回复文本里、从不落库(summary_body 恒为 null)。
  // 这里验的就是那条断链已接上,以及 propose 轮不得静默覆盖 reviewer 可能手改过的 body。
  assert.ok(tools.includes('write_summary'), '应含 write_summary');
  assert.equal(store.getReview(review.id)!.summaryBody, null, '起点应无总结');

  const emptyBody = (await client.callTool({
    name: 'write_summary',
    arguments: { body: '' },
  })) as { isError?: boolean };
  assert.equal(emptyBody.isError, true, '空 body 应被拒(空总结等于没写)');
  assert.equal(store.getReview(review.id)!.summaryBody, null, '被拒的总结不得落库');

  // 纯空白能过 min(1),落库前又被 trim 掉 —— 不先 trim 再校验的话,这一发会以「成功」
  // 之姿把已有总结覆盖成空串,并因 files 缺省顺手清掉重点文件。
  const blankBody = (await client.callTool({
    name: 'write_summary',
    arguments: { body: '   \n  ' },
  })) as { isError?: boolean };
  assert.equal(blankBody.isError, true, '纯空白 body 应被拒');
  assert.equal(store.getReview(review.id)!.summaryBody, null, '空白总结不得覆盖已有值');

  const noNote = (await client.callTool({
    name: 'write_summary',
    arguments: { body: 'ok', files: [{ path: 'a.js' }] },
  })) as { isError?: boolean };
  assert.equal(noNote.isError, true, '重点文件缺 note 应被拒 —— 只给路径等于没说要看什么');

  const blankNote = (await client.callTool({
    name: 'write_summary',
    arguments: { body: 'ok', files: [{ path: 'a.js', note: '  ' }] },
  })) as { isError?: boolean };
  assert.equal(blankNote.isError, true, '空白 note 同样被拒(否则导出里是一条空说明)');

  await client.callTool({
    name: 'write_summary',
    arguments: {
      body: '整体方向可以,注意并发计数。',
      files: [{ path: 'src/worker.rs', note: '时序改动大,建议人工推一遍。' }],
    },
  });
  let rv = store.getReview(review.id)!;
  assert.equal(rv.summaryBody, '整体方向可以,注意并发计数。', '总结正文应落库');
  assert.deepEqual(rv.summaryFiles, [
    { path: 'src/worker.rs', note: '时序改动大,建议人工推一遍。' },
  ]);
  log('write_summary → body + files 已落库 ✓');

  // 复审/自检轮重写:整份取代而非追加,否则上一轮的重点会一直挂在新一轮的结论上
  await client.callTool({
    name: 'write_summary',
    arguments: { body: '自检后:并发计数已确认无竞态。', files: [] },
  });
  rv = store.getReview(review.id)!;
  assert.equal(rv.summaryBody, '自检后:并发计数已确认无竞态。');
  assert.deepEqual(rv.summaryFiles, [], '重写应整份取代,空数组即清空');

  // 同一路径两条:两个列表都拿 path 当 React key,重复键会让整份重写时复用错节点。
  // 去重收在 ingress,下游才不必各自防重。
  await client.callTool({
    name: 'write_summary',
    arguments: {
      body: 'dup',
      files: [
        { path: 'src/a.ts', note: '第一条' },
        { path: 'src/a.ts', note: '第二条' },
        { path: 'src/b.ts', note: '另一个文件' },
      ],
    },
  });
  assert.deepEqual(
    store.getReview(review.id)!.summaryFiles,
    [
      { path: 'src/a.ts', note: '第一条' },
      { path: 'src/b.ts', note: '另一个文件' },
    ],
    '重复 path 应只留最先给出的那条,path 由此可作唯一 key',
  );

  // 超限截断:靠 store 兜底,不指望 agent 守住条数
  await client.callTool({
    name: 'write_summary',
    arguments: {
      body: 'many',
      files: Array.from({ length: SUMMARY_FILES_LIMIT + 4 }, (_, i) => ({
        path: `f${i}.ts`,
        note: 'n',
      })),
    },
  });
  assert.equal(store.getReview(review.id)!.summaryFiles.length, SUMMARY_FILES_LIMIT, '超限应截断');

  // 重跑漏写:总结是 review 级单份值、开新轮不清空,故第 2 轮不调 write_summary 时,
  // 屏上仍是第 1 轮的正文与重点文件。不清它(一份大体成立的总结不该因新一轮开跑就作废),
  // 但必须能判定它已过期,否则旧结论会冒充本轮结论误导 reviewer。
  assert.equal(isSummaryStale(store.getReview(review.id)!), false, '同轮内写的总结不算过期');
  store.startRound(review.id, 2, {});
  const missed = store.getReview(review.id)!;
  assert.equal(isSummaryStale(missed), true, '开了第 2 轮却没重写 → 上一轮的总结必须判定为过期');
  assert.ok(missed.summaryBody, '过期不等于清空 —— 内容要留着');
  await client.callTool({
    name: 'write_summary',
    arguments: { body: '第 2 轮的结论', files: [{ path: 'src/c.ts', note: '第 2 轮挑的' }] },
  });
  const rewritten = store.getReview(review.id)!;
  assert.equal(rewritten.summaryRound, 2, '本轮重写后应记在第 2 轮');
  assert.equal(isSummaryStale(rewritten), false, '重写后不再过期');
  assert.deepEqual(rewritten.summaryFiles, [{ path: 'src/c.ts', note: '第 2 轮挑的' }]);
  log('write_summary:重跑漏写可判定过期(留内容、只标过期)· 重写刷新轮次 ✓');

  // propose 轮(追问)不得写总结:没有待确认卡片可挂,放行等于一句追问静默覆盖 review body
  mcp.setTurn('followup');
  const inPropose = (await client.callTool({
    name: 'write_summary',
    arguments: { body: '追问里偷偷改总结' },
  })) as { isError?: boolean };
  assert.equal(inPropose.isError, true, 'propose 模式应拒收 write_summary');
  assert.equal(store.getReview(review.id)!.summaryBody, '第 2 轮的结论', '被拒后 body 原样不动');
  mcp.setTurn('scan');
  log('write_summary:空 body/缺 note 拒收 · 重写取代 · 超限截断 · propose 轮拒收 ✓');

  await client.close();
  await mcp.close();

  log('────────────────────────');
  log('✅ PASS — MCP report_finding(带 id)+ update_finding + write_summary 回环打通到 store');
}

main().catch((e) => {
  process.stdout.write(`[mcp] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
