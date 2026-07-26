// 项目外链的唯一来源:展示文案与跳转地址都从这里取。
// 外链走 <a target="_blank">,由 main 的 setWindowOpenHandler 交系统浏览器 ——
// 不加 openExternal 通道,renderer 就没有任意 URL 的出口。

export const AUTHOR = 'xieziyu';

export const PROJECT_LINKS = {
  repo: 'https://github.com/xieziyu/duetlens',
  issues: 'https://github.com/xieziyu/duetlens/issues',
  author: `https://github.com/${AUTHOR}`,
} as const;

/** 新建 issue 的地址,正文预填环境行 —— 省掉「你什么版本」那轮往返。 */
export function newIssueUrl(environment: string[]): string {
  const body = [
    '## 现象 / 期望',
    '',
    '',
    '## 复现步骤',
    '',
    '',
    '## 环境',
    ...environment.map((line) => `- ${line}`),
  ].join('\n');
  return `${PROJECT_LINKS.issues}/new?${new URLSearchParams({ body }).toString()}`;
}
