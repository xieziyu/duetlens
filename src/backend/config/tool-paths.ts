/**
 * 外部 CLI 可执行文件路径的进程内覆盖:设置屏可为 codex / gh 指定绝对路径,
 * 覆盖 PATH 默认。exec.run 与 codex app-server 启动时经 resolveTool 取实际二进制。
 * 未设置(空串)即回落到命令名,行为与旧版一致。
 */
type Tool = 'codex' | 'gh' | 'but';

const overrides: Partial<Record<Tool, string>> = {};

export function setToolPath(tool: Tool, bin: string | undefined | null): void {
  const v = bin?.trim();
  if (v) overrides[tool] = v;
  else delete overrides[tool];
}

/** 命令名 → 实际二进制;有覆盖用覆盖,否则原样返回(交给 PATH 解析)。 */
export function resolveTool(cmd: string): string {
  return (cmd in overrides && overrides[cmd as Tool]) || cmd;
}
