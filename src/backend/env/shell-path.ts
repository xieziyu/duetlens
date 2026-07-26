import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 补齐 `process.env.PATH`,让 Finder / Dock / Spotlight 启动的 app 也能找到 codex / gh / but。
 *
 * 从终端 `npm start` 起的进程继承的是终端 PATH,一切正常;但 launchd 拉起的 app 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`,三件外部 CLI 一个都不在里面,环境检查会全报 missing。
 * 用户能在设置屏手填绝对路径,但那不该是首次启动的样子。
 *
 * 两层:登录 shell 问一次真实 PATH(能覆盖 fnm / mise / asdf 这类版本管理器的动态路径),
 * 再补几个常见安装位兜底(shell 探测超时或用户 rc 里根本没设时还能救回来)。
 */

const PROBE_TIMEOUT_MS = 3000;

/** 标记包住输出:登录 shell 会把 rc 里的 echo、版本管理器的提示一起吐到 stdout。 */
const MARKER = '__duetlens_path__';

/** 兜底候选:homebrew(两种前缀)、codex/uv 的默认安装位、cargo。只并入真实存在的。 */
function fallbackDirs(): string[] {
  const home = os.homedir();
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
  ];
}

function probeLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL;
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    // -i 是关键:zsh / bash 只有交互式才读 .zshrc / .bashrc,而版本管理器多半装在那里。
    const child = execFile(
      shell,
      ['-ilc', `echo "${MARKER}:$PATH:${MARKER}"`],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        // 超时或 rc 报错都不算失败,回落到候选目录即可
        if (err && !stdout) return resolve(null);
        const m = stdout.match(new RegExp(`${MARKER}:(.*?):${MARKER}`, 's'));
        resolve(m?.[1] ?? null);
      },
    );
    // 交互式 shell 可能等 stdin;不给它等的机会
    child.stdin?.end();
  });
}

function mergePath(...sources: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of sources.flatMap((s) => s.split(path.delimiter))) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(path.delimiter);
}

/**
 * 探测并就地改写 `process.env.PATH`。必须在任何 spawn 外部 CLI 之前 await 完
 * (环境检查、codex app-server 都读 spawn 时刻的 process.env)。
 */
export async function hydratePath(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const fromShell = await probeLoginShell();
  const existing = process.env.PATH ?? '';
  const fallback = fallbackDirs().filter((d) => existsSync(d));
  process.env.PATH = mergePath(existing, fromShell ?? '', ...fallback);
}
