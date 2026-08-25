import { AppRail } from 'duetlens';

const noop = () => {};

/** 停在入口屏;还没有活跃 review,「当前审核」不可达。 */
export const OnEntry = () => (
  <AppRail active="entry" reviewAvailable={false} onNavigate={noop} />
);

/** 审核进行中:rail 高亮「当前审核」,可在各屏间来回。 */
export const OnReview = () => (
  <AppRail active="review" reviewAvailable onNavigate={noop} />
);

/** 新版已下好、只差重启:设置钮挂未读点,点进去直接落到「关于」那行。 */
export const UpdateReady = () => (
  <AppRail active="settings" reviewAvailable updateReady onNavigate={noop} />
);
