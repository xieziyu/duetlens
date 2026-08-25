import { CapacityNotice } from 'duetlens';

const noop = () => {};

const capacity = {
  max: 3,
  live: 3,
  busy: [
    {
      reviewId: 'r1',
      title: '#482 · feat: streaming transcode pipeline',
      sourceRef: 'xieziyu/podcast-go#482',
      source: 'github-pr' as const,
      round: 1,
      scanning: true,
    },
    {
      reviewId: 'r2',
      title: 'fix: 追问回复丢失最后一段',
      sourceRef: 'feat/live-activity-comment',
      source: 'local-branch' as const,
      round: 2,
      scanning: false,
    },
    {
      reviewId: 'r3',
      title: 'refactor: 收敛 review 事件转发表',
      sourceRef: 'refactor/deprecate-podcaster-auth',
      source: 'gitbutler-vbranch' as const,
      round: 1,
      scanning: true,
    },
  ],
};

/** 入口屏的发起门控:常驻拦截,故不给关闭出口。 */
export const BlockingNewReview = () => (
  <CapacityNotice capacity={capacity} onOpen={noop} onRefresh={noop} />
);

/** 追问被挡下:blocked 那半句随调用方走,并给一个关掉的出口。 */
export const BlockingFollowUp = () => (
  <CapacityNotice
    capacity={capacity}
    blocked="现在没法追问"
    onOpen={noop}
    onRefresh={noop}
    onDismiss={noop}
  />
);

/** 没有 onOpen 时:在跑的那几条渲染成不可点的纯文本(调用方没有那条通路)。 */
export const WithoutOpenPath = () => (
  <CapacityNotice capacity={capacity} onRefresh={noop} onDismiss={noop} />
);
