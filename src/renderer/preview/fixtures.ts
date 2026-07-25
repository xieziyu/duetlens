/**
 * 预览用 fixture:在纯浏览器里 stub `window.duetlens`,喂静态 diff/findings,
 * 让真实 React 组件 + 真实 CSS 脱离 Electron 渲染,便于视觉自查(截图/双主题)。
 * 仅 preview 入口引用,不进 app 打包路径。
 */
import { parseUnifiedDiff } from '@shared/diff';
import type {
  CompletionNotice,
  DuetlensApi,
  RecentReview,
  ReviewEvent,
  ReviewStartProgress,
  ReviewStartStage,
} from '@shared/ipc';
import type { PrSummary } from '@shared/source-discovery';
import type { Discussion, Finding, Message, Review, ReviewRound, ReviewUiState, UiSettings } from '@shared/domain';
import { mergeLayers } from '@shared/prompt';
import type { EditablePromptLayer, PromptSectionKey, ReviewPromptView } from '@shared/prompt';

/** 预览用 src/pipeline.ts 新侧全文(供展开 diff 外上下文自查);行 14–24 为 hunk 覆盖区。 */
const PIPELINE_SRC =
  Array.from({ length: 13 }, (_, i) => `// line ${i + 1} — imports & setup above the change`).join('\n') +
  '\n' +
  Array.from({ length: 11 }, (_, i) => `  /* hunk line ${i + 14} (covered by diff) */`).join('\n') +
  '\n' +
  Array.from({ length: 32 }, (_, i) => `  // line ${i + 25} — helpers & exports below the change`).join('\n') +
  '\n';

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
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 6666666..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const legacy = true;
-// dropped in this change
-export default legacy;
diff --git a/src/oldname.ts b/src/newname.ts
similarity index 100%
rename from src/oldname.ts
rename to src/newname.ts
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/assets/logo.png differ
`;

const now = Date.now();

const REVIEW: Review = {
  id: 'demo',
  // 本地分支 source:无 PR 可提交,终点走导出 Markdown(便于自查导出屏)
  source: 'local-branch',
  sourceRef: 'feat/streaming-transcode',
  repoPath: '/Users/dev/podcast-go',
  codexThreadId: 'thread-demo',
  model: 'gpt-5-codex',
  reasoningEffort: 'high',
  intensity: 'adversarial',
  title: 'feat: streaming transcode pipeline',
  status: 'reviewing',
  summaryBody: '本次改动引入并发编码管线,整体方向合理,但并发计数存在数据竞争,需修正。',
  currentRound: 2,
  createdAt: now,
  updatedAt: now,
};

// 入口「最近的审核」/ 历史屏列表 fixture(覆盖三来源 × 状态 × 时间分桶)
const RECENT_REVIEWS: RecentReview[] = [
  { ...REVIEW, id: 'r1', source: 'github-pr', sourceRef: 'xieziyu/podcast-go#482', title: 'feat: streaming transcode', status: 'reviewing', findingCount: 3, discussionCount: 2, submittedCount: 0, updatedAt: now - 23 * 60_000 },
  { ...REVIEW, id: 'r2', source: 'github-pr', sourceRef: 'xieziyu/podcast-go#479', title: 'fix: episode duration off-by-one on live cutover', status: 'submitted', findingCount: 5, discussionCount: 0, submittedCount: 4, updatedAt: now - 5 * 3600_000 },
  { ...REVIEW, id: 'r3', source: 'local-branch', sourceRef: 'fix/feed-encoding', title: 'fix/feed-encoding', repoPath: '/Users/dev/podcast-go', status: 'exported', findingCount: 0, discussionCount: 0, submittedCount: 0, updatedAt: now - 26 * 3600_000 },
  { ...REVIEW, id: 'r4', source: 'gitbutler-vbranch', sourceRef: 'virtual/api-cleanup', title: 'virtual/api-cleanup', repoPath: '/Users/dev/duetlens', status: 'exported', findingCount: 2, discussionCount: 1, submittedCount: 0, updatedAt: now - 4 * 86_400_000 },
  { ...REVIEW, id: 'r5', source: 'github-pr', sourceRef: 'xieziyu/duetlens#471', title: 'refactor: extract prompt resolver into shared', repoPath: null, status: 'submitted', findingCount: 8, discussionCount: 0, submittedCount: 6, updatedAt: now - 10 * 86_400_000 },
  { ...REVIEW, id: 'r6', source: 'local-branch', sourceRef: 'fix/transcode-timeout', repoPath: '/Users/dev/podcast-go', title: 'fix/transcode-timeout', status: 'failed', findingCount: 1, discussionCount: 0, submittedCount: 0, updatedAt: now - 17 * 86_400_000 },
];

// GitHub「从最近 open PR 选择」列表 fixture
const OPEN_PRS: PrSummary[] = [
  { number: 482, title: 'feat: streaming transcode', author: 'ryan', additions: 188, deletions: 41, updatedAt: new Date(now - 2 * 3600_000).toISOString() },
  { number: 479, title: 'fix: episode duration off-by-one on live cutover', author: 'mia', additions: 24, deletions: 9, updatedAt: new Date(now - 5 * 3600_000).toISOString() },
  { number: 475, title: 'refactor: extract feed builder into module', author: 'ryan', additions: 310, deletions: 212, updatedAt: new Date(now - 26 * 3600_000).toISOString() },
];

function mkFinding(p: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'title' | 'file' | 'line'>): Finding {
  return {
    reviewId: 'demo',
    discussionId: `d-${p.id}`,
    origin: 'agent',
    category: null,
    body: '',
    suggestion: null,
    triage: 'open',
    dismissReason: null,
    submission: 'unsubmitted',
    submittedUrl: null,
    round: 1,
    lastSeenRound: 1,
    resolution: null,
    resolutionNote: null,
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
    lastSeenRound: 2,
    resolution: 'still_present',
    resolutionNote: '第 2 轮复核:counter 仍是 Cell,未改。',
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
    lastSeenRound: 2,
    resolution: 'fixed',
    resolutionNote: '第 2 轮已改名为 completedCount。',
    // 判定已修复即自动结案(见 rerun.md),故 fixture 也是剔除态
    triage: 'dismiss',
    dismissReason: '第 2 轮复核判定已修复',
  }),
  mkFinding({
    id: 'f3',
    severity: 'low',
    category: 'Complexity',
    title: 'padding 建议用 spacing token',
    body: '硬编码 4px 8px,项目已有 --space-* 变量,建议改用 token 保持一致。',
    file: 'styles/app.css',
    line: 3,
    triage: 'dismiss',
    dismissReason: '这套样式将随设计系统一并替换,本次不改。',
  }),
  mkFinding({
    id: 'f4',
    severity: 'medium',
    category: 'Architecture',
    title: 'Worker 生命周期未定义(off-diff)',
    body: '新增 spawn_worker 未定义 Worker 的停止/回收路径;锚点在未展开区,以 off-diff 提出。',
    file: 'src/worker.rs',
    line: 99,
    round: 2,
    lastSeenRound: 2,
  }),
  mkFinding({
    id: 'f5',
    severity: 'medium',
    category: 'Type Safety',
    title: '调试脚本用 cast 伪造外部 JSON 的运行时形状',
    body: '`--file` 内容来自外部文件,却用类型断言直接宣称 JSON 一定含两个 string 字段。',
    file: 'src/scripts/decrypt.ts',
    line: 20,
    submission: 'submitted',
    submittedUrl: 'https://github.com/acme/repo/pull/1#pullrequestreview-1',
    lastSeenRound: 2,
    resolution: 'wont_fix',
    resolutionNote: '纯联调,手动调试脚本,可忽略。',
  }),
  mkFinding({
    id: 'f6',
    severity: 'medium',
    category: 'Correctness',
    title: '拒绝不可比较的 appVersion 配置',
    body: 'appVersion 比较未校验格式,非法值被静默视为相等;文件不在本次改动内,agent 顺 import 读到并 off-diff 提出。',
    file: 'src/shared/config.ts',
    line: 42,
  }),
];

const ROUNDS: ReviewRound[] = [
  {
    reviewId: 'demo', round: 1, codexThreadId: 'thread-demo-1', headSha: '3f9a1c2e5b7d',
    status: 'done', note: null, newFindings: 3, fixedCount: 0, suppressedCount: 0,
    startedAt: now - 3 * 3600_000, endedAt: now - 3 * 3600_000 + 210_000,
  },
  {
    reviewId: 'demo', round: 2, codexThreadId: 'thread-demo-2', headSha: 'a41d80b6cc02',
    status: 'done', note: '作者说已修了并发那条,重点复核。', newFindings: 1, fixedCount: 1, suppressedCount: 2,
    startedAt: now - 25 * 60_000, endedAt: now - 21 * 60_000,
  },
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
  defaultSource: 'github-pr',
  findingsGrouping: 'severity',
  collapseViewedFiles: true,
  defaultModel: '',
  defaultEffort: 'medium',
  defaultIntensity: 'standard',
  notifyOnComplete: true,
  codexPath: '',
  ghPath: '',
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
      text: '这里 done += 1 在并发下会不会丢更新?想听听 agent 的意见。',
      createdAt: now + 500,
    },
  ],
};

// 三层审核规则 fixture:内置基线与合并逻辑直接复用 @shared/prompt(不再抄一份,免得与后端漂移),
// 这里只预置若干层覆盖,供三层编辑器双主题自查。
const promptLayers: Record<EditablePromptLayer, Partial<Record<PromptSectionKey, string>>> = {
  project: {
    // 只覆盖 Security / Architecture 两个类别 —— 用来自查审核重点在「逐类别混合来源」下的显示
    focus:
      '- Security: 额外盯 Electron IPC 边界的输入校验;直接拼接的 SQL / shell 警惕注入\n- Architecture: codex thread 只读沙箱假设不得被打破;主 / 渲染进程职责不越界',
    ignore: '额外忽略:`preview.html` 与 `src/renderer/preview/`(前端自查用的 fixture,不进 app 打包路径)。',
    context: '本仓库:Electron + Node/TS 主进程后端 + codex app-server;前端为 React SPA;审核 agent 只读代码,不改动。',
    // 只覆盖 high 一档 —— 用来自查右栏「逐档 provenance」在混合来源下的显示
    severity: '- high: 仅安全问题与数据损坏;性能退化不算 high',
  },
  global: {
    tone: '追问回复保持简洁,不复述已在 diff 中的代码;\n先给结论,再给依据。',
  },
};

function buildPromptView(cwd?: string): ReviewPromptView {
  const { sections } = mergeLayers(promptLayers.project, promptLayers.global);
  // 预览恒返回 project 路径(免选目录直接编辑);真实后端仍按 cwd 门控
  return {
    sections,
    projectPath: `${cwd ?? '/repo'}/.duetlens/review.md`,
    globalPath: '~/.duetlens/review.md',
  };
}

/** 装一个 stub 到 window.duetlens;写路径(triage/编辑/讨论)真的改内存态并经事件回推,便于自查闭环。 */
export function installPreviewApi(): void {
  const diff = parseUnifiedDiff(RAW_DIFF);
  // ?source=github 切到 github-pr 以自查提交屏;?submit=invalid|failed 强制模拟提交结果
  const params = new URLSearchParams(window.location.search);
  const asGithub = (params.get('source') ?? '').startsWith('github');
  const forceSubmit = params.get('submit');
  // ?scan 让 demo review 处于首轮机审态,用于自查扫描 timeline
  const asScanning = params.has('scan');
  // ?clean 零 finding:自查扫描结束「干净通过」的正向空态
  const asClean = params.has('clean');
  // ?stream findings 逐条经事件流到达(复现流式插入内联卡时的重绘行为)
  const asStream = params.has('stream');
  // 可变:重跑 stub 会改 currentRound / status,模拟后端回推后的新值
  let review: Review = {
    ...REVIEW,
    ...(asGithub ? { source: 'github-pr', sourceRef: 'xieziyu/podcast-go#482', repoPath: null } : {}),
    ...(asScanning ? { status: 'scanning' as const } : {}),
  };
  let uiSettings: UiSettings = { ...UI_SETTINGS };
  // 预置一个已看文件,证明启动即从后端恢复 per-review 进度(非组件默认空态)
  // ?tab=findings|discussion|summary 强制初始右栏 tab(自查用,如在扫描期停在 Discussion 看进度头)
  const forcedTab = params.get('tab');
  let reviewUiState: ReviewUiState = {
    viewedFiles: diff.length > 1 ? [diff[1].path] : diff.slice(0, 1).map((f) => f.path),
    lastActiveTab:
      forcedTab === 'findings' || forcedTab === 'discussion' || forcedTab === 'summary'
        ? forcedTab
        : null,
  };
  const findings = asClean || asStream ? [] : FINDINGS.map((f) => ({ ...f }));
  const rounds: ReviewRound[] = asClean || asStream ? [] : ROUNDS.map((r) => ({ ...r }));
  const discussions = asClean || asStream ? [] : DISCUSSIONS.map((d) => ({ ...d }));
  const msgStore: Record<string, Message[]> = structuredClone(SEED_MESSAGES);
  const listeners = new Set<(e: ReviewEvent) => void>();
  const startListeners = new Set<(p: ReviewStartProgress) => void>();
  const fire = (e: ReviewEvent) => {
    for (const l of listeners) l(e);
  };
  // 通知在真实里由 main 派发;preview 用测试钩子(window.__fireInApp)触发应用内提示自查。
  const openReviewListeners = new Set<(p: { reviewId: string }) => void>();
  const inAppListeners = new Set<(n: CompletionNotice) => void>();
  (window as unknown as { __fireInApp?: (n: CompletionNotice) => void }).__fireInApp = (n) => {
    for (const l of inAppListeners) l(n);
  };
  const emit = (payload: Finding) => {
    const i = findings.findIndex((f) => f.id === payload.id);
    if (i >= 0) findings[i] = payload;
    fire({ reviewId: 'demo', type: 'finding', payload });
  };

  // ?stream:挂载后逐条把 finding + 承载 discussion 经事件流推入(模拟机审流式上报)
  if (asStream) {
    FINDINGS.forEach((f, idx) => {
      setTimeout(() => {
        const disc = DISCUSSIONS.find((d) => d.id === f.discussionId);
        if (disc) {
          discussions.push(disc);
          fire({ reviewId: 'demo', type: 'discussion', payload: disc });
        }
        findings.push({ ...f });
        fire({ reviewId: 'demo', type: 'finding', payload: { ...f } });
      }, 700 + idx * 650);
    });
  }

  const api: DuetlensApi = {
    getAppInfo: async () => ({
      name: 'Duetlens (preview)',
      version: '2.0.0-dev',
      electron: '34.0.0',
      chrome: '132.0',
      node: '20.18',
      platform: 'darwin',
    }),
    // onboarding 自查:?ob=no-codex|gh-out|ready(缺省 ready);略延时以看 checking 态
    checkEnvironment: async () => {
      await new Promise((r) => setTimeout(r, 500));
      const ob = params.get('ob') ?? 'ready';
      if (ob === 'no-codex') {
        return { codex: { status: 'missing', version: null }, appServer: { status: 'skipped', error: null }, gh: { status: 'ok', user: 'xieziyu' } };
      }
      if (ob === 'gh-out') {
        return { codex: { status: 'ok', version: '0.144.5' }, appServer: { status: 'ok', error: null }, gh: { status: 'missing', user: null } };
      }
      return { codex: { status: 'ok', version: '0.144.5' }, appServer: { status: 'ok', error: null }, gh: { status: 'ok', user: 'xieziyu' } };
    },
    review: {
      list: async () => [review],
      listRecent: async () => (params.has('empty') ? [] : RECENT_REVIEWS),
      get: async () => review,
      findings: async () => findings,
      diff: async () => diff,
      fileContent: async (_r, path) => (path === 'src/pipeline.ts' ? PIPELINE_SRC : null),
      discussions: async () => discussions,
      messages: async (discussionId) => msgStore[discussionId] ?? [],
      // ?start 模拟大 PR 的慢启动(阶段按真实顺序推进,diff 停够久能看到「拉取偏慢」提示);
      // ?start=error 在 diff 阶段失败,自查浮层的错误态
      start: async (input) => {
        const mode = params.get('start');
        if (mode === null) return review;
        const id = input.startId ?? '';
        const at = (stage: ReviewStartStage, ms: number) =>
          window.setTimeout(() => {
            for (const l of startListeners) l({ startId: id, stage });
          }, ms);
        at('resolve', 120);
        at('diff', 1_100);
        if (mode === 'error') {
          await new Promise((r) => window.setTimeout(r, 4_000));
          throw new Error(
            'gh pr diff 失败:GraphQL: Could not resolve to a PullRequest with the number of 482. (repository.pullRequest)',
          );
        }
        at('record', 12_000);
        at('agent', 13_000);
        await new Promise((r) => window.setTimeout(r, 14_000));
        return review;
      },
      rounds: async () => rounds,
      // 开一轮:插入 scanning 记录并回推,4s 后收轮 —— 够看清面板→扫描→收轮的整条视觉链路
      rerun: async (_r, input) => {
        const round: ReviewRound = {
          reviewId: 'demo',
          round: rounds.length + 1,
          codexThreadId: `thread-demo-${rounds.length + 1}`,
          headSha: 'bb17e4f0a993',
          status: 'scanning',
          note: input?.note ?? null,
          newFindings: 0,
          fixedCount: 0,
          suppressedCount: 0,
          startedAt: Date.now(),
          endedAt: null,
        };
        rounds.push(round);
        review = { ...review, currentRound: round.round, status: 'scanning' };
        fire({ reviewId: 'demo', type: 'round', payload: round });
        fire({ reviewId: 'demo', type: 'status', payload: 'scanning' });
        setTimeout(() => {
          const done: ReviewRound = { ...round, status: 'done', newFindings: 1, fixedCount: 1, endedAt: Date.now() };
          rounds[rounds.length - 1] = done;
          review = { ...review, status: 'reviewing' };
          fire({ reviewId: 'demo', type: 'round', payload: done });
          fire({ reviewId: 'demo', type: 'status', payload: 'reviewing' });
        }, 4000);
        return round;
      },
      resume: async () => review,
      release: async () => {},
      delete: async () => {},
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
      clearDiscussion: async (_r, discussionId) => {
        msgStore[discussionId] = [];
        fire({ reviewId: 'demo', type: 'messages-cleared', discussionId });
      },
      setTriage: async (_r, findingId, triage, reason) => {
        const f = findings.find((x) => x.id === findingId)!;
        const next = {
          ...f,
          triage,
          dismissReason: triage === 'dismiss' ? (reason?.trim() || null) : null,
          updatedAt: Date.now(),
        };
        emit(next);
        return next;
      },
      setFindingAnchor: async (_r, findingId, line) => {
        const f = findings.find((x) => x.id === findingId)!;
        const next = { ...f, line, updatedAt: Date.now() };
        emit(next);
        return next;
      },
      // 手动新增 finding(origin=manual):建 finding + 承载 discussion,回推两事件
      addFinding: async (_r, input) => {
        const ts = Date.now();
        const id = `f-manual-${ts}`;
        const discussionId = `d-${id}`;
        const finding: Finding = {
          id,
          reviewId: 'demo',
          discussionId,
          origin: 'manual',
          severity: input.severity,
          category: input.category ?? null,
          title: input.title,
          body: input.body ?? '',
          file: input.file,
          line: input.line,
          suggestion: input.suggestion ?? null,
          triage: 'open',
          dismissReason: null,
          submission: 'unsubmitted',
          submittedUrl: null,
          round: 2,
          lastSeenRound: 2,
          resolution: null,
          resolutionNote: null,
          createdAt: ts,
          updatedAt: ts,
        };
        const discussion: Discussion = {
          id: discussionId,
          reviewId: 'demo',
          kind: 'finding',
          origin: 'manual',
          file: input.file,
          line: input.line,
          lineEnd: null,
          createdAt: ts,
        };
        findings.push(finding);
        discussions.push(discussion);
        fire({ reviewId: 'demo', type: 'finding', payload: finding });
        fire({ reviewId: 'demo', type: 'discussion', payload: discussion });
        return finding;
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
          dismissReason: null,
          submission: 'unsubmitted',
          submittedUrl: null,
          round: 2,
          lastSeenRound: 2,
          resolution: null,
          resolutionNote: null,
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
      // 模拟原子 PR review 提交:success 标记待提交项 submitted 并回推;invalid/failed 不改状态
      submit: async () => {
        await new Promise((r) => setTimeout(r, 700));
        if (forceSubmit === 'invalid')
          return { status: 'invalid', message: 'pipeline.ts:20 不在最新 diff 的新增侧。' };
        if (forceSubmit === 'failed')
          return { status: 'failed', message: 'gh 认证已过期。' };
        const url = 'https://github.com/xieziyu/podcast-go/pull/482#pullrequestreview-1';
        const pending = findings.filter((f) => f.triage !== 'dismiss' && f.submission !== 'submitted');
        for (const f of pending) {
          const next = { ...f, submission: 'submitted' as const, submittedUrl: url, updatedAt: Date.now() };
          emit(next);
        }
        return { status: 'success', url, submittedCount: pending.filter((f) => f.file && f.line > 0).length };
      },
      openInBrowser: async () => {
        const url = 'https://github.com/xieziyu/podcast-go/pull/482';
        window.open(url, '_blank', 'noopener');
        return { ok: true, url };
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
      onStartProgress: (handler) => {
        startListeners.add(handler);
        return () => startListeners.delete(handler);
      },
    },
    notifications: {
      onOpenReview: (handler) => {
        openReviewListeners.add(handler);
        return () => openReviewListeners.delete(handler);
      },
      onInApp: (handler) => {
        inAppListeners.add(handler);
        return () => inAppListeners.delete(handler);
      },
    },
    ui: {
      getSettings: async () => uiSettings,
      saveSettings: async (s) => {
        uiSettings = s;
      },
    },
    agent: {
      // 预览无 codex:回一组假模型证明下拉渲染(真实里走 model/list)
      listModels: async () => [
        { model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '最新旗舰编码模型', isDefault: true },
        { model: 'gpt-5.6-terra', id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: '更快的日常模型', isDefault: false },
      ],
    },
    source: {
      // 预览态经 ?entry-state 切换:gh-auth(未登录)/ pr-error(解析失败)/ path-mismatch(remote 不匹配)
      checkGhAuth: async () => params.get('entry-state') !== 'gh-auth',
      previewPr: async (ref) => {
        if (params.get('entry-state') === 'pr-error') throw new Error('该 PR 不存在,或你没有访问权限。');
        const num = Number(ref.match(/(\d+)/)?.[1] ?? 482);
        const hit = OPEN_PRS.find((p) => p.number === num);
        return {
          nwo: 'xieziyu/podcast-go',
          number: num,
          title: hit?.title ?? 'feat: streaming transcode',
          author: hit?.author ?? 'ryan',
          additions: hit?.additions ?? 188,
          deletions: hit?.deletions ?? 41,
          changedFiles: 6,
          url: `https://github.com/xieziyu/podcast-go/pull/${num}`,
          baseRef: 'main',
        };
      },
      listOpenPrs: async () => OPEN_PRS,
      // entry-state=infer 演示粘贴 PR 后自动反推本地 clone;默认不命中(留空路径)
      inferLocalRepo: async () => (params.get('entry-state') === 'infer' ? '/Users/dev/podcast-go' : null),
      getRepoRemote: async () => ({
        nwo: params.get('entry-state') === 'path-mismatch' ? 'xieziyu/other-service' : 'xieziyu/podcast-go',
      }),
      listLocalBranches: async () => ({
        base: 'main',
        baseCandidates: ['main', 'develop', 'release/2.0'],
        branches: [
          { name: 'feat/stream-transcode', isHead: true, ahead: 4, updatedAt: Date.now() - 12 * 60_000, subject: 'wire streaming encoder' },
          { name: 'fix/feed-encoding', isHead: false, ahead: 2, updatedAt: Date.now() - 3 * 3600_000, subject: 'guard non-utf8 titles' },
        ],
      }),
      detectGitButler: async () => ({
        isWorkspace: params.get('entry-state') !== 'no-gb',
        repoName: 'podcast-go',
        branches: [
          { name: 'virtual/streaming', fileCount: 7, commitCount: 2, hasUncommitted: true },
          { name: 'virtual/api-cleanup', fileCount: 3, commitCount: 0, hasUncommitted: true },
        ],
      }),
    },
    prompt: {
      get: async (cwd) => buildPromptView(cwd),
      save: async (input) => {
        promptLayers[input.layer] = { ...input.sections };
        return buildPromptView(input.cwd);
      },
    },
    dialog: {
      // 预览无原生目录选择器:回一个假路径,让入口的本地/vbranch 选择流程能继续跑
      pickDirectory: async () => '~/Projects/podcast-go',
      pickFile: async () => '/opt/homebrew/bin/codex',
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
