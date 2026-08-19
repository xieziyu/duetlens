/**
 * 确定性验证对抗档的取证闸与搜索面(不走 codex / 不烧 token)。
 * 覆盖:search_code 按 source 能力条件声明 · git grep 命中与零命中的措辞 ·
 * get_file 行区间 · judge_finding 的轮次闸与**取证硬闸** · 裁决只落三列不动 severity/triage。
 *   运行:npm run spike:adversarial
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import {
  DuetlensMcpServer,
  type ReportedFinding,
  type ReportedFindingUpdate,
} from '../src/backend/mcp/duetlens-mcp-server';
import { gitGrep } from '../src/backend/source/git-grep';
import { selfCheckRoster } from '../src/backend/review/review-session';
import { run } from '../src/backend/source/exec';
import {
  judgeFindingSchema,
  reportFindingSchema,
  updateFindingSchema,
  type JudgeFindingInput,
} from '../src/shared/domain';
import { MCP_TOOL } from '../src/shared/mcp-contract';

const log = (m: string) => process.stdout.write(`[adversarial] ${m}\n`);

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === 'text')?.text ?? '';
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'spike', version: '0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** 造一个真仓库,让 git grep 有东西可搜(搜索面必须验在真 git 上,mock 掉就什么也没验)。 */
function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'duetlens-adv-'));
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(
    path.join(repo, 'src', 'guard.ts'),
    ['export function readItem(xs: string[], i: number) {', '  if (i >= xs.length) return null;', '  return xs[i];', '}', ''].join('\n'),
  );
  writeFileSync(path.join(repo, 'src', 'caller.ts'), ['import { readItem } from "./guard";', 'readItem([], 0);', ''].join('\n'));
  // 40 个文件都含同一个高频词:用来验「读满文件上限就杀子进程」,而不是拿回全量再切
  mkdirSync(path.join(repo, 'wide'));
  for (let i = 0; i < 40; i++) {
    writeFileSync(path.join(repo, 'wide', `m${i}.ts`), 'export const HOTWORD = 1;\n');
  }
  return repo;
}

