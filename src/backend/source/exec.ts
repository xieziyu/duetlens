import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** 跑外部命令(git/gh),返回 stdout。diff 可能很大,放宽 maxBuffer;input 走 stdin(如 gh api --input -)。 */
export async function run(cmd: string, args: string[], cwd?: string, input?: string): Promise<string> {
  const child = pexec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin?.end(input);
  const { stdout } = await child;
  return stdout;
}
