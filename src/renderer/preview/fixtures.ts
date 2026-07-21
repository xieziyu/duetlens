/**
 * 预览用 fixture:在纯浏览器里 stub `window.duetlens`,喂静态 diff/findings,
 * 让真实 React 组件 + 真实 CSS 脱离 Electron 渲染,便于视觉自查(截图/双主题)。
 * 仅 preview 入口引用,不进 app 打包路径。
 */
import { parseUnifiedDiff } from '@shared/diff';
import type { DuetlensApi, ReviewEvent } from '@shared/ipc';
import type { Discussion, Finding, Message, Review, ReviewUiState, UiSettings } from '@shared/domain';

const RAW_DIFF = `diff --git a/src/pipeline.ts b/src/pipeline.ts
index 1111111..2222222 100644
--- a/src/pipeline.ts
+++ b/src/pipeline.ts
@@ -14,9 +14,11 @@ export class Pipeline {
   async run(job: Job): Promise<Result> {
     const segments = this.split(job);
-    let done = 0;
+    const counter = new Cell(0);
     for (const seg of segments) {
-      await this.encode(seg);
-      done += 1;
+      this.spawn(async () => {
+        await this.encode(seg);
+        counter.set(counter.get() + 1); // track progress
+      });
     }
     return this.finish();
   }
diff --git a/src/worker.rs b/src/worker.rs
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/worker.rs
@@ -0,0 +1,7 @@
+use std::sync::Arc;
+
+pub fn spawn_worker(n: usize) -> Arc<Worker> {
+    let w = Arc::new(Worker::new(n));
+    w.start();
+    w
+}
diff --git a/styles/app.css b/styles/app.css
index 4444444..5555555 100644
--- a/styles/app.css
+++ b/styles/app.css
@@ -1,4 +1,5 @@
 .btn {
-  color: red;
+  color: var(--accent);
+  padding: 4px 8px;
 }
`;

const now = Date.now();

const REVIEW: Review = {
  id: 'demo',
  // 本地分支 source:无 PR 可提交,终点走导出 Markdown(便于自查导出屏)
  source: 'local-branch',
  sourceRef: 'feat/streaming-transcode',
  repoPath: '/Users/dev/podcast-go',
  codexThreadId: 'thread-demo',
  title: 'feat: streaming transcode pipeline',
  status: 'reviewing',
  summaryBody: '本次改动引入并发编码管线,整体方向合理,但并发计数存在数据竞争,需修正。',
  createdAt: now,
  updatedAt: now,
};

function mkFinding(p: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'title' | 'file' | 'line'>): Finding {
  return {
    reviewId: 'demo',
    discussionId: `d-${p.id}`,
    origin: 'agent',
    category: null,
    body: '',
    suggestion: null,
    triage: 'open',
    submission: 'unsubmitted',
    submittedUrl: null,
    createdAt: now,
    updatedAt: now,
    ...p,
  };
}

const FINDINGS: Finding[] = [
  mkFinding({
    id: 'f1',
    severity: 'high',
    category: 'Correctness',
    title: 'Cell 跨 spawn 共享导致数据竞争',
    body: 'Cell<usize> 不是线程安全的,不能跨 spawn 共享;每个 task 在独立线程执行,counter.set 无原子性也不满足 Sync。用 Arc<AtomicUsize> + fetch_add(1, Ordering::Relaxed) 替代。',
    file: 'src/pipeline.ts',
    line: 20,
    suggestion: 'const counter = new AtomicCounter(0);\n// in task:\ncounter.increment();',
  }),
  mkFinding({
    id: 'f2',
    severity: 'medium',
    category: 'Naming',
    title: 'counter 命名可更贴合语义',
    body: '这里统计的是已完成分片数,建议命名为 completedCount,与相邻的 done 语义对齐。',
    file: 'src/pipeline.ts',
    line: 16,
  }),
  mkFinding({
    id: 'f3',
    severity: 'low',
    category: 'Complexity',
    title: 'padding 建议用 spacing token',
    body: '硬编码 4px 8px,项目已有 --space-* 变量,建议改用 token 保持一致。',
    file: 'styles/app.css',
    line: 3,
  }),
  mkFinding({
    id: 'f4',
    severity: 'medium',
    category: 'Architecture',
    title: 'Worker 生命周期未定义(off-diff)',
    body: '新增 spawn_worker 未定义 Worker 的停止/回收路径;锚点在未展开区,以 off-diff 提出。',
    file: 'src/worker.rs',
    line: 99,
  }),
];

