import { run } from './exec';

/** JSON 输出开关在 but 0.22 由 `--format json` 改名为 `--json`。 */
const MODERN = ['--json'];
const LEGACY = ['--format', 'json'];

/** 上一次跑通的写法;首次调用与切换 but 版本后由 butJson 自行纠正。 */
let known: string[] = MODERN;

/**
 * 跑 `but <args>` 并要 JSON 输出,两种 flag 写法自动择一。
 * 只有 clap 的「未知参数」才换写法重试 —— 不是 GitButler 项目、分支不存在这类真错误照常抛出。
 */
export async function butJson(args: string[], cwd?: string): Promise<string> {
  const [first, second] = known === LEGACY ? [LEGACY, MODERN] : [MODERN, LEGACY];
  try {
    const out = await run('but', [...args, ...first], cwd);
    known = first;
    return out;
  } catch (err) {
    if (!isUnknownArg(err)) throw err;
  }
  const out = await run('but', [...args, ...second], cwd);
  known = second;
  return out;
}

function isUnknownArg(err: unknown): boolean {
  return String((err as { stderr?: string }).stderr ?? '').includes('unexpected argument');
}
