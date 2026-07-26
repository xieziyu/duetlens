import { PencilIcon } from './PencilIcon';

/**
 * 框选 diff 代码后浮出的动作条:选区 file:行范围 + 单枚「就此处批注」。
 * 只有一个动作是有意的 —— 提问与记 finding 已合到同一张 composer 卡里(见 AnnotateComposer),
 * 在弹层里预先分叉等于逼用户在打字前就下结论。浮层本身保留:框选常常只是想复制代码,不该直接弹卡。
 * 纯呈现:定位与选区解析在 DiffPane 里,这里只画。
 */
export interface SelectionPopoverProps {
  label: string;
  /** 固定定位坐标(viewport) */
  top: number;
  left: number;
  onAnnotate: () => void;
}

export function SelectionPopover({ label, top, left, onAnnotate }: SelectionPopoverProps) {
  return (
    <div
      className="sel-pop show"
      style={{ top, left }}
      // 阻止 mousedown 冒泡到全局关闭逻辑,否则点按钮会先清掉选区
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="sp-range">{label}</span>
      <button className="sp-annotate" onClick={onAnnotate}>
        <PencilIcon /> 段落批注
      </button>
    </div>
  );
}