const DISCUSSIONS: Discussion[] = [
  ...FINDINGS.map((f) => ({
    id: f.discussionId,
    reviewId: 'demo',
    kind: 'finding' as const,
    origin: f.origin,
    file: f.file,
    line: f.line,
    lineEnd: null,
    createdAt: now,
  })),
  // 一条用户发起的 discussion,便于自查「⬆ 转为 finding」提升流程
  {
    id: 'd-user-seed',
    reviewId: 'demo',
    kind: 'user',
    origin: 'manual',
    file: 'src/pipeline.ts',
    line: 19,
    lineEnd: null,
    createdAt: now,
  },
];

// 刻意用非默认栏宽,便于自查「启动即从 ui_settings 应用」而非用组件默认值
const UI_SETTINGS: UiSettings = {
  dataMode: 'dark',
  dataTheme: 'duetlens',
  leftWidth: 300,
  rightWidth: 420,
  defaultTab: 'findings',
  defaultDiffView: 'unified',
};

/** 一条 finding discussion 预置对话,便于点开 f1 即见真实线程。 */
const SEED_MESSAGES: Record<string, Message[]> = {
  'd-f1': [
    {
      id: 'm-seed-1',
      discussionId: 'd-f1',
      role: 'user',
      text: '如果只想要个近似进度、不追求精确,能不能不加锁?',
      createdAt: now + 1000,
    },
    {
      id: 'm-seed-2',
      discussionId: 'd-f1',
      role: 'agent',
      text: '近似进度也要跨线程,所以仍需原子类型,但 Relaxed 顺序就够——它保证单变量原子性、开销接近裸加:\ncounter.fetch_add(1, Ordering::Relaxed);',
      createdAt: now + 2000,
    },
  ],
  'd-user-seed': [
    {
      id: 'm-user-seed-1',
      discussionId: 'd-user-seed',
      role: 'user',
      text: '这里 done += 1 在并发下会不会丢更新?想听听 codex 的意见。',
      createdAt: now + 500,
    },
  ],
};

