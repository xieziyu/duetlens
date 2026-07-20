import { GitHubPrSource } from './GitHubPrSource';
import { LocalGitSource } from './LocalGitSource';
import type { ReviewTarget, Source } from './Source';

/** 按 target.source 选具体实现。gitbutler-vbranch 待接 `but` CLI。 */
export function createSource(target: ReviewTarget): Source {
  switch (target.source) {
    case 'github-pr':
      return new GitHubPrSource(target);
    case 'local-branch':
      return new LocalGitSource(target);
    case 'gitbutler-vbranch':
      throw new Error('gitbutler-vbranch source 待实现(接 but CLI diff)');
    default:
      throw new Error(`未支持的 source: ${(target as ReviewTarget).source}`);
  }
}
