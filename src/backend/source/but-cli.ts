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
    if (!isUnknownArg(err, first[0])) throw err;
  }
  const out = await run('but', [...args, ...second], cwd);
  known = second;
  return out;
}

/** 只认「被投诉的正是 json flag 本身」——否则 args 里别的过期 flag 会被这层重试盖掉真凶。 */
function isUnknownArg(err: unknown, flag: string): boolean {
  return String((err as { stderr?: string }).stderr ?? '').includes(`unexpected argument '${flag}'`);
}

/** 探测结果按进程缓存:同一台机器上 but 不会在一次运行中间换版本。 */
let diffTui: string[] | null = null;

/**
 * `but diff <target>` 的 JSON 输出。**--no-tui 传不传只能问 CLI 自己**,两侧都会出事:
 * 0.22 删了这个 flag(传了直接 unexpected argument),而 ≤0.20.0 的 `use_tui` 不看输出格式,
 * 不传就落到 git config `but.ui.tui` —— 用户开过它就会卡进交互界面,而不是回一份 JSON。
 * 版本号判不了(0.20.1 起才改成 json 强制关 TUI),照着 help 认这个 flag 最省事。
 */
export async function butDiffJson(target: string, cwd?: string): Promise<string> {
  if (!diffTui) {
    // 探测不成功就不落缓存,让错误照常抛出去 —— 起不来的 but、无效的 cwd 下面那条 diff 也跑不成,
    // 而把「没读到 help」记成「这版不要 --no-tui」会让之后换到好仓库时静默进 TUI。
    const help = await run('but', ['diff', '--help'], cwd);
    diffTui = help.includes('--no-tui') ? ['--no-tui'] : [];
  }
  return butJson(['diff', target, ...diffTui], cwd);
}
