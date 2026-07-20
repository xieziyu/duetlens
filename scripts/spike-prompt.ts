/**
 * 确定性验证审核规则提示词的分层解析/合并/注入(不走 codex/不烧 token)。
 * 造临时 project(.duetlens/review.md)+ global(homeDir/.duetlens/review.md)两层,
 * 断言分节覆盖(project ▸ global ▸ builtin)与 baseInstructions 组装。
 *   运行:npm run spike:prompt
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PREAMBLE,
  BUILTIN_SECTIONS,
  loadReviewPrompt,
  parseReviewMarkdown,
  mergeLayers,
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

  // context 无 builtin 默认,未覆盖时不进 baseInstructions
  const home = mkdtempSync(path.join(tmpdir(), 'duetlens-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'duetlens-repo-'));
  const onlyBuiltin = await loadReviewPrompt({ cwd: repo, homeDir: home });
  assert.ok(onlyBuiltin.baseInstructions.startsWith(BUILTIN_PREAMBLE), '应以操作性前言打头');
  assert.ok(!onlyBuiltin.baseInstructions.includes('## 项目上下文'), 'context 空节应略去');
  assert.ok(onlyBuiltin.baseInstructions.includes('## 审核重点'), '有默认的节应在场');
  // builtin 规范应是结构化 8 大类(源自 1.0),而非占位一句话
  for (const cat of ['Scope', 'Correctness', 'Security', 'Architecture', 'Performance']) {
    assert.ok(onlyBuiltin.baseInstructions.includes(cat), `focus 应含类别 ${cat}`);
  }
  assert.ok(onlyBuiltin.baseInstructions.includes('Error Handling'), 'tone 应列出 category 规范集');
  log('无层文件:builtin 打底 + 8 大类规范 + context 略去 ✓');

  // 两层文件真实读盘 + 合并
  mkdirSync(path.join(home, '.duetlens'), { recursive: true });
  mkdirSync(path.join(repo, '.duetlens'), { recursive: true });
  writeFileSync(path.join(home, '.duetlens', 'review.md'), '## 输出与语气\n先结论后依据。\n');
  writeFileSync(path.join(repo, '.duetlens', 'review.md'), '## 审核重点\n关注 IPC 边界。\n\n## 项目上下文\nElectron + codex。\n');
  const view = await loadReviewPrompt({ cwd: repo, homeDir: home });
  const win = Object.fromEntries(view.sections.map((s) => [s.key, s.winner]));
  assert.equal(win.focus, 'project');
  assert.equal(win.tone, 'global');
  assert.equal(win.context, 'project');
  assert.equal(win.severity, 'builtin');
  assert.ok(view.baseInstructions.includes('关注 IPC 边界。'), 'project focus 应注入');
  assert.ok(view.baseInstructions.includes('先结论后依据。'), 'global tone 应注入');
  assert.ok(view.baseInstructions.includes('## 项目上下文\nElectron + codex。'), 'project context 应注入');
  log('两层读盘 + 合并 + 注入 ✓');

  assert.equal(BUILTIN_SECTIONS.length, 5, '固定 5 节');
  log('全部通过 ✓');
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
