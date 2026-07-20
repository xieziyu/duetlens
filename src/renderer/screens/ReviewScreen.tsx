import { ScreenPlaceholder } from '../components/ScreenPlaceholder';

// → mockup/diff-review.html:三栏 + 内联 discussion,diff 为主场
export function ReviewScreen() {
  return (
    <ScreenPlaceholder
      title="审核 · Diff Review"
      mockup="mockup/diff-review.html"
      parts={['FileTree', 'DiffPane(inline cards / 选区 popover)', 'RightPanel(Discussion / Findings / Summary)']}
    />
  );
}
