import { useCallback } from 'react';
import type { Finding } from '@shared/domain';
import { useReviewStream } from '../review/useReviewStream';
import { ExportMarkdownScreen } from './export/ExportMarkdownScreen';
import { ScreenPlaceholder } from '../components/ScreenPlaceholder';

/**
 * review 的终点步骤:github-pr source 走「提交到 GitHub」(待做),
 * 本地/vbranch source 走「导出 Markdown」。按 review.source 分派。
 */
export function SubmitExportScreen({
  reviewId,
  onBack,
}: {
  reviewId: string | null;
  onBack: () => void;
}) {
  const { review, findings } = useReviewStream(reviewId);

  const onToggleKeep = useCallback(
    (f: Finding) => {
      if (!reviewId) return;
      // 保留 → dismiss;已剔除 → keep(复位到明确保留态,不回 open)
      const next = f.triage === 'dismiss' ? 'keep' : 'dismiss';
      void window.duetlens.review.setTriage(reviewId, f.id, next);
    },
    [reviewId],
  );

  if (!reviewId || !review) {
    return (
      <ScreenPlaceholder
        title="提交 / 导出"
        mockup="从审核屏进入"
        parts={['先在入口发起或打开一次 review,再进入提交/导出']}
      />
    );
  }

  if (review.source === 'github-pr') {
    return (
      <ScreenPlaceholder
        title="提交到 GitHub"
        mockup="mockup/submit-to-github.html"
        parts={['SubmitGitHubScreen(findings 筛选 + 一次原子 PR review)——后续切片']}
      />
    );
  }

  return (
    <ExportMarkdownScreen
      review={review}
      findings={findings}
      onBack={onBack}
      onToggleKeep={onToggleKeep}
    />
  );
}
