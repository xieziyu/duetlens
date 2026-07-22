import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTool } from '../config/tool-paths';

const pexec = promisify(execFile);

/** 跑外部命令(git/gh),返回 stdout。cmd 经 resolveTool 映射到设置的可执行路径;input 走 stdin。 */
export async function run(cmd: string, args: string[], cwd?: string, input?: string): Promise<string> {
  const child = pexec(resolveTool(cmd), args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin?.end(input);
  const { stdout } = await child;
  return stdout;
}
