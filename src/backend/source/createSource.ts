import { GitButlerSource } from './GitButlerSource';
import { GitHubPrSource } from './GitHubPrSource';
import { LocalGitSource } from './LocalGitSource';
import type { ReviewTarget, Source } from './Source';

/** 按 target.source 选具体实现。 */
export function createSource(target: ReviewTarget): Source {
  switch (target.source) {
    case 'github-pr':
      return new GitHubPrSource(target);
    case 'local-branch':
      return new LocalGitSource(target);
    case 'gitbutler-vbranch':
      return new GitButlerSource(target);
    default:
      throw new Error(`未支持的 source: ${(target as ReviewTarget).source}`);
  }
}
