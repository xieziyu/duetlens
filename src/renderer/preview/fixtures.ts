/**
 * 预览用 fixture:在纯浏览器里 stub `window.duetlens`,喂静态 diff/findings,
 * 让真实 React 组件 + 真实 CSS 脱离 Electron 渲染,便于视觉自查(截图/双主题)。
 * 仅 preview 入口引用,不进 app 打包路径。
 */
import { parseUnifiedDiff } from '@shared/diff';
import type { DuetlensApi } from '@shared/ipc';
import type { Discussion, Finding, Review, UiSettings } from '@shared/domain';

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
  source: 'github-pr',
  sourceRef: 'xieziyu/podcast-go#482',
  repoPath: null,
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

const DISCUSSIONS: Discussion[] = FINDINGS.map((f) => ({
  id: f.discussionId,
  reviewId: 'demo',
  kind: 'finding',
  origin: f.origin,
  file: f.file,
  line: f.line,
  lineEnd: null,
  createdAt: now,
}));

const UI_SETTINGS: UiSettings = {
  dataMode: 'dark',
  dataTheme: 'duetlens',
  leftWidth: 236,
  rightWidth: 380,
  defaultTab: 'findings',
  defaultDiffView: 'unified',
};

/** 装一个静态 stub 到 window.duetlens;命令类方法多为空操作。 */
export function installPreviewApi(): void {
  const diff = parseUnifiedDiff(RAW_DIFF);
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
      list: async () => [REVIEW],
      get: async () => REVIEW,
      findings: async () => FINDINGS,
      diff: async () => diff,
      discussions: async () => DISCUSSIONS,
      messages: async () => [],
      start: async () => REVIEW,
      startDemo: async () => REVIEW,
      resume: async () => REVIEW,
      release: async () => {},
      addDiscussion: async (_r, anchor) => ({
        id: `d-${anchor.line}`,
        reviewId: 'demo',
        kind: 'user',
        origin: 'manual',
        file: anchor.file,
        line: anchor.line,
        lineEnd: anchor.lineEnd ?? null,
        createdAt: Date.now(),
      }),
      sendMessage: async (_r, discussionId, text) => ({
        id: `m-${Date.now()}`,
        discussionId,
        role: 'user',
        text,
        createdAt: Date.now(),
      }),
      onEvent: () => () => {},
    },
    ui: {
      getSettings: async () => UI_SETTINGS,
      saveSettings: async () => {},
    },
    dialog: {
      pickDirectory: async () => null,
    },
  };
  (window as unknown as { duetlens: DuetlensApi }).duetlens = api;
}
