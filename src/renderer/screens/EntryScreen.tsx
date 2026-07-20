import { ScreenPlaceholder } from '../components/ScreenPlaceholder';

// → mockup/entry.html:Hero + 发起审核卡片 + 最近的审核
export function EntryScreen() {
  return (
    <ScreenPlaceholder
      title="入口 · Launcher"
      mockup="mockup/entry.html"
      parts={['Hero', 'StartReviewCard(source segmented / PR 输入 / 附加上下文)', 'RecentReviews']}
    />
  );
}
