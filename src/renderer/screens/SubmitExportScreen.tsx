import { useCallback, useEffect, useState } from 'react';
import type { Finding } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import { useReviewStream } from '../review/useReviewStream';
import { isRerunKey } from '../keys';
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
  onRerun,
}: {
  reviewId: string | null;
  onBack: () => void;
  /** 返回 diff 屏并就地弹出重跑面板;由 App 转成一次 rerunRequest */
  onRerun?: () => void;
}) {
  const { review, findings } = useReviewStream(reviewId);
  const [tab, setTab] = useState<'submit' | 'export'>('submit');
  // 提交在途:待提交集已在后端定稿,这期间任何改 triage 的入口都得冻住
  const [submitting, setSubmitting] = useState(false);
  // 提交屏据以判定锚点的那份 diff(可能已是现拉的最新);转给导出屏,好让两边给 suggestion
  // 补的缩进出自同一行。undefined = 提交屏还没报 / 本 source 没有提交这一步,导出屏自己读快照。
  const [submitDiff, setSubmitDiff] = useState<DiffFile[] | undefined>(undefined);

  // 提交成功与否:决定这一屏还有没有没发出去的东西(见 canRerun)
  const [submitted, setSubmitted] = useState(false);
  // 重跑要离开本屏,而本屏是整屏卸载 —— 提交屏里写到一半的 Review 意见、422 后定位到的失效锚点
  // 都会跟着没。所以 github 的这一屏只在提交成功之后才给重跑入口(与那颗按钮的出现时机同一判据,
  // 藏起来的按钮配一个照样生效的键位,等于给一条 UI 上说不通的丢草稿路径)。
  // 其余 source 没有提交这一步,导出屏就是终点,一直可重跑。提交在途 / 仍在扫描时一律不给。
  const canRerun =
    !!onRerun &&
    !submitting &&
    !!review &&
    review.status !== 'scanning' &&
    (review.source !== 'github-pr' || submitted);
  const rerun = useCallback(() => {
    if (!canRerun) return;
    onRerun?.();
  }, [canRerun, onRerun]);

  // ⌘E:与审核屏同一个键、同一份判据
  useEffect(() => {
    if (!canRerun) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isRerunKey(e)) return;
      e.preventDefault();
      rerun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canRerun, rerun]);

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
            onDoneChange={setSubmitted}
            onDiffChange={setSubmitDiff}
            onRerun={canRerun ? rerun : undefined}
          />
        </div>
        <div className="se-pane" hidden={tab !== 'export'}>
          <ExportMarkdownScreen
            review={review}
            findings={findings}
            onBack={onBack}
            onToggleKeep={onToggleKeep}
            tabs={tabs}
            diff={submitDiff}
            onRerun={canRerun ? rerun : undefined}
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
      onRerun={canRerun ? rerun : undefined}
    />
  );
}
