import type { CompletionNotice, ReviewEvent } from '@shared/ipc';

/**
 * 从领域事件流里挑出「长任务完成」信号,按窗口聚焦态与偏好决定提示方式。
 * 依赖全部注入,决策逻辑纯粹可测(见 spike:notify);Electron/Notification 归 main 提供。
 *
 * 完成信号:
 *   - status → 'reviewing':首轮扫描结束(每 review 只提示一次)
 *   - message role='agent':某条 discussion 的追问有新回复
 */
export interface CompletionNotifierDeps {
  /** 窗口是否聚焦(main: BrowserWindow.isFocused) */
  isFocused: () => boolean;
  /** 用户是否开启完成提示(main: ReviewManager.getUiSettings().notifyOnComplete) */
  isEnabled: () => boolean;
  /** review 展示名(标题优先,退回来源 ref) */
  reviewLabel: (reviewId: string) => string;
  /** 未聚焦:弹原生系统通知 */
  notifyNative: (notice: CompletionNotice) => void;
  /** 聚焦:推应用内轻提示 */
  notifyInApp: (notice: CompletionNotice) => void;
}

export function createCompletionNotifier(deps: CompletionNotifierDeps): (e: ReviewEvent) => void {
  const scanNotified = new Set<string>();
  return (e) => {
    if (!deps.isEnabled()) return;

    let notice: CompletionNotice | null = null;
    if (e.type === 'status' && e.payload === 'reviewing') {
      if (scanNotified.has(e.reviewId)) return;
      scanNotified.add(e.reviewId);
      notice = {
        reviewId: e.reviewId,
        kind: 'scan-done',
        title: '扫描完成',
        body: `${deps.reviewLabel(e.reviewId)} · 首轮机审已就绪`,
      };
    } else if (e.type === 'message' && e.payload.role === 'agent') {
      notice = {
        reviewId: e.reviewId,
        kind: 'reply',
        title: 'codex 回复',
        body: `${deps.reviewLabel(e.reviewId)} · 追问有新回复`,
        discussionId: e.payload.discussionId,
      };
    }
    if (!notice) return;

    if (deps.isFocused()) deps.notifyInApp(notice);
    else deps.notifyNative(notice);
  };
}
