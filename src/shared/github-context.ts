/**
 * 从 GitHub PR 拉回来的协作上下文(复审轮次的输入之一)。
 *
 * 这些内容全部是**外部数据**:PR 上任何人都能写。注入 agent 前必须包一层隔离前言
 * (见 backend/prompt/rerun-prompt.ts),只当作参考材料,绝不当作指令执行。
 */

export interface PrThreadComment {
  author: string;
  body: string;
  createdAt: string;
  /** REST 侧数值 id;跨轮次识别同一条评论用 */
  databaseId: number | null;
}

/** 一条 inline review thread(我们提交的 finding 也会形成这样一条)。 */
export interface PrReviewThread {
  path: string | null;
  line: number | null;
  /** 作者点了 Resolve —— 通常意味着该意见已被处理 */
  isResolved: boolean;
  /** 锚点所在代码已被后续 commit 改动,GitHub 标记为 outdated */
  isOutdated: boolean;
  comments: PrThreadComment[];
}

export interface PrIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** 一次 PR review 的表态与总述(inline 评论在 threads 里)。 */
export interface PrReviewSummary {
  author: string;
  state: string;
  body: string;
  submittedAt: string | null;
}

export interface PrContext {
  /** PR 作者的 login;用于把「原作者的话」与其他 reviewer 区分开 */
  author: string;
  /** 当前 gh 登录身份;用于识别哪些 thread 是我方发起的 */
  viewer: string;
  title: string;
  body: string;
  headSha: string | null;
  threads: PrReviewThread[];
  issueComments: PrIssueComment[];
  reviews: PrReviewSummary[];
  fetchedAt: number;
}

/** 拉取失败时的降级值:上下文缺失不阻断复审。 */
export function emptyPrContext(): PrContext {
  return {
    author: '',
    viewer: '',
    title: '',
    body: '',
    headSha: null,
    threads: [],
    issueComments: [],
    reviews: [],
    fetchedAt: 0,
  };
}
