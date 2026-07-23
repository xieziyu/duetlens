/**
 * 确定性验证审核规则提示词的分层解析/合并/注入(不走 codex/不烧 token)。
 * 造临时 project(.duetlens/review.md)+ global(homeDir/.duetlens/review.md)两层,
 * 断言分节覆盖(project ▸ global ▸ builtin)、severity 逐档覆盖,以及
 * **锁定段不可被用户层改掉**(角色/工具流程、report_finding 字段协议)。
 *   运行:npm run spike:prompt
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FINDING_CATEGORIES, SEVERITIES } from '../src/shared/domain';
import {
  BUILTIN_SECTIONS,
  mergeLayers,
  parseSeverityLevels,
  serializeSeverityLevels,
} from '../src/shared/prompt';
import {
  BUILTIN_PROTOCOL,
  BUILTIN_ROLE,
  loadBaseInstructions,
  loadReviewPrompt,
  parseReviewMarkdown,
  saveReviewLayer,
  serializeLayer,
} from '../src/backend/prompt/review-prompt';

const log = (m: string) => process.stdout.write(`[prompt] ${m}\n`);

async function main() {
  // 纯合并:project 覆盖 focus,global 覆盖 tone,其余落 builtin
  const merged = mergeLayers({ focus: 'P-FOCUS' }, { tone: 'G-TONE', focus: 'G-FOCUS' });
  const bySrc = Object.fromEntries(merged.resolved.map((s) => [s.key, s]));
  assert.equal(bySrc.focus.source, 'project', 'focus 应 project 胜出');
  assert.equal(bySrc.focus.text, 'P-FOCUS');
  assert.equal(bySrc.tone.source, 'global', 'tone 应 global 胜出');
  assert.equal(bySrc.severity.source, 'builtin', 'severity 无覆盖应 builtin');
  log('分节覆盖 project ▸ global ▸ builtin ✓');

  // 解析:H2 按标题或英文 key;空节不算覆盖;未知标题忽略
  const parsed = parseReviewMarkdown(
    ['## 审核重点', 'AAA', '', '## severity', '', '## 未知节', 'ZZZ', '## 忽略范围', 'BBB'].join('\n'),
  );
  assert.equal(parsed.focus, 'AAA', '中文标题 → focus');
  assert.equal(parsed.ignore, 'BBB', '英文/中文混写皆可解析');
  assert.ok(!('severity' in parsed), '空正文的节不算覆盖');
  log('解析:标题映射 + 空节忽略 + 未知节忽略 ✓');

  // ---- severity 是 structured 节:档位名锁死,只有判定标准可覆盖,且逐档独立 ----
  const sevDef = BUILTIN_SECTIONS.find((s) => s.key === 'severity');
  assert.equal(sevDef?.kind, 'structured', 'severity 应是 structured 节');
  assert.deepEqual(
    sevDef?.fields?.map((f) => f.id),
    [...SEVERITIES],
    '档位必须与 MCP ingress 的 SEVERITIES 枚举一一对应',
  );
  const levels = parseSeverityLevels('- high: 只算安全问题\n- low: 风格');
  assert.equal(levels.high, '只算安全问题');
  assert.ok(!levels.medium, '未写的档位不算覆盖');
  assert.equal(
    serializeSeverityLevels({ low: 'L', high: 'H' }),
    '- high: H\n- low: L',
    'serialize 按 SEVERITIES 固定序',
  );
  // 旧格式(`high = ...;` / `med`)应被迁移读回,而不是整节失效
  const legacy = parseSeverityLevels('high = 崩溃 / 数据损坏;\nmed = 健壮性隐患;\nlow = 风格。');
  assert.equal(legacy.high, '崩溃 / 数据损坏', '旧 `=` 写法应可读回');
  assert.equal(legacy.medium, '健壮性隐患', '旧 `med` 简写应归一到 medium');
  // 逐档独立取层:project 只改 high,medium 仍走 global,low 仍走 builtin
  const sevMerged = mergeLayers(
    { severity: '- high: P-HIGH' },
    { severity: '- high: G-HIGH\n- medium: G-MED' },
  );
  const sevSection = sevMerged.sections.find((s) => s.key === 'severity');
  const winners = Object.fromEntries((sevSection?.fields ?? []).map((f) => [f.id, f.winner]));
  assert.equal(winners.high, 'project', 'high 应 project 胜出');
  assert.equal(winners.medium, 'global', 'medium 应 global 胜出');
  assert.equal(winners.low, 'builtin', 'low 无覆盖应回落 builtin');
  assert.equal(sevSection?.winner, 'project', '整节 provenance 取最具体的一档');
  // 用户拿自造分级(P0/P1)整节覆盖 → 解析不出任何档位,视为未覆盖,builtin 判定标准保留
  const bogus = mergeLayers({ severity: 'P0 = 严重;P1 = 一般' }, {});
  const bogusSection = bogus.sections.find((s) => s.key === 'severity');
  assert.equal(bogusSection?.project, null, '自造档位名不构成覆盖');
  assert.ok(
    bogus.resolved.find((s) => s.key === 'severity')?.text.includes('- high:'),
    '自造档位名不得吞掉 builtin 的 high/medium/low',
  );
  log('severity:档位锁死 + 逐档覆盖 + 旧格式迁移 + 自造分级不生效 ✓');

  // context 无 builtin 默认,未覆盖时不进 baseInstructions
  const home = mkdtempSync(path.join(tmpdir(), 'duetlens-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'duetlens-repo-'));
  const base0 = await loadBaseInstructions({ cwd: repo, homeDir: home });
  assert.ok(base0.startsWith(BUILTIN_ROLE), '应以锁定的角色段打头');
  assert.ok(base0.endsWith(BUILTIN_PROTOCOL), '应以锁定的上报协议收尾(压过用户节里的冲突口径)');
  assert.ok(!base0.includes('## 项目上下文'), 'context 空节应略去');
  assert.ok(base0.includes('## 审核重点'), '有默认的节应在场');
  // builtin 规范应是结构化 8 大类(源自 1.0),而非占位一句话
  for (const cat of ['Scope', 'Correctness', 'Security', 'Architecture', 'Performance']) {
    assert.ok(base0.includes(cat), `focus 应含类别 ${cat}`);
  }
  for (const cat of FINDING_CATEGORIES) {
    assert.ok(base0.includes(cat), `锁定协议应列出 category 规范集 ${cat}`);
  }
  log('无层文件:锁定段首尾夹住 builtin 各节 + context 略去 ✓');

  // ---- 锁定段不下发 renderer,也不被用户层覆盖 ----
  const view0 = await loadReviewPrompt({ cwd: repo, homeDir: home });
  assert.ok(
    !JSON.stringify(view0).includes('report_finding'),
    '编辑器视图不得含锁定段(会让用户以为可改)',
  );
  assert.deepEqual(
    view0.sections.map((s) => s.key),
    [...BUILTIN_SECTIONS.map((s) => s.key)],
    '视图只暴露可配置节',
  );
  log('锁定段不下发编辑器 ✓');

  // 两层文件真实读盘 + 合并
  mkdirSync(path.join(home, '.duetlens'), { recursive: true });
  mkdirSync(path.join(repo, '.duetlens'), { recursive: true });
  writeFileSync(path.join(home, '.duetlens', 'review.md'), '## 输出与语气\n先结论后依据。\n');
  writeFileSync(
    path.join(repo, '.duetlens', 'review.md'),
    '## 审核重点\n关注 IPC 边界。\n\n## 项目上下文\nElectron + codex。\n',
  );
  const view = await loadReviewPrompt({ cwd: repo, homeDir: home });
  const win = Object.fromEntries(view.sections.map((s) => [s.key, s.winner]));
  assert.equal(win.focus, 'project');
  assert.equal(win.tone, 'global');
  assert.equal(win.context, 'project');
  assert.equal(win.severity, 'builtin');
  const base = await loadBaseInstructions({ cwd: repo, homeDir: home });
  assert.ok(base.includes('关注 IPC 边界。'), 'project focus 应注入');
  assert.ok(base.includes('先结论后依据。'), 'global tone 应注入');
  assert.ok(base.includes('## 项目上下文\nElectron + codex。'), 'project context 应注入');
  assert.ok(base.endsWith(BUILTIN_PROTOCOL), '有用户覆盖时协议段仍在最末');
  log('两层读盘 + 合并 + 注入 ✓');

  assert.equal(BUILTIN_SECTIONS.length, 5, '固定 5 节');

  // 序列化:固定节序、H2 用节标题、空节略去、可被 parse 无损回读
  const md = serializeLayer({ ignore: 'X', focus: 'Y', severity: '' });
  assert.equal(md, '## 审核重点\nY\n\n## 忽略范围\nX\n', 'serialize 固定序 + 空节略去');
  const round = parseReviewMarkdown(md);
  assert.equal(round.focus, 'Y');
  assert.equal(round.ignore, 'X');
  assert.ok(!('severity' in round), '空节不回读');
  assert.equal(serializeLayer({}), '', '无覆盖序列化为空串');
  // structured 节落盘前先规范化:脏文本不入库
  assert.equal(
    serializeLayer({ severity: 'medium = 边界情况\n随手写的一句话' }),
    '## 严重度判定\n- medium: 边界情况\n',
    'severity 落盘前归一为逐档格式,无法识别的行丢弃',
  );
  log('序列化:固定序 + 空节略去 + structured 归一 + parse 无损回读 ✓');

  // 写路径:save 落盘 → loadReviewPrompt 读回,project 覆盖生效
  const home2 = mkdtempSync(path.join(tmpdir(), 'duetlens-home2-'));
  const repo2 = mkdtempSync(path.join(tmpdir(), 'duetlens-repo2-'));
  await saveReviewLayer('project', { focus: '只看 IPC 边界。' }, { cwd: repo2 });
  await saveReviewLayer('global', { tone: '先结论。' }, { homeDir: home2 });
  const saved = readFileSync(path.join(repo2, '.duetlens', 'review.md'), 'utf8');
  assert.ok(saved.includes('## 审核重点\n只看 IPC 边界。'), 'project 层落盘含节标题');
  const afterSave = await loadReviewPrompt({ cwd: repo2, homeDir: home2 });
  const wn = Object.fromEntries(afterSave.sections.map((s) => [s.key, s.winner]));
  assert.equal(wn.focus, 'project', '落盘后 focus 由 project 胜出');
  assert.equal(wn.tone, 'global', '落盘后 tone 由 global 胜出');
  assert.equal(afterSave.projectPath, path.join(repo2, '.duetlens', 'review.md'), 'view 回报 project 路径');
  assert.ok(afterSave.globalPath.endsWith(path.join('.duetlens', 'review.md')), 'view 回报 global 路径');
  // 重写为无覆盖 → 该节回落下层
  await saveReviewLayer('project', {}, { cwd: repo2 });
  const cleared = await loadReviewPrompt({ cwd: repo2, homeDir: home2 });
  assert.equal(cleared.sections.find((s) => s.key === 'focus')?.winner, 'builtin', '清空 project 后 focus 回落 builtin');
  // 无 cwd 写 project 应报错
  await assert.rejects(() => saveReviewLayer('project', { focus: 'x' }, {}), /cwd/, '无仓库目录写 project 应报错');
  log('写路径:save 落盘 + 读回 + 清空回落 + 无 cwd 守卫 ✓');

  log('全部通过 ✓');
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
