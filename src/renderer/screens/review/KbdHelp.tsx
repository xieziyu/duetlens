import { useEffect, useRef } from 'react';

// 键盘快捷键浮层。仅列已实现的快捷键。
const GROUPS: { title: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    title: '导航',
    rows: [
      { label: '打开 / 关闭本帮助', keys: ['?'] },
      { label: '关闭弹层 · 取消编辑', keys: ['Esc'] },
      { label: '切到 Discussion / Findings / Summary', keys: ['1', '2', '3'] },
    ],
  },
  {
    title: 'Diff',
    rows: [{ label: 'Unified / Split 切换', keys: ['u'] }],
  },
  {
    title: 'Finding / 总结编辑',
    rows: [
      { label: '保存编辑', keys: ['⌘', '↵'] },
      { label: '取消编辑', keys: ['Esc'] },
    ],
  },
  {
    title: 'Discussion',
    rows: [
      { label: '发送回复 / 追问', keys: ['⌘', '↵'] },
      { label: '输入框内换行', keys: ['↵'] },
    ],
  },
];

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function KbdHelp({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 模态焦点管理:打开时把焦点移入弹层并记住来处,关闭后归还;Tab 在弹层内循环。
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const act = document.activeElement;
    if (e.shiftKey && act === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && act === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="kbd-overlay show" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="kbd-panel"
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="kh">
          <h2>键盘快捷键</h2>
          <span className="khs">按 ? 随时唤起</span>
          <button className="kx" onClick={onClose} title="关闭 (Esc)" ref={closeRef}>
            ✕
          </button>
        </div>
        <div className="kbd-cols">
          {GROUPS.map((g) => (
            <div key={g.title} className="kbd-grp">
              <h3>{g.title}</h3>
              {g.rows.map((r) => (
                <div key={r.label} className="krow">
                  {r.label}
                  <span className="kd">
                    {r.keys.map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="kbd-foot">⌘ 在 Windows / Linux 为 Ctrl · 焦点在输入框时快捷键自动让位</div>
      </div>
    </div>
  );
}