async function main() {
  const repo = makeRepo();
  try {
    await run('git', ['-C', repo, 'init', '-q']);

    // ── 1. git grep:命中 / 零命中 ────────────────────────────────
    const hit = await gitGrep(repo, 'readItem', { untracked: true });
    assert.equal(hit.total, 3, '两个文件共 3 处 readItem');
    assert.ok(hit.files.some((f) => f.path === 'src/caller.ts'), '未跟踪文件也要搜到(vbranch 的新文件还没进索引)');
    const miss = await gitGrep(repo, 'readItemXYZ', { untracked: true });
    assert.equal(miss.total, 0);
    log('git grep:命中含未跟踪文件 · 不存在的词 0 命中 ✓');

    // 文件数上限:-m 只管得住单文件的命中数,命中的**文件数**照样无上限 ——
    // 高频 query 会在大仓库里堆出巨量输出、撞上 maxBuffer,再被 catch 伪装成 0 命中。
    const wide = await gitGrep(repo, 'HOTWORD', { untracked: true });
    assert.ok(wide.files.length <= 20, `文件数要在读取阶段封顶,实际 ${wide.files.length}`);
    assert.equal(wide.moreFiles, true, '截断了就要说截断了,别让 agent 拿它当全集');
    // 这条才区分得出「读取阶段就停」与「读完再切」:40 个文件各 1 条命中,
    // 全量缓冲的实现会收满 40,流式实现在第 21 个新文件处就杀掉子进程。
    assert.ok(wide.total <= 21, `应在读满 20 个文件处停止读取,实际收了 ${wide.total} 条`);
    const narrowed = await gitGrep(repo, 'HOTWORD', { untracked: true, pathPrefix: 'wide/m1.ts' });
    assert.equal(narrowed.files.length, 1, 'path_prefix 要能把范围收回来');
    assert.equal(narrowed.moreFiles, false);
    log('git grep:文件数在读取阶段封顶并标注截断 · path_prefix 可收窄 ✓');

    // ── 2. MCP 面 ────────────────────────────────────────────────
    const db = openDatabase(':memory:');
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'local-branch', sourceRef: 'x', title: 't' });

    const mcp = new DuetlensMcpServer({
      getDiff: () => 'DIFF',
      getFile: () => ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
      searchCode: (input) => gitGrep(repo, input.query, { untracked: true, pathPrefix: input.pathPrefix }),
      // 复刻 ReviewManager.buildProviders:**限定本 review** —— 不限定的话,agent 给出别的
      // 审核的 id 就能把裁决写到那条 finding 上(路径重名时连取证闸都挡不住)。
      findingFile: (id) => {
        const f = store.getFinding(id);
        return f && f.reviewId === review.id ? f.file : null;
      },
    });
    // 复刻 ReviewSession 的落库接线(专测 MCP↔store,不引 codex)
    mcp.on('finding', (raw: ReportedFinding) => {
      const p = reportFindingSchema.safeParse(raw);
      if (p.success) store.addFinding(review.id, p.data, 'agent', raw.id, 'scan');
    });
    mcp.on('finding-update', (raw: ReportedFindingUpdate) => {
      const p = updateFindingSchema.safeParse(raw);
      if (p.success) store.updateFinding(p.data);
    });
    mcp.on('finding-verdict', (raw: JudgeFindingInput) => {
      const p = judgeFindingSchema.safeParse(raw);
      if (!p.success) return;
      // 复刻 ReviewSession 的纵深校验:setFindingVerdict 按 id 全局写,上游一旦松了就没声响了
      const target = store.getFinding(p.data.findingId);
      if (!target || target.reviewId !== review.id) return;
      store.setFindingVerdict(p.data.findingId, p.data.verdict, p.data.note, 'selfcheck');
    });
    const url = await mcp.listen();
    const client = await connect(url, mcp.token);

    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes(MCP_TOOL.searchCode), 'source 搜得了就该声明 search_code');
    log(`tools: ${names.sort().join(', ')}`);

    // 搜不了的 source:工具根本不声明 —— agent 不会调用,也就不会把「搜不了」读成「不存在」
    const blind = new DuetlensMcpServer({ getDiff: () => '', getFile: () => '' });
    const blindUrl = await blind.listen();
    const blindClient = await connect(blindUrl, blind.token);
    const blindNames = (await blindClient.listTools()).tools.map((t) => t.name);
    assert.ok(!blindNames.includes(MCP_TOOL.searchCode), '无搜索能力的 source 不该声明 search_code');
    log('search_code 按 source 能力条件声明(github-pr 那类拿不到它)✓');

    // ── 3. 零命中必须带免责句 ────────────────────────────────────
    const zero = textOf(
      (await client.callTool({ name: MCP_TOOL.searchCode, arguments: { query: 'readItemXYZ' } })) as never,
    );
    assert.ok(zero.includes('0 命中'), '要如实说 0 命中');
    assert.ok(
      zero.includes('不能据此断言'),
      '零命中必须内嵌免责句 —— 「没有调用点 ⇒ dead code」要在它发生的那一刻被拦住',
    );
    const found = textOf(
      (await client.callTool({ name: MCP_TOOL.searchCode, arguments: { query: 'readItem' } })) as never,
    );
    assert.ok(found.includes('src/guard.ts') && found.includes('共 3 处命中'), '要回显总命中数');
    log('search_code:零命中带免责句 · 命中回显总数与 file:line ✓');

    // ── 4. get_file 行区间 ───────────────────────────────────────
    const slice = textOf(
      (await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: 'a.ts', start: 2, end: 3 } })) as never,
    );
    assert.equal(slice, '2: line2\n3: line3', '截出来的片段要带原始行号,否则 agent 写的锚点会整体偏移');
    const whole = textOf((await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: 'a.ts' } })) as never);
    assert.ok(whole.startsWith('line1'), '不给区间就是原样全文(不加行号前缀)');
    log('get_file:带区间截取并保留原始行号 · 不给区间时原样 ✓');

    // ── 5. judge_finding 的两道闸 ────────────────────────────────
    await client.callTool({
      name: MCP_TOOL.reportFinding,
      arguments: { severity: 'high', title: '越界读', body: 'b', file: 'src/guard.ts', line: 3 },
    });
    const f = store.listFindings(review.id)[0];
    assert.equal(f.originTurn, 'scan', 'finding 要记下它出自哪一类 turn');

    // 闸一:非自检轮不得裁决(首轮放行 = 让 agent 给自己刚写的 finding 盖 confirmed)
    const early = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'confirmed', note: 'n' },
    })) as { isError?: boolean };
    assert.equal(early.isError, true, '扫描轮就该拒绝裁决');
    assert.equal(store.getFinding(f.id)!.verdict, null);

    mcp.setTurn('selfcheck');

    // 闸二(核心):本轮没取过证 → 拒收。散文里的引用可以是编的,一次被记账的工具调用不能。
    const noEvidence = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'refuted', note: '我记得那里有 guard' },
    })) as { isError?: boolean };
    assert.equal(noEvidence.isError, true, '未取证的裁决必须被拒');
    assert.equal(store.getFinding(f.id)!.verdict, null, '被拒的裁决不能落库');
    assert.ok(textOf(noEvidence as never).includes('src/guard.ts'), '要点名缺哪个文件的证');
    // 模型手上还有 shell,`cat` 过之后撞上这道闸时它自认已读过原文 —— 文案不点破口径、
    // 不给出能自救的那次调用,它就只会重试同一次调用或干脆放弃裁决。
    const denial = textOf(noEvidence as never);
    assert.ok(denial.includes(MCP_TOOL.getFile), '拒收文案要写出能解锁的那次调用');
    assert.ok(/shell|cat/.test(denial), '要点破「别的方式读过不算」,否则模型会以为工具坏了');

    // 验红确认:红的确实是取证闸 —— 取证后同一次调用就该通过
    await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: 'src/guard.ts', start: 1, end: 4 } });
    const judged = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'refuted', note: 'src/guard.ts:2 的 `i >= xs.length` 已经挡住了越界' },
    })) as { isError?: boolean };
    assert.notEqual(judged.isError, true, '取证之后同一条裁决就该被收下');
    log('judge_finding:扫描轮拒绝 · 未取证拒绝 · 取证后放行 ✓');

    // ── 6. 裁决是标注不是动作 ────────────────────────────────────
    const after = store.getFinding(f.id)!;
    assert.equal(after.verdict, 'refuted');
    assert.ok(after.verdictNote!.includes('guard.ts:2'));
    assert.equal(after.verdictTurn, 'selfcheck');
    assert.equal(after.severity, 'high', 'refuted 不得改 severity —— 机器降档等于软剔除');
    assert.equal(after.triage, 'open', 'refuted 不得改 triage —— 剔除权只在 reviewer 手里');
    assert.equal(after.bodyRound, f.bodyRound, '裁决没给作者新写一句话,不该刷 bodyRound');
    log('裁决只落三列:severity / triage / bodyRound 一个都没动 ✓');

    // search_code 同样算取证:换一条 finding 走搜索路径
    await client.callTool({
      name: MCP_TOOL.reportFinding,
      arguments: { severity: 'low', title: '调用点存疑', body: 'b', file: 'src/caller.ts', line: 2 },
    });
    const g = store.listFindings(review.id).find((x) => x.file === 'src/caller.ts')!;
    mcp.setTurn('selfcheck'); // 重置取证记账
    await client.callTool({ name: MCP_TOOL.searchCode, arguments: { query: 'readItem' } });
    const viaSearch = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: g.id, verdict: 'cannot_verify', note: '搜到 3 处调用,但看不出运行期的输入形状' },
    })) as { isError?: boolean };
    assert.notEqual(viaSearch.isError, true, 'search_code 命中该文件同样算取过证');
    assert.equal(store.getFinding(g.id)!.verdict, 'cannot_verify');
    log('search_code 命中亦计入取证 · cannot_verify 可落库(查无实据 ≠ 成立)✓');

    // 取证记账按 turn 重置:换一轮就不认上一轮读过的
    mcp.setTurn('selfcheck');
    const stale = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'confirmed', note: '沿用上轮读到的内容' },
    })) as { isError?: boolean };
    assert.equal(stale.isError, true, '取证记账必须按 turn 清空,否则等于默许凭记忆写引用');
    log('取证记账按 turn 重置 ✓');

    // 记账与查账的路径口径必须一致:记的是 agent 传来的 path,查的是 finding 落库的 file。
    // 同一个文件写成 `./x` 与 `x` 时错杀的是**真取了证**的裁决,而模型只看到「还没取证」。
    await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: './src/guard.ts', start: 1, end: 4 } });
    const dotted = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'confirmed', note: '按 ./ 前缀读回同一个文件' },
    })) as { isError?: boolean };
    assert.notEqual(dotted.isError, true, '`./a` 与 `a` 是同一个文件,不该因写法差异被判未取证');

    // source 侧走 path.resolve,`a/x/../b.ts` 是真读得到 `a/b.ts` 的,中间段不折同样是误杀。
    mcp.setTurn('selfcheck');
    await client.callTool({
      name: MCP_TOOL.getFile,
      arguments: { path: 'src/tmp/../guard.ts', start: 1, end: 4 },
    });
    const dotdot = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'confirmed', note: '经 ../ 读回同一个文件' },
    })) as { isError?: boolean };
    assert.notEqual(dotdot.isError, true, '中间的 ../ 要折掉,否则读得到却判未取证');

    // 反方向:归一**不许**把两个不同文件并成一个 key。反斜杠与首尾空格在 POSIX 下都是
    // 合法文件名,抹掉它们等于 agent 读 A 就能裁决 B —— 放松闸门比误杀糟得多。
    mcp.setTurn('selfcheck');
    await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: 'src\\guard.ts' } });
    const merged = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: f.id, verdict: 'confirmed', note: '只读过反斜杠那个名字' },
    })) as { isError?: boolean };
    assert.equal(merged.isError, true, '`src\\guard.ts` 是另一个文件名,不得并成 src/guard.ts 的证');
    log('取证记账:./ 与中间 ../ 折叠 · 反斜杠不并 key ✓');

    // ── 7. 读取失败不算取证 ──────────────────────────────────────
    // 从前无条件记账,于是锚到不存在文件的 finding 只要调一次注定失败的 get_file 就能解锁裁决。
    const failing = new DuetlensMcpServer({
      getDiff: () => '',
      getFile: (p) => {
        throw new Error(`无法读取 ${p}`);
      },
      findingFile: () => 'ghost.ts',
    });
    const failUrl = await failing.listen();
    const failClient = await connect(failUrl, failing.token);
    failing.setTurn('selfcheck');
    const readFail = (await failClient.callTool({
      name: MCP_TOOL.getFile,
      arguments: { path: 'ghost.ts' },
    })) as { isError?: boolean };
    assert.equal(readFail.isError, true, '读不到就该如实报错,不能回一句占位文本');
    const afterFailedRead = (await failClient.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: 'x', verdict: 'confirmed', note: '我读过了' },
    })) as { isError?: boolean };
    assert.equal(afterFailedRead.isError, true, '一次失败的读取不能解锁裁决');
    await failClient.close();
    await failing.close();
    log('get_file 读取失败:如实报错 · 不计入取证 ✓');

    // ── 8. 未知 / 越权 id ────────────────────────────────────────
    mcp.setTurn('selfcheck');
    await client.callTool({ name: MCP_TOOL.getFile, arguments: { path: 'src/guard.ts' } });
    const unknown = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: 'no-such-id', verdict: 'refuted', note: 'n' },
    })) as { isError?: boolean };
    assert.equal(unknown.isError, true, '未知 id 必须拒收,不能既跳过取证闸又回一句 recorded');

    // 另一条 review 的 finding:findingFile 限定本 review,故解析不到 → 同样拒收
    const other = store.createReview({ source: 'local-branch', sourceRef: 'y', title: 'other' });
    const otherFinding = store.addFinding(
      other.id,
      { severity: 'high', title: '别人的', body: '', file: 'src/guard.ts', line: 1 },
      'agent',
      undefined,
      'scan',
    );
    const crossReview = (await client.callTool({
      name: MCP_TOOL.judgeFinding,
      arguments: { finding_id: otherFinding.id, verdict: 'refuted', note: '越权写' },
    })) as { isError?: boolean };
    assert.equal(crossReview.isError, true, '别的 review 的 id 必须拒收');
    assert.equal(
      store.getFinding(otherFinding.id)!.verdict,
      null,
      '越权裁决绝不能落到另一次审核的 finding 上',
    );
    log('judge_finding:未知 id 与跨 review id 一律拒收 ✓');

    // ── 9. 搜索失败 ≠ 0 命中 ─────────────────────────────────────
    const brokenSearch = new DuetlensMcpServer({
      getDiff: () => '',
      getFile: () => '',
      searchCode: () => Promise.reject(new Error('代码搜索没能跑起来:stdout maxBuffer exceeded')),
    });
    const bsUrl = await brokenSearch.listen();
    const bsClient = await connect(bsUrl, brokenSearch.token);
    const bsRes = (await bsClient.callTool({
      name: MCP_TOOL.searchCode,
      arguments: { query: 'a' },
    })) as { isError?: boolean };
    assert.equal(bsRes.isError, true, '搜索跑不起来要如实报错');
    const bsText = textOf(bsRes as never);
    assert.ok(!bsText.includes('0 命中'), '失败绝不能伪装成 0 命中 —— 那正是本工具要拦的反向幻觉');
    assert.ok(bsText.includes('不是「没搜到」'), '要明说这不是「没搜到」');
    await bsClient.close();
    await brokenSearch.close();
    log('search_code 失败:如实报错,不伪装成 0 命中 ✓');

    // ── 10. 裁决按轮失效 · 正文改写即作废 ────────────────────────
    const judgedRound = store.getFinding(f.id)!;
    assert.equal(judgedRound.verdictRound, 1, '裁决要记下出自第几轮');
    // 正文被 reviewer 改写 = 判据针对的东西没了,三列一并清空
    store.updateFinding({ findingId: f.id, body: '换一段完全不同的正文' });
    const rewritten = store.getFinding(f.id)!;
    assert.equal(rewritten.verdict, null, '正文改写后旧判据不得继续挂着');
    assert.equal(rewritten.verdictRound, null);
    log('裁决:记录轮次 · 正文改写即作废 ✓');

    // ── 11. 自检轮不得从侧门改动 finding 本体 ────────────────────
    // 取证硬闸设在 judge_finding 上,但 update_finding 同样能改 severity / 正文 ——
    // 不拦的话「降个级」就是一条绕开取证、且直接改变待提交内容的路。
    mcp.setTurn('selfcheck');
    const before = store.getFinding(g.id)!;
    const sideDoor = (await client.callTool({
      name: MCP_TOOL.updateFinding,
      arguments: { finding_id: g.id, severity: 'low', body: '其实不太确定' },
    })) as { isError?: boolean };
    assert.equal(sideDoor.isError, true, '自检轮的 update_finding 必须被拒');
    assert.ok(textOf(sideDoor as never).includes(MCP_TOOL.judgeFinding), '要把它引到 judge_finding 上');
    const untouched = store.getFinding(g.id)!;
    assert.equal(untouched.severity, before.severity, '被拒的更新绝不能落库');
    assert.equal(untouched.body, before.body);

    // 反面:扫描轮的 update_finding 是正常路径,不能被这道闸误伤
    mcp.setTurn('scan');
    const legit = (await client.callTool({
      name: MCP_TOOL.updateFinding,
      arguments: { finding_id: g.id, title: '扫描轮改标题是允许的' },
    })) as { isError?: boolean };
    assert.notEqual(legit.isError, true, '扫描轮仍可更正自己刚报的 finding');
    assert.equal(
      store.getFinding(g.id)!.title,
      '扫描轮改标题是允许的',
      '扫描轮的更新要真的落库 —— 不落库的话上面那条「被拒不落库」是恒真的,等于没验',
    );
    log('update_finding:自检轮拒收并指向 judge_finding · 扫描轮不受影响 ✓');

    // ── 12. 自检清单:复审轮不能漏掉既有条目 ─────────────────────
    // 判据是 lastSeenRound 而非首报轮次 —— 按 round 取的话,复审轮里被判 still_present 的
    // 既有 finding 一条都选不中,于是「仍存在」这个最该被证伪的结论反而从不过自检。
    const r2 = store.createReview({ source: 'local-branch', sourceRef: 'z', title: 'r2' });
    const mk = (title: string, file: string) =>
      store.addFinding(r2.id, { severity: 'medium', title, body: '', file, line: 1 }, 'agent', undefined, 'scan');
    const carried = mk('上一轮报的', 'a.ts');
    const fresh = mk('本轮新报的', 'b.ts');
    const dropped = mk('被剔除的', 'c.ts');
    const closed = mk('已修复的', 'd.ts');
    store.startRound(r2.id, 2, {});
    store.setFindingResolution(carried.id, 2, 'still_present', '第 2 轮仍未改');
    store.touchFindingSeen(fresh.id, 2);
    store.setTriage(dropped.id, 'dismiss', '不改');
    store.setFindingResolution(closed.id, 2, 'fixed', '已修');

    const roster = selfCheckRoster(store.listFindings(r2.id), 2);
    const titles = roster.map((f) => f.title).sort();
    assert.deepEqual(
      titles,
      ['上一轮报的', '本轮新报的'],
      `复审轮要裁本轮表过态的全部待处理条目,实际:${titles.join(' / ')}`,
    );
    assert.equal(selfCheckRoster(store.listFindings(r2.id), 3).length, 0, '没表过态的轮次没有可裁的');
    log('自检清单:含复审轮沿用的条目 · 排除已剔除与已结案 ✓');

    await client.close();
    await blindClient.close();
    await mcp.close();
    await blind.close();
    db.close();
    log('────────────────────────');
    log('✅ PASS — 搜索面 + 取证闸 + 裁决语义全通过');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  log(`❌ FAIL — ${String(e)}`);
  process.exit(1);
});
