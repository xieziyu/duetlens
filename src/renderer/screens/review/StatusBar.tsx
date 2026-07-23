import type { ReviewStatus } from '@shared/domain';
import type { DiffView } from './DiffPane';

const STATUS_LABEL: Record<ReviewStatus, string> = {
  scanning: '扫描中',
  reviewing: '审核中',
  submitted: '已提交',
  exported: '已导出',
  failed: '失败',
};

/**
 * review 屏底部状态栏(→ mockup/diff-review.html .statusbar):agent 运行态从顶栏下沉到此,
 * 顶栏只留导航与上下文。右侧放全局 diff 视图与通读进度。
 */
export function ReviewStatusBar({
  status,
  model,
  effort,
  tokenUsage,
  lastTool,
  view,
  onViewChange,
  fileCount,
  viewedCount,
  onOpenHelp,
}: {
  status: ReviewStatus | null;
  model: string | null;
  effort: string | null;
  tokenUsage: { used: number; total?: number } | null;
  lastTool: string | null;
  view: DiffView;
  onViewChange: (v: DiffView) => void;
  fileCount: number;
  viewedCount: number;
  onOpenHelp: () => void;
}): React.JSX.Element {
  const st = status ?? 'scanning';
  const running = st === 'scanning' || st === 'reviewing';
  const pct = tokenUsage?.total ? Math.round((tokenUsage.used / tokenUsage.total) * 100) : null;

  return (
    <footer className="rev-statusbar">
      <span className={`sb-status s-${st}`}>
        {running && <span className="pulse" />}
        {STATUS_LABEL[st]}
      </span>
      <span className="sb-item" title="审阅 agent">
        <span className="glyph" />
        codex{model ? ` · ${model}` : ''}
      </span>
      {effort && (
        <span className="sb-item mono" title="reasoning effort">
          effort {effort}
        </span>
      )}
      {tokenUsage && (
        <>
          <span className="sb-sep" />
          <span className="sb-item" title={pct !== null ? `上下文用量 ${pct}%` : '累计 token 用量'}>
            {pct !== null && (
              <svg className="ring" viewBox="0 0 18 18" style={{ ['--ctx' as string]: (pct / 100).toString() }}>
                <circle className="bg" cx="9" cy="9" r="7" />
                <circle className="fg" cx="9" cy="9" r="7" />
              </svg>
            )}
            <span className="mono">
              {tokenUsage.used.toLocaleString()} tok{pct !== null ? ` · ${pct}%` : ''}
            </span>
          </span>
        </>
      )}
      {lastTool && (
        <span className="sb-item mono sb-tool" title={`最近工具调用:${lastTool}`}>
          ⚙ {lastTool}
        </span>
      )}

      <span className="sb-spacer" />

      {fileCount > 0 && (
        <span className="sb-item mono" title="通读进度">
          {fileCount} 文件 · {viewedCount} 已看
        </span>
      )}
      <span className="sb-seg" role="group" aria-label="diff 视图">
        {(['unified', 'split'] as DiffView[]).map((v) => (
          <button
            key={v}
            className={view === v ? 'on' : ''}
            onClick={() => onViewChange(v)}
            aria-pressed={view === v}
          >
            {v === 'unified' ? 'Unified' : 'Split'}
          </button>
        ))}
      </span>
      <button className="sb-item act" onClick={onOpenHelp} title="键盘快捷键 (?)">
        ⌘ 快捷键
      </button>
    </footer>
  );
}
