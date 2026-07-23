import { run } from './exec';
import type { PreparedSource, ReviewTarget, Source } from './source';

/**
 * 本地分支 source:diff 当前分支相对基线(base...head 三点,即 head 自 merge-base 起的改动)。
 * 文件读 head 版本(git show),不依赖工作区当前 checkout 状态。
 */
export class LocalGitSource implements Source {
  private head = '';
  private base = '';

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    const repo = this.target.repoPath;
    this.head =
      this.target.ref?.trim() ||
      (await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    this.base = this.target.baseRef ?? (await this.detectBase(repo));
    const subject = (await run('git', ['-C', repo, 'log', '-1', '--format=%s', this.head])).trim();
    const headSha = (await run('git', ['-C', repo, 'rev-parse', this.head])).trim();
    return { title: `${this.head} · ${subject}`, cwd: repo, headSha };
  }

  async getDiff(): Promise<string> {
    return run('git', ['-C', this.target.repoPath, 'diff', `${this.base}...${this.head}`]);
  }

  async getFile(path: string): Promise<string> {
    try {
      return await run('git', ['-C', this.target.repoPath, 'show', `${this.head}:${path}`]);
    } catch {
      return `// 无法读取 ${path}(可能已删除或不在 ${this.head})`;
    }
  }

  async dispose(): Promise<void> {}

  private async detectBase(repo: string): Promise<string> {
    for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        await run('git', ['-C', repo, 'rev-parse', '--verify', b]);
        return b;
      } catch {
        // 试下一个
      }
    }
    // 兜底:根提交
    const root = (await run('git', ['-C', repo, 'rev-list', '--max-parents=0', 'HEAD'])).trim();
    return root.split('\n')[0];
  }
}
