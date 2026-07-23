/**
 * 框选 diff 代码后浮出的动作条:选区 file:行范围 +
 * 「发起 discussion」(human 琥珀)/「追问 codex」(agent 天蓝)/「记为 finding」。
 * 纯呈现:定位与选区解析在 DiffPane 里,这里只画。
 */
export interface SelectionPopoverProps {
  label: string;
  /** 固定定位坐标(viewport) */
  top: number;
  left: number;
  /** 箭头相对 popover 左边的水平位置(px) */
  cx: number;
  onDiscussion: () => void;
  onAsk: () => void;
  onFinding: () => void;
}

export function SelectionPopover({
  label,
  top,
  left,
  cx,
  onDiscussion,
  onAsk,
  onFinding,
}: SelectionPopoverProps) {
  return (
    <div
      className="sel-pop show"
      style={{ top, left, ['--cx' as string]: `${cx}px` }}
      // 阻止 mousedown 冒泡到全局关闭逻辑,否则点按钮会先清掉选区
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="sp-range">{label}</span>
      <button className="sp-disc" onClick={onDiscussion}>
        ⬆ 发起 discussion
      </button>
      <button className="sp-ask" onClick={onAsk}>
        ◆ 追问 agent
      </button>
      <button className="sp-finding" onClick={onFinding}>
        ＋ 记为 finding
      </button>
    </div>
  );
}
