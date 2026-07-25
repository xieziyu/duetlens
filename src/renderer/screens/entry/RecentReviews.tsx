import type { RecentReview } from '@shared/ipc';
import type { ReviewStatus, SourceKind } from '@shared/domain';
import { GhIcon, GitButlerIcon, LocalBranchIcon } from './icons';

/** 最近审核列表:源徽标 + 标题 + 计数/状态元信息;空态给首次引导。 */
export function RecentReviews({
  reviews,
  onOpen,
}: {
  reviews: RecentReview[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="recent-section">
      <div className="section-head">
        <h3 className="mono">最近的审核</h3>
        {reviews.length > 0 && <span className="count mono">{reviews.length}</span>}
      </div>

      {reviews.length === 0 ? (
        <div className="empty-history">
          <div className="eh-ic">◇</div>
          <div className="eh-t">还没有审核记录</div>
          <div className="eh-s">
            在上面粘贴一个 PR 链接,或选择本地分支 / GitButler 来源,开始你的第一次协同 review。完成的审核会留在这里,随时可以恢复。
          </div>
        </div>
      ) : (
        <div className="recent-list">
          {reviews.map((r) => (
            <div key={r.id} className="recent-rev" onClick={() => onOpen(r.id)}>
              <SourceBadge source={r.source} sourceRef={r.sourceRef} />
              <div className="m">
                <div className="t">{r.title ?? r.sourceRef}</div>
                <div className="meta mono">
                  <span>{repoLabel(r)}</span>
                  <span className="dot" />
                  <span className={r.findingCount === 0 ? 'find zero' : 'find'}>{r.findingCount} findings</span>
                  {r.submittedCount > 0 ? (
                    <>
                      <span className="dot" />
                      <span className="sub">{r.submittedCount} 已提交</span>
                    </>
                  ) : r.discussionCount > 0 ? (
                    <>
                      <span className="dot" />
                      <span>{r.discussionCount} discussions</span>
                    </>
                  ) : null}
                </div>
              </div>
              <StatusChip status={r.status} />
              <span className="arrow">→</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source, sourceRef }: { source: SourceKind; sourceRef: string }) {
  if (source === 'github-pr') {
    const num = sourceRef.match(/#?(\d+)/)?.[1];
    return (
      <span className="srcbadge gh">
        <GhIcon />
        <b>{num ? `#${num}` : 'PR'}</b>
      </span>
    );
  }
  if (source === 'gitbutler-vbranch') {
    return (
      <span className="srcbadge gb">
        <GitButlerIcon />
        vbranch
      </span>
    );
  }
  return (
    <span className="srcbadge local">
      <LocalBranchIcon />
      本地
    </span>
  );
}

const STATUS_META: Record<ReviewStatus, { cls: string; label: string; pulse?: boolean }> = {
  scanning: { cls: 'scanning', label: '扫描中', pulse: true },
  reviewing: { cls: 'review', label: '审核中', pulse: true },
  completed: { cls: 'done', label: '已完成' },
  submitted: { cls: 'submitted', label: '✓ 已提交' },
  failed: { cls: 'failed', label: '✕ 失败' },
};

function StatusChip({ status }: { status: ReviewStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`stat ${m.cls}`}>
      {m.pulse && <span className="pulse" />}
      {m.label}
    </span>
  );
}

/** 展示用仓库名:优先本地路径 basename,其次从 github sourceRef 取 repo 段。 */
function repoLabel(r: RecentReview): string {
  if (r.repoPath) {
    const base = r.repoPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (base) return base;
  }
  if (r.source === 'github-pr') {
    const m = r.sourceRef.match(/([^/]+)\/([^/#]+)/);
    if (m) return m[2];
  }
  return r.source;
}
