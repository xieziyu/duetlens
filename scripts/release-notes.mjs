// 从 CHANGELOG 抽出某个版本那一节,拼成 GitHub Release 的 notes(中文在前,英文在后)。
// CI 建草稿前调这个脚本 —— notes 与 CHANGELOG 是同一份来源,发版时没有第二处要手工同步。
// 抽不到就非零退出:宁可让发布卡在这里,也别发出一个 notes 空着的版本。
//
//   node scripts/release-notes.mjs 0.2.0

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

/** 返回 `## [version]` 到下一个 `## ` 之间的正文,以及紧随其后的那个版本号。 */
function section(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!body) return null;

  const next = end === -1 ? null : /^## \[([^\]]+)\]/.exec(rest[end])?.[1];
  return { body, previous: next ?? null };
}

const zh = section(join(repoRoot, 'CHANGELOG.md'));
if (!zh) {
  console.error(`::error::CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

const en = section(join(repoRoot, 'CHANGELOG.en.md'));
if (!en) {
  console.error(`::error::CHANGELOG.en.md has no section for ${version}`);
  process.exit(1);
}

const parts = [zh.body, '---', en.body];
if (zh.previous) {
  const repo = 'https://github.com/xieziyu/duetlens';
  parts.push(`**Full Changelog**: ${repo}/compare/v${zh.previous}...v${version}`);
}

process.stdout.write(`${parts.join('\n\n')}\n`);
