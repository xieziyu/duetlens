import { useEffect } from 'react';
import type { CompletionNotice } from '@shared/ipc';
import './CompletionToast.css';

const DISMISS_MS = 6000;

/** 聚焦态的轻量完成提示;点击打开对应 review,若干秒后自动消失。 */
export function CompletionToast({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: CompletionNotice;
  onOpen: (reviewId: string) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);

  return (
    <div className="toast-wrap">
      <div
        className={`toast toast-${notice.kind}`}
        role="status"
        onClick={() => onOpen(notice.reviewId)}
      >
        <span className="toast-glyph" />
        <div className="toast-body">
          <div className="toast-title">{notice.title}</div>
          <div className="toast-text">{notice.body}</div>
        </div>
        <button
          className="toast-close"
          title="关闭"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