/** 装一个 stub 到 window.duetlens;写路径(triage/编辑/讨论)真的改内存态并经事件回推,便于自查闭环。 */
export function installPreviewApi(): void {
  const diff = parseUnifiedDiff(RAW_DIFF);
  const review: Review = { ...REVIEW };
  let uiSettings: UiSettings = { ...UI_SETTINGS };
  // 预置一个已看文件,证明启动即从后端恢复 per-review 进度(非组件默认空态)
  let reviewUiState: ReviewUiState = {
    viewedFiles: diff.length > 1 ? [diff[1].path] : diff.slice(0, 1).map((f) => f.path),
    lastActiveTab: null,
  };
  const findings = FINDINGS.map((f) => ({ ...f }));
  const discussions = DISCUSSIONS.map((d) => ({ ...d }));
  const msgStore: Record<string, Message[]> = structuredClone(SEED_MESSAGES);
  const listeners = new Set<(e: ReviewEvent) => void>();
  const fire = (e: ReviewEvent) => {
    for (const l of listeners) l(e);
  };
  const emit = (payload: Finding) => {
    const i = findings.findIndex((f) => f.id === payload.id);
    if (i >= 0) findings[i] = payload;
    fire({ reviewId: 'demo', type: 'finding', payload });
  };

  const api: DuetlensApi = {
    getAppInfo: async () => ({
      name: 'Duetlens (preview)',
      version: '2.0.0-dev',
      electron: '—',
      chrome: '—',
      node: '—',
      platform: 'darwin',
    }),
    review: {
      list: async () => [review],
      get: async () => review,
      findings: async () => findings,
      diff: async () => diff,
      discussions: async () => discussions,
      messages: async (discussionId) => msgStore[discussionId] ?? [],
      start: async () => review,
      startDemo: async () => review,
      resume: async () => review,
      release: async () => {},
      addDiscussion: async (_r, anchor) => {
        const d: Discussion = {
          id: `d-user-${Date.now()}`,
          reviewId: 'demo',
          kind: 'user',
          origin: 'manual',
          file: anchor.file,
          line: anchor.line,
          lineEnd: anchor.lineEnd ?? null,
          createdAt: Date.now(),
        };
        discussions.push(d);
        fire({ reviewId: 'demo', type: 'discussion', payload: d });
        return d;
      },
      // 模拟真实回路:先回推 user 消息,延迟后回推 agent 回复;返回 agent 消息。
      sendMessage: async (_r, discussionId, text) => {
        const userMsg: Message = {
          id: `m-${Date.now()}-u`,
          discussionId,
          role: 'user',
          text,
          createdAt: Date.now(),
        };
        (msgStore[discussionId] ??= []).push(userMsg);
        fire({ reviewId: 'demo', type: 'message', payload: userMsg });
        await new Promise((r) => setTimeout(r, 900));
        const agentMsg: Message = {
          id: `m-${Date.now()}-a`,
          discussionId,
          role: 'agent',
          text: '收到。我基于本讨论看了这段改动,建议用原子计数替代共享 Cell,并在每段完成时增量上报进度。',
          createdAt: Date.now(),
        };
        msgStore[discussionId].push(agentMsg);
        fire({ reviewId: 'demo', type: 'message', payload: agentMsg });
        return agentMsg;
      },
      setTriage: async (_r, findingId, triage) => {
        const f = findings.find((x) => x.id === findingId)!;
        const next = { ...f, triage, updatedAt: Date.now() };
        emit(next);
        return next;
      },
      promoteDiscussion: async (_r, discussionId) => {
        const d = discussions.find((x) => x.id === discussionId)!;
        const firstUser = (msgStore[discussionId] ?? []).find((m) => m.role === 'user');
        const ts = Date.now();
        const finding: Finding = {
          id: `f-promoted-${ts}`,
          reviewId: 'demo',
          discussionId,
          origin: 'promoted',
          severity: 'medium',
          category: null,
          title: firstUser ? firstUser.text.slice(0, 60) : '待补充标题',
          body: firstUser?.text ?? '',
          file: d.file!,
          line: d.line!,
          suggestion: null,
          triage: 'open',
          submission: 'unsubmitted',
          submittedUrl: null,
          createdAt: ts,
          updatedAt: ts,
        };
        const di = discussions.findIndex((x) => x.id === discussionId);
        discussions[di] = { ...d, kind: 'finding', origin: 'promoted' };
        findings.push(finding);
        fire({ reviewId: 'demo', type: 'finding', payload: finding });
        fire({ reviewId: 'demo', type: 'discussion', payload: discussions[di] });
        return finding;
      },
      updateSummary: async (_r, body) => {
        const next = { ...review, summaryBody: body, updatedAt: Date.now() };
        Object.assign(review, next);
        fire({ reviewId: 'demo', type: 'review', payload: next });
        return next;
      },
      getUiState: async () => reviewUiState,
      saveUiState: async (_r, state) => {
        reviewUiState = state;
      },
      updateFinding: async (_r, input) => {
        const f = findings.find((x) => x.id === input.findingId)!;
        const next: Finding = {
          ...f,
          severity: input.severity ?? f.severity,
          category: input.category === undefined ? f.category : input.category,
          title: input.title ?? f.title,
          body: input.body ?? f.body,
          suggestion: input.suggestion === undefined ? f.suggestion : input.suggestion,
          updatedAt: Date.now(),
        };
        emit(next);
        return next;
      },
      onEvent: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    ui: {
      getSettings: async () => uiSettings,
      saveSettings: async (s) => {
        uiSettings = s;
      },
    },
    dialog: {
      pickDirectory: async () => null,
      // 浏览器里无原生保存对话框:用 <a download> 下载作预览替身,回一个假路径证明闭环
      saveTextFile: async (defaultName, content) => {
        const blob = new Blob([content], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(a.href);
        return `~/Downloads/${defaultName}`;
      },
    },
  };
  (window as unknown as { duetlens: DuetlensApi }).duetlens = api;
}
