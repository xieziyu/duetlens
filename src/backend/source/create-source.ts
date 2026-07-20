import { GitButlerSource } from './gitbutler-source';
import { GitHubPrSource } from './github-pr-source';
import { LocalGitSource } from './local-git-source';
import type { ReviewTarget, Source } from './source';

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
