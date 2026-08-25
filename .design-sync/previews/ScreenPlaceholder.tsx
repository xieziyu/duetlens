import { ScreenPlaceholder } from 'duetlens';

/** 提交 / 导出屏的空态(见 SubmitExportScreen)。 */
export const SubmitExport = () => (
  <ScreenPlaceholder
    title="提交 / 导出"
    hint="从审核屏进入"
    parts={['先在入口发起或打开一次 review,再进入提交/导出']}
  />
);

/** 多条下一步时的样子:parts 逐条列出。 */
export const MultipleNextSteps = () => (
  <ScreenPlaceholder
    title="历史审核"
    hint="这台机器上还没有跑过审核"
    parts={[
      '在入口选一个仓库与目标分支,发起首轮机审',
      'github-pr 源需要先 gh auth login',
      '跑完的审核会留在这里,可随时重开成 tab',
    ]}
  />
);
