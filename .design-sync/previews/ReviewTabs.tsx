import { ReviewTabs } from 'duetlens';

const noop = () => {};

const meta = {
  r1: {
    title: '#482 · feat: streaming transcode pipeline',
    sourceRef: 'xieziyu/podcast-go#482',
    source: 'github-pr' as const,
    repoPath: null,
    status: 'reviewing' as const,
    unread: 0,
  },
  r2: {
    title: 'fix: 追问回复丢失最后一段',
    sourceRef: 'feat/live-activity-comment',
    source: 'local-branch' as const,
    repoPath: '~/Projects/duetlens',
    status: 'scanning' as const,
    unread: 3,
  },
  r3: {
    title: 'refactor: 收敛 review 事件转发表',
    sourceRef: 'refactor/deprecate-podcaster-auth',
    source: 'gitbutler-vbranch' as const,
    repoPath: '~/Projects/duetlens',
    status: 'failed' as const,
    unread: 0,
  },
};

const tabs = [
  { reviewId: 'r1', view: 'review' as const },
  { reviewId: 'r2', view: 'review' as const },
  { reviewId: 'r3', view: 'submit' as const },
];

/** 三枚 tab:活跃的 PR、在扫描且有未读的本地分支、失败的 vbranch。 */
export const ThreeOpenReviews = () => (
  <ReviewTabs
    tabs={tabs}
    activeId="r1"
    meta={meta}
    notice={null}
    onActivate={noop}
    onClose={noop}
    onNew={noop}
  />
);

/** 关掉一枚后的一步回头路;sticky = 等用户自己决定,不定时收走。 */
export const WithUndoNotice = () => (
  <ReviewTabs
    tabs={tabs.slice(0, 2)}
    activeId="r2"
    meta={meta}
    notice={{ text: '已关闭「refactor: 收敛 review 事件转发表」', action: { label: '重新打开', onRun: noop }, sticky: true }}
    onActivate={noop}
    onClose={noop}
    onNew={noop}
  />
);

/** 只剩一枚:＋ 仍在,回入口发起新审核。 */
export const SingleTab = () => (
  <ReviewTabs
    tabs={tabs.slice(0, 1)}
    activeId="r1"
    meta={meta}
    notice={null}
    onActivate={noop}
    onClose={noop}
    onNew={noop}
  />
);
