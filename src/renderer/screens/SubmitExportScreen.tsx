import { ScreenPlaceholder } from '../components/ScreenPlaceholder';

// → github-pr source: mockup/submit-to-github.html;本地/vbranch: mockup/export-markdown.html
export function SubmitExportScreen() {
  return (
    <ScreenPlaceholder
      title="提交 / 导出"
      mockup="mockup/submit-to-github.html · mockup/export-markdown.html"
      parts={['SubmitGitHubScreen(findings 筛选 + PR review)', 'ExportMarkdownScreen(本地报告)']}
    />
  );
}
