/**
 * 首启环境自检:探测 codex CLI + app-server 连通 + gh 登录态。
 * onboarding 屏据此门控「能否开始审核」;均只读、不进入 review 生命周期。
 */
import type {
  AppServerCheck,
  CodexCheck,
  EnvCheckOptions,
  EnvironmentReport,
  GhCheck,
} from '@shared/environment';
import { run } from '../source/exec';
import { checkGhAuth } from '../source/source-discovery';
import { CodexAppServer } from '../agent/codex/codex-app-server';

export interface EnvironmentCheckDeps extends EnvCheckOptions {
  codexBin?: string;
  codexHome?: string;
}

/** app-server 深检的超时:握手异常时不能无限等,超时按连通失败处理。 */
const APP_SERVER_TIMEOUT_MS = 8000;

/** `codex --version` 输出里抓 x.y.z(.pre);抓不到则退回整行,空则算缺失。 */
async function probeCodexVersion(codexBin: string): Promise<string | null> {
  try {
    const out = await run(codexBin, ['--version']);
    const m = out.match(/\d+\.\d+\.\d+\S*/);
    return m ? m[0] : out.trim() || null;
  } catch {
    return null;
  }
}

/** 起一次性 app-server + 握手即关;不注入 MCP、不起 thread,不烧 token。 */
async function probeAppServer(deps: EnvironmentCheckDeps): Promise<AppServerCheck> {
  const server = new CodexAppServer({ codexBin: deps.codexBin, codexHome: deps.codexHome });
  try {
    server.start();
    await withTimeout(
      server.initialize({ name: 'duetlens', version: '2.0.0-dev' }),
      APP_SERVER_TIMEOUT_MS,
      'app-server 握手超时',
    );
    return { status: 'ok', error: null };
  } catch (e) {
    return { status: 'fail', error: e instanceof Error ? e.message : String(e) };
  } finally {
    server.stop();
  }
}

/** gh 登录态 + 账号;登录时取 login 展示,取不到不影响判定。 */
async function probeGh(): Promise<GhCheck> {
  if (!(await checkGhAuth())) return { status: 'missing', user: null };
  let user: string | null = null;
  try {
    user = (await run('gh', ['api', 'user', '--jq', '.login'])).trim() || null;
  } catch {
    // 已登录但取 login 失败(网络/权限):不阻断,留空账号
  }
  return { status: 'ok', user };
}

export async function checkEnvironment(deps: EnvironmentCheckDeps = {}): Promise<EnvironmentReport> {
  const codexBin = deps.codexBin || 'codex';
  const version = await probeCodexVersion(codexBin);
  const codex: CodexCheck = version ? { status: 'ok', version } : { status: 'missing', version: null };

  const [appServer, gh] = await Promise.all([
    deps.deep && codex.status === 'ok'
      ? probeAppServer(deps)
      : Promise.resolve<AppServerCheck>({ status: 'skipped', error: null }),
    probeGh(),
  ]);

  return { codex, appServer, gh };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
