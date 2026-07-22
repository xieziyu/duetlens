/**
 * 首启环境自检结果:onboarding 屏据此判断能否开始审核。
 * codex 为必需(审核 agent 运行时);gh 可选(仅 GitHub PR 来源需要)。
 */

/** codex CLI 是否可用 + 版本(取不到版本仍算缺失)。 */
export interface CodexCheck {
  status: 'ok' | 'missing';
  version: string | null;
}

/**
 * 与 codex app-server 建立 JSON-RPC 会话是否成功(证明常驻会话可拉起)。
 * `skipped` = 未做深检(轻量首启门控)或 codex 缺失,不代表失败。
 */
export interface AppServerCheck {
  status: 'ok' | 'fail' | 'skipped';
  error: string | null;
}

/** gh 登录态 + 账号(仅 GitHub 来源/提交依赖)。 */
export interface GhCheck {
  status: 'ok' | 'missing';
  user: string | null;
}

export interface EnvironmentReport {
  codex: CodexCheck;
  appServer: AppServerCheck;
  gh: GhCheck;
}

/** deep=true 才做 app-server 连通深检(要拉起 codex 子进程);首启门控用轻量检查。 */
export interface EnvCheckOptions {
  deep?: boolean;
}
