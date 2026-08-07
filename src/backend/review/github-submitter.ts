/**
 * 把一次 PR review 请求体经 `gh` 原子提交到 GitHub。
 * PR review 全成或全败:一条行锚点失效(422)会让整份被拒 —— 据此区分 invalid / failed。
 */
import type { Review } from '@shared/domain';
import type { PrReviewPayload } from '@shared/github-review';
import type { SubmitReviewResult } from '@shared/ipc';
import { run } from '../source/exec';
import { parsePrRef } from '../source/github-pr-source';

export interface GitHubSubmitter {
  submit(review: Review, payload: PrReviewPayload): Promise<SubmitReviewResult>;
}

/** 422 且信息指向行锚点不在最新 diff 中 → invalid(可修锚点/降级/剔除后重提)。 */
function isLineAnchorError(msg: string): boolean {
  return /422|must be part of|not part of the (pull request|diff)|line must be/i.test(msg);
}

export class GhReviewSubmitter implements GitHubSubmitter {
  async submit(review: Review, payload: PrReviewPayload): Promise<SubmitReviewResult> {
    let nwo: string;
    let num: string;
    try {
      const parsed = parsePrRef(review.sourceRef);
      num = parsed.num;
      nwo = parsed.nwo || (await this.deriveNwo(review.repoPath));
    } catch (e) {
      return { status: 'failed', message: `无法解析 PR 引用:${(e as Error).message}` };
    }

    // PR url 兜底;head sha 仅在 payload 没带时才用这里读到的
    let liveHead: string;
    let prUrl: string;
    try {
      const metaJson = await run('gh', [
        'pr', 'view', num, '--repo', nwo, '--json', 'headRefOid,url',
      ]);
      const meta = JSON.parse(metaJson) as { headRefOid: string; url: string };
      liveHead = meta.headRefOid;
      prUrl = meta.url;
    } catch (e) {
      return { status: 'failed', message: `读取 PR 元数据失败(认证/网络/PR 已关闭?):${(e as Error).message}` };
    }

    // payload 带了 sha 就钉死它:那是 suggestion 补缩进所依据的那份 diff 所属的 commit。
    // 再读一次实时 head 的话,两次读之间的推送会让「按 A 的行补的缩进」提交到 B。
    const { commitId, ...apiPayload } = payload;
    const requestBody = JSON.stringify({ commit_id: commitId ?? liveHead, ...apiPayload });
    try {
      const out = await run(
        'gh',
        ['api', `repos/${nwo}/pulls/${num}/reviews`, '--method', 'POST', '--input', '-'],
        undefined,
        requestBody,
      );
      const res = JSON.parse(out) as { html_url?: string };
      return {
        status: 'success',
        url: res.html_url || prUrl,
        submittedCount: payload.comments.length,
      };
    } catch (e) {
      const msg = (e as Error).message;
      return isLineAnchorError(msg)
        ? { status: 'invalid', message: '一条 finding 的行锚点不在最新 diff 的新增侧,整份 review 被 GitHub 拒(422)。' }
        : { status: 'failed', message: `提交失败(认证/网络/PR 状态?):${msg}` };
    }
  }

  private async deriveNwo(repoPath: string | null): Promise<string> {
    if (!repoPath) throw new Error('PR 引用缺 owner/repo,且 review 无 repoPath');
    const out = await run(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      repoPath,
    );
    return out.trim();
  }
}
