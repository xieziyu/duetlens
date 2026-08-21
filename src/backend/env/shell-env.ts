import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 补齐 GUI 启动时缺失的 shell 环境,让 Finder / Dock / Spotlight 起的 app 与终端里起的一致。
 *
 * launchd 拉起的 app 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 和一小撮系统变量:codex / gh / but
 * 三件 CLI 一个都不在 PATH 里(环境检查全报 missing),用户 rc 里 export 的凭据也一个都没有 ——
 * codex 自定义 provider 的 `env_key`、`OPENAI_API_KEY`、代理变量都靠环境传,缺了会在 turn 里
 * 以「没有 XXX 环境变量」暴毙,而同一份配置在终端里的 codex CLI 又是好的,极难自证。
 *
 * 一次登录+交互 shell 探测拿回真实环境:PATH 走合并(再补几个常见安装位兜底),其余变量只回填
 * 本进程没有的键。**结果只留在内存**:不打日志、不落库、不过 IPC —— 里面有用户的密钥。
 */

const PROBE_TIMEOUT_MS = 3000;

/** 标记包住输出:登录 shell 会把 rc 里的 echo、版本管理器的提示一起吐到 stdout。 */
const MARKER = '__duetlens_env__';

/**
 * 不从 shell 接管的键。三类:运行时开关被 rc 里的值改掉会换掉本进程的运行方式
 * (`ELECTRON_RUN_AS_NODE` 直接让 app 变成 node);本 app 自己的启动开关在探测完成前就被读掉了
 * (`DUETLENS_USER_DATA` 决定 userData,必须在 ready 前定,回填只会让环境与实际路径对不上,
 * 要覆盖数据目录就从终端带着变量启动);PATH 另有合并逻辑,余下几个是跟着 cwd / 进程走的噪声。
 */
const NEVER_ADOPT = new Set([
  'PATH',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_ENV',
  'DUETLENS_USER_DATA',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
]);

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

/** NUL 分隔,因为变量值本身可以带换行(多行的 key、粘进 rc 的证书)。 */
function parseEnvDump(dump: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of dump.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

function probeLoginShell(): Promise<Map<string, string> | null> {
  const shell = process.env.SHELL;
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    // -i 是关键:zsh / bash 只有交互式才读 .zshrc / .bashrc,而版本管理器和 export 的凭据多半在那里。
    const child = execFile(
      shell,
      ['-ilc', `printf %s ${MARKER}; /usr/bin/env -0; printf %s ${MARKER}`],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // 超时或 rc 报错都不算失败,回落到候选目录即可
        if (err && !stdout) return resolve(null);
        const m = stdout.match(new RegExp(`${MARKER}([\\s\\S]*)${MARKER}`));
        resolve(m ? parseEnvDump(m[1]) : null);
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
 * 探测并就地改写 `process.env`。必须在任何 spawn 外部 CLI 之前 await 完
 * (环境检查、codex app-server 都读 spawn 时刻的 process.env)。
 *
 * 已存在的键一律不覆盖:本进程自己设的、以及 launchd / 命令行传进来的,都比 rc 里的更贴近本次启动。
 */
export async function hydrateEnv(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const shellEnv = await probeLoginShell();

  const fallback = fallbackDirs().filter((d) => existsSync(d));
  process.env.PATH = mergePath(process.env.PATH ?? '', shellEnv?.get('PATH') ?? '', ...fallback);

  for (const [key, value] of shellEnv ?? []) {
    if (NEVER_ADOPT.has(key) || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}
