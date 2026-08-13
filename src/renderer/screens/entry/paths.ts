/** 仓库路径在 UI 上一律拆成「名字 + 上级目录」两段:名字是识别凭据,目录只做消歧。 */
export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
export const parentDir = (p: string) => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
