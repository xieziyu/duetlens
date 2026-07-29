import { useCallback, useState } from 'react';
import type { Finding } from '@shared/domain';
import { useReviewStream } from '../review/useReviewStream';
import { ExportMarkdownScreen } from './export/ExportMarkdownScreen';
import { SubmitGitHubScreen } from './submit/SubmitGitHubScreen';
import { ScreenPlaceholder } from '../components/ScreenPlaceholder';
import './SubmitExportScreen.css';

/**
 * review 的终点步骤:github-pr 有两个并列终点(提交到 GitHub / 导出 Markdown),顶栏分段切换;
 * 本地/vbranch 无 PR 可提交,只有导出。
 */
export function SubmitExportScreen({
  reviewId,
  onBack,
}: {
  reviewId: string | null;
  onBack: () => void;
}) {
  const { review, findings } = useReviewStream(reviewId);
  const [tab, setTab] = useState<'submit' | 'export'>('submit');
  // 提交在途:待提交集已在后端定稿,这期间任何改 triage 的入口都得冻住
  const [submitting, setSubmitting] = useState(false);

  const onToggleKeep = useCallback(
    (f: Finding) => {
      if (!reviewId || submitting) return;
      // 保留 → dismiss;已剔除 → keep(复位到明确保留态,不回 open)
      const next = f.triage === 'dismiss' ? 'open' : 'dismiss';
      void window.duetlens.review.setTriage(reviewId, f.id, next);
    },
    [reviewId, submitting],
  );

  if (!reviewId || !review) {
    return (
      <ScreenPlaceholder
        title="提交 / 导出"
        hint="从审核屏进入"
        parts={['先在入口发起或打开一次 review,再进入提交/导出']}
      />
    );
  }

  if (review.source === 'github-pr') {
    const tabs = (
      <div className="se-tabs">
        <button
          className={tab === 'submit' ? 'on' : ''}
          onClick={() => setTab('submit')}
          disabled={submitting}
        >
          提交到 GitHub
        </button>
        <button
          className={tab === 'export' ? 'on' : ''}
          onClick={() => setTab('export')}
          disabled={submitting}
          title={submitting ? '提交进行中,结束后可切换' : undefined}
        >
          导出 Markdown
        </button>
      </div>
    );
    /* 两块都挂着、只藏不卸:提交屏里有写到一半的 Review 意见、422 后定位到的失效锚点、
       现拉的最新 diff —— 切过去看一眼报告再切回来,这些不该没了(重挂还会再拉一次 PR)。 */
    return (
      <>
        <div className="se-pane" hidden={tab !== 'submit'}>
          <SubmitGitHubScreen
            review={review}
            findings={findings}
            onBack={onBack}
            tabs={tabs}
            onBusyChange={setSubmitting}
          />
        </div>
        <div className="se-pane" hidden={tab !== 'export'}>
          <ExportMarkdownScreen
            review={review}
            findings={findings}
            onBack={onBack}
            onToggleKeep={onToggleKeep}
            tabs={tabs}
          />
        </div>
      </>
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
