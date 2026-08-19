import { run } from './exec';
import { gitGrep } from './git-grep';
import type {
  CodeSearchInput,
  CodeSearchResult,
  PreparedSource,
  ReviewTarget,
  Source,
} from './source';

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
      // 抛而不是回一句占位文本:读失败必须与读到内容可分,否则取证闸会把一次失败的读取
      // 当成「读过了」——锚到不存在文件的 finding 就能凭一次注定失败的 get_file 解锁裁决。
      throw new Error(`无法读取 ${path}(可能已删除或不在 ${this.head})`);
    }
  }

  /** 与 {@link getFile} 同口径:搜 head 那棵树,不是工作区 —— 否则行号对不上读回的内容。 */
  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return gitGrep(this.target.repoPath, input.query, {
      treeish: this.head,
      pathPrefix: input.pathPrefix,
    });
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
