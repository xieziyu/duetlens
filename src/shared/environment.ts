/**
 * 首启环境自检结果:onboarding 屏据此判断能否开始审核。
 * 审核 agent 至少要有一家就绪(见 {@link anyAgentReady});gh 可选(仅 GitHub PR 来源需要)。
 */

import type { AgentKind } from './domain';

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

/**
 * pi CLI + 凭证就绪。pi 走 provider 凭证、按量计费,「装了」不等于「能跑」,故分两层:
 * `status` 看二进制在不在;`ready` 看有没有至少一家 provider 配好了凭证(深检才问)。
 */
export interface PiCheck {
  status: 'ok' | 'missing';
  version: string | null;
  /** `skipped` = 未做深检或 pi 缺失,不代表失败 */
  ready: 'ok' | 'fail' | 'skipped';
  /** 可用模型数;未深检时为 0 */
  models: number;
  /** pi 设置里的缺省模型(`provider/id`) */
  defaultModel: string | null;
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
  pi: PiCheck;
  gh: GhCheck;
}

/** codex 能跑:装了,且深检做过的话 app-server 连得上。 */
export function codexReady(r: EnvironmentReport): boolean {
  return r.codex.status === 'ok' && r.appServer.status !== 'fail';
}

/** pi 能跑:装了,且深检做过的话至少有一个可用模型。 */
export function piReady(r: EnvironmentReport): boolean {
  return r.pi.status === 'ok' && r.pi.ready !== 'fail';
}

/**
 * 某家 agent 为什么用不了;用得了时为 null。发起表单据此隐藏、设置屏据此置灰,两处同一套判据。
 * 轻量检查只知道装没装,pi 有没有配好凭证要看它的模型列表(调用方拿到了就传进来,还在拉就不传)。
 */
export function agentUnavailableReason(
  r: EnvironmentReport,
  agent: AgentKind,
  piModels?: readonly unknown[],
): string | null {
  if (agent === 'codex') {
    if (r.codex.status !== 'ok') return '未安装';
    return r.appServer.status === 'fail' ? 'app-server 连不上' : null;
  }
  if (r.pi.status !== 'ok') return '未安装';
  return r.pi.ready === 'fail' || piModels?.length === 0 ? '无可用模型' : null;
}

/** 能不能开始审核:两家 agent 有一家就绪就行。 */
export function anyAgentReady(r: EnvironmentReport): boolean {
  return codexReady(r) || piReady(r);
}

/** deep=true 才做 agent 深检(要拉起 codex / pi 子进程);首启门控用轻量检查。 */
export interface EnvCheckOptions {
  deep?: boolean;
}
