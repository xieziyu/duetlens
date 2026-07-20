import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** 跑外部命令(git/gh),返回 stdout。diff 可能很大,放宽 maxBuffer。 */
export async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await pexec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
