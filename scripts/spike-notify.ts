/**
 * spike:notify —— 长任务完成通知的决策逻辑(纯函数,不依赖 Electron / DB,不烧 token)。
 * 验证:偏好门控 · 扫描完成每 review 只提示一次 · 追问回复提示 · 聚焦走应用内/失焦走原生 ·
 *      非完成事件(scanning/failed/user 消息)不提示。
 */
import { strict as assert } from 'node:assert';
import { createCompletionNotifier } from '../src/backend/notify/completion-notifier';
import type { CompletionNotice, ReviewEvent } from '../src/shared/ipc';
import type { Message } from '../src/shared/domain';

function log(msg: string) {
  process.stdout.write(`[notify] ${msg}\n`);
}

/** 组一个可控的 harness:记录 native/in-app 提示,聚焦态与开关可切。 */
function harness(opts: { focused?: boolean; enabled?: boolean } = {}) {
  const native: CompletionNotice[] = [];
  const inApp: CompletionNotice[] = [];
  const state = { focused: opts.focused ?? false, enabled: opts.enabled ?? true };
  const notify = createCompletionNotifier({
    isFocused: () => state.focused,
    isEnabled: () => state.enabled,
    reviewLabel: (id) => `review:${id}`,
    notifyNative: (n) => native.push(n),
    notifyInApp: (n) => inApp.push(n),
  });
  return { native, inApp, state, notify };
}

const statusEvent = (reviewId: string, payload: ReviewEvent['payload'] & string): ReviewEvent =>
  ({ reviewId, type: 'status', payload }) as ReviewEvent;
const agentMsg = (reviewId: string, discussionId = 'd1'): ReviewEvent => ({
  reviewId,
  type: 'message',
  payload: { role: 'agent', text: 'reply', discussionId } as Message,
});
const userMsg = (reviewId: string): ReviewEvent => ({
  reviewId,
  type: 'message',
  payload: { role: 'user', text: 'ask' } as Message,
});

function main() {
  // 1) 开关关闭 → 一律不提示
  {
    const h = harness({ enabled: false, focused: false });
    h.notify(statusEvent('r1', 'reviewing'));
    h.notify(agentMsg('r1'));
    assert.equal(h.native.length, 0);
    assert.equal(h.inApp.length, 0);
    log('开关关闭:无任何提示 ok');
  }

  // 2) 扫描完成 + 失焦 → 原生通知;同一 review 再来 reviewing 不重复
  {
    const h = harness({ focused: false });
    h.notify(statusEvent('r1', 'reviewing'));
    assert.equal(h.native.length, 1);
    assert.equal(h.native[0].kind, 'scan-done');
    assert.match(h.native[0].body, /review:r1/);
    h.notify(statusEvent('r1', 'reviewing')); // 重复不再提示
    assert.equal(h.native.length, 1);
    // 另一个 review 独立计数
    h.notify(statusEvent('r2', 'reviewing'));
    assert.equal(h.native.length, 2);
    log('扫描完成失焦:原生通知 + 每 review 去重 ok');
  }

  // 3) 追问回复:失焦走原生,聚焦走应用内;reply 通知带 discussionId 供定位线程
  {
    const h = harness({ focused: false });
    h.notify(agentMsg('r1', 'disc-7'));
    assert.equal(h.native.length, 1);
    assert.equal(h.native[0].kind, 'reply');
    assert.equal(h.native[0].discussionId, 'disc-7');
    h.state.focused = true;
    h.notify(agentMsg('r1', 'disc-7'));
    assert.equal(h.native.length, 1);
    assert.equal(h.inApp.length, 1);
    assert.equal(h.inApp[0].kind, 'reply');
    assert.equal(h.inApp[0].discussionId, 'disc-7');
    log('追问回复:失焦原生 / 聚焦应用内 · 带 discussionId ok');
  }

  // 3b) 扫描完成通知不带 discussionId(无所属线程)
  {
    const h = harness({ focused: false });
    h.notify(statusEvent('r1', 'reviewing'));
    assert.equal(h.native[0].kind, 'scan-done');
    assert.equal(h.native[0].discussionId, undefined);
    log('扫描完成:无 discussionId ok');
  }

  // 4) 非完成信号不提示:scanning / failed / user 消息
  {
    const h = harness({ focused: false });
    h.notify(statusEvent('r1', 'scanning'));
    h.notify(statusEvent('r1', 'failed'));
    h.notify(userMsg('r1'));
    assert.equal(h.native.length, 0);
    assert.equal(h.inApp.length, 0);
    log('非完成信号:不提示 ok');
  }

  log('────────────────────────');
  log('✅ PASS — 完成通知决策逻辑全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[notify] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
