import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from './exec';
import type { PreparedSource, ReviewTarget, Source } from './source';

/** 解析 PR 引用:完整 URL / owner/repo#123 / 纯号(需 repoPath 推断仓库)。 */
export function parsePrRef(ref: string): { nwo: string; num: string } {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { nwo: url[1], num: url[2] };
  const short = ref.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/);
  if (short) return { nwo: short[1], num: short[2] };
  const numOnly = ref.match(/^#?(\d+)$/);
  if (numOnly) return { nwo: '', num: numOnly[1] };
  throw new Error(`无法解析 PR 引用: ${ref}`);
}

/**
 * GitHub PR source:diff 走 `gh pr diff`,文件走 `gh api .../contents`(按 head sha),
 * 无需本地 clone。可选 repoPath 仅用作 codex cwd;缺省用临时空目录。
 */
export class GitHubPrSource implements Source {
  private nwo = '';
  private num = '';
  private headSha = '';
  private tmp?: string;

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const parsed = parsePrRef(this.target.ref);
    this.num = parsed.num;
    this.nwo = parsed.nwo || (await this.deriveNwo());

    const metaJson = await run('gh', [
      'pr', 'view', this.num, '--repo', this.nwo,
      '--json', 'title,number,headRefOid,url',
    ]);
    const meta = JSON.parse(metaJson) as { title: string; number: number; headRefOid: string };
    this.headSha = meta.headRefOid;

    const cwd = this.target.repoPath || (this.tmp = mkdtempSync(path.join(tmpdir(), 'duetlens-pr-')));
    return { title: `#${meta.number} · ${meta.title}`, cwd };
  }

  async getDiff(): Promise<string> {
    return run('gh', ['pr', 'diff', this.num, '--repo', this.nwo]);
  }

  async getFile(path: string): Promise<string> {
    try {
      const b64 = await run('gh', [
        'api', `repos/${this.nwo}/contents/${encodeURIComponent(path)}?ref=${this.headSha}`,
        '--jq', '.content',
      ]);
      return Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch {
      return `// 无法读取 ${path}`;
    }
  }

  async dispose(): Promise<void> {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }

  private async deriveNwo(): Promise<string> {
    if (!this.target.repoPath) throw new Error('PR 引用缺 owner/repo,且未提供 repoPath');
    const out = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], this.target.repoPath);
    return out.trim();
  }
}
