/**
 * 预览用 fixture:在纯浏览器里 stub `window.duetlens`,喂静态 diff/findings,
 * 让真实 React 组件 + 真实 CSS 脱离 Electron 渲染,便于视觉自查(截图/双主题)。
 * 仅 preview 入口引用,不进 app 打包路径。
 */
import { parseUnifiedDiff } from '@shared/diff';
import type {
  BusyReview,
  CompletionNotice,
  DuetlensApi,
  RecentReview,
  ReviewEvent,
  ReviewStartProgress,
  ReviewStartStage,
} from '@shared/ipc';
import type { PrSummary } from '@shared/source-discovery';
import { scanDoneStatus } from '@shared/domain';
import { isSubmittable } from '@shared/github-review';
import type { Discussion, Finding, FindingProposal, Message, Review, ReviewRound, ReviewUiState, UiSettings } from '@shared/domain';
import { mergeLayers } from '@shared/prompt';
import { APP_VERSION } from '@shared/version';
import type { UpdateStatus } from '@shared/update';

const UPDATE_FIXTURES: Record<string, UpdateStatus> = {
  unsupported: { phase: 'unsupported' },
  checking: { phase: 'checking' },
  current: { phase: 'current' },
  downloading: { phase: 'downloading', version: '0.2.0', percent: 42 },
  ready: { phase: 'ready', version: '0.2.0' },
  error: { phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' },
};
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
@@ -1,4 +1,6 @@
 .btn {
-  color: red;
+  color: var(--accent);
+  padding: 4px 8px;
+  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.08), inset 0 0 0 1px color-mix(in oklab, var(--accent) 24%, transparent); /* 够长的一行,用来自查横滚下行号与行内 ＋ 是否还够得着 */
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

/**
 * 「PR 在审核后又推进过」的最新 diff:pipeline.ts 的 hunk 整体下移,原先 16/19/20 行的锚点
 * 全部落空 —— 提交屏现拉最新 diff 才能定位到这些失效锚点(照快照判会以为一切正常)。
 */
const RAW_DIFF_MOVED = RAW_DIFF.replace('@@ -14,9 +14,11 @@', '@@ -30,9 +30,11 @@');

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
  status: 'completed',
  summaryBody: '本次改动引入并发编码管线,整体方向合理,但并发计数存在数据竞争,需修正。',
  currentRound: 2,
  createdAt: now,
  updatedAt: now,
};

// 入口「最近的审核」/ 历史屏列表 fixture(覆盖三来源 × 状态 × 时间分桶)
const RECENT_REVIEWS: RecentReview[] = [
  { ...REVIEW, id: 'r1', source: 'github-pr', sourceRef: 'xieziyu/podcast-go#482', title: 'feat: streaming transcode', status: 'reviewing', findingCount: 3, discussionCount: 2, submittedCount: 0, updatedAt: now - 23 * 60_000 },
  { ...REVIEW, id: 'r2', source: 'github-pr', sourceRef: 'xieziyu/podcast-go#479', title: 'fix: episode duration off-by-one on live cutover', status: 'submitted', findingCount: 5, discussionCount: 0, submittedCount: 4, updatedAt: now - 5 * 3600_000 },
  { ...REVIEW, id: 'r3', source: 'local-branch', sourceRef: 'fix/feed-encoding', title: 'fix/feed-encoding', repoPath: '/Users/dev/podcast-go', status: 'completed', findingCount: 0, discussionCount: 0, submittedCount: 0, updatedAt: now - 26 * 3600_000 },
  { ...REVIEW, id: 'r4', source: 'gitbutler-vbranch', sourceRef: 'virtual/api-cleanup', title: 'virtual/api-cleanup', repoPath: '/Users/dev/duetlens', status: 'completed', findingCount: 2, discussionCount: 1, submittedCount: 0, updatedAt: now - 4 * 86_400_000 },
  { ...REVIEW, id: 'r5', source: 'github-pr', sourceRef: 'xieziyu/duetlens#471', title: 'refactor: extract prompt resolver into shared', repoPath: null, status: 'submitted', findingCount: 8, discussionCount: 0, submittedCount: 6, updatedAt: now - 10 * 86_400_000 },
  { ...REVIEW, id: 'r6', source: 'local-branch', sourceRef: 'fix/transcode-timeout', repoPath: '/Users/dev/podcast-go', title: 'fix/transcode-timeout', status: 'failed', findingCount: 1, discussionCount: 0, submittedCount: 0, updatedAt: now - 17 * 86_400_000 },
  // 距 30 天保留期只剩 3 天:历史屏的临期标记只有这种行才出现,没有它就自查不到
  { ...REVIEW, id: 'r7', source: 'github-pr', sourceRef: 'xieziyu/podcast-go#440', title: 'chore: bump ffmpeg to 7.1', status: 'completed', findingCount: 2, discussionCount: 0, submittedCount: 0, updatedAt: now - 27 * 86_400_000 },
];

// 满载提示 fixture:正在跑的会话(?busy=1..4)
const BUSY_REVIEWS: BusyReview[] = [
  { reviewId: 'r1', title: 'feat: streaming transcode', sourceRef: 'xieziyu/podcast-go#482', source: 'github-pr', round: 1, scanning: true },
  { reviewId: 'r2', title: 'fix: episode duration off-by-one on live cutover', sourceRef: 'xieziyu/podcast-go#479', source: 'github-pr', round: 2, scanning: true },
  { reviewId: 'r3', title: 'fix/feed-encoding', sourceRef: 'fix/feed-encoding', source: 'local-branch', round: 1, scanning: true },
  { reviewId: 'r4', title: 'virtual/api-cleanup', sourceRef: 'virtual/api-cleanup', source: 'gitbutler-vbranch', round: 3, scanning: false },
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
    submittedRound: null,
    round: 1,
    lastSeenRound: 1,
    resolution: null,
    resolutionNote: null,
    autoClosed: false,
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
    autoClosed: true,
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
  // 第 1 轮就提交给 author、第 2 轮复核仍存在 —— 提交屏据此追发一条带复核说明的评论
  mkFinding({
    id: 'f7',
    severity: 'high',
    category: 'Error Handling',
    title: '重试循环吞掉最后一次错误',
    body: '重试耗尽后返回 null,调用方无从区分"没结果"与"全部失败",线上排查只能靠猜。',
    file: 'src/pipeline.ts',
    line: 33,
    submission: 'submitted',
    submittedUrl: 'https://github.com/acme/repo/pull/1#pullrequestreview-1',
    submittedRound: 1,
    lastSeenRound: 2,
    resolution: 'still_present',
    resolutionNote: '第 2 轮复核:加了日志,但仍旧返回 null —— 调用方拿到的信息没变,问题照旧。',
  }),
];

const ROUNDS: ReviewRound[] = [
  {
    reviewId: 'demo', round: 1, codexThreadId: 'thread-demo-1', headSha: '3f9a1c2e5b7d',
    status: 'done', note: null, newFindings: 3, fixedCount: 0, suppressedCount: 0,
    errorMessage: null, errorKind: null, changedFiles: [], codeChanged: false,
    startedAt: now - 3 * 3600_000, endedAt: now - 3 * 3600_000 + 210_000,
  },
  {
    reviewId: 'demo', round: 2, codexThreadId: 'thread-demo-2', headSha: 'a41d80b6cc02',
    status: 'done', note: '作者说已修了并发那条,重点复核。', newFindings: 1, fixedCount: 1, suppressedCount: 2,
    errorMessage: null, errorKind: null,
    changedFiles: ['src/renderer/screens/EntryScreen.tsx'], codeChanged: true,
    startedAt: now - 25 * 60_000, endedAt: now - 21 * 60_000,
  },
];

/** `?round=failed` 的收尾态:复现"上游 503,codex 自行重试 5 次仍失败"这类最常见的失败。 */
const FAILED_ROUND: ReviewRound = {
  ...ROUNDS[1],
  status: 'failed',
  newFindings: 0,
  fixedCount: 0,
  errorMessage:
    'unexpected status 503 Service Unavailable: Service Unavailable, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a20a2f1fcec6ce22-SIN, auth error: 503, auth error code: biscuit_baker_service_me_circuit_open',
  errorKind: 'server-overloaded',
  endedAt: now - 21 * 60_000,
};

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
  lastRepoPath: '/Users/dev/podcast-go',
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
    {
      id: 'm-user-seed-2',
      discussionId: 'd-user-seed',
      role: 'agent',
      text: '会。读-改-写三步之间可被另一个 task 打断,统计值会偏小。这值得单独记一条。',
      createdAt: now + 1500,
    },
  ],
  'd-f5': [
    {
      id: 'm-seed-f5-q',
      discussionId: 'd-f5',
      role: 'user',
      text: '这个函数在本次改动里还有调用点吗?',
      createdAt: now + 3000,
    },
    {
      id: 'm-seed-f5',
      discussionId: 'd-f5',
      role: 'agent',
      text: '没有了 —— 最后一处引用随本次改动一并删除,这条 finding 描述的路径不可达。',
      createdAt: now + 3200,
    },
  ],
};

/**
 * 回写提案 fixture:三种状态各一,便于自查提案卡的 pending / applied / skipped 三态。
 * update 挂在 d-f1 的 agent 回复上;dismiss 走 d-f3(那条本就是剔除态,可自查恢复档)。
 */
const SEED_PROPOSALS: FindingProposal[] = [
  {
    id: 'p-update',
    reviewId: 'demo',
    discussionId: 'd-f1',
    messageId: 'm-seed-2',
    findingId: 'f1',
    kind: 'update',
    patch: {
      severity: 'medium',
      title: 'counter 跨 spawn 共享:近似进度下可放宽为 Relaxed 原子',
      body: '仍需原子类型(跨线程),但只求近似进度时 Ordering::Relaxed 即可,开销接近裸加。原文按「必须加锁」写,过重了。',
    },
    before: null,
    baseUpdatedAt: now,
    status: 'pending',
    createdAt: now + 2500,
    resolvedAt: null,
  },
  {
    id: 'p-dismiss',
    reviewId: 'demo',
    discussionId: 'd-f5',
    messageId: 'm-seed-f5',
    findingId: 'f5',
    kind: 'dismiss',
    patch: { reason: '这条路径的调用点已随本次改动删除,代码不可达;原文描述的场景在当前分支上不存在。' },
    before: null,
    baseUpdatedAt: now,
    status: 'pending',
    createdAt: now + 3500,
    resolvedAt: null,
  },
  {
    // 已提交的 finding:内容锁定,提案不可应用。同时 d-f7 没有消息,顺带自查「挂不上消息的提案」那条路
    id: 'p-locked',
    reviewId: 'demo',
    discussionId: 'd-f7',
    messageId: null,
    findingId: 'f7',
    kind: 'update',
    patch: { severity: 'medium', body: '重试耗尽后返回 null,建议改为抛出最后一次错误。' },
    before: null,
    baseUpdatedAt: now,
    status: 'pending',
    createdAt: now + 3800,
    resolvedAt: null,
  },
  {
    id: 'p-done',
    reviewId: 'demo',
    discussionId: 'd-user-seed',
    messageId: 'm-user-seed-2',
    findingId: null,
    kind: 'create',
    patch: {
      severity: 'high',
      category: 'Correctness',
      title: 'done += 1 在并发下丢更新',
      body: '多个 task 并发自增同一个非原子计数器,读-改-写之间可被打断,统计值会偏小。',
      file: 'src/pipeline.ts',
      line: 19,
      // 带 suggestion:它会随新 finding 落库并最终发给 author,卡上必须看得见
      suggestion: '      counter.fetch_add(1, Ordering::Relaxed);',
    },
    before: null,
    baseUpdatedAt: null,
    status: 'pending',
    createdAt: now + 4000,
    resolvedAt: null,
  },
];

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
  // 无 cwd 时后端读不到 project 层文件,合并里就不该有 project 覆盖
  const { sections } = mergeLayers(cwd ? promptLayers.project : {}, promptLayers.global);
  return {
    sections,
    // 与后端同样按 cwd 门控:demo review 带 repoPath,规则屏继承它;`?source=github` 则落到未选态
    projectPath: cwd ? `${cwd}/.duetlens/review.md` : null,
    // 后端返回绝对路径,`~` 折叠是渲染层的事;fixture 跟着给绝对路径才测得到折叠
    globalPath: '/Users/dev/.duetlens/review.md',
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
  // ?round=failed 让当前轮停在失败态,自查进度条的失败卡与状态栏指路
  const asRoundFailed = params.get('round') === 'failed';
  // ?scan&round=retrying 模拟 agent 自行退避重试(那几十秒原本没有任何信号)
  const asRetrying = params.get('round') === 'retrying';
  let retrySimulated = false;
  let usageSimulated = false;
  // 可变:重跑 stub 会改 currentRound / status,模拟后端回推后的新值
  let review: Review = {
    ...REVIEW,
    ...(asGithub ? { source: 'github-pr', sourceRef: 'xieziyu/podcast-go#482', repoPath: null } : {}),
    ...(asScanning ? { status: 'scanning' as const } : {}),
    ...(asRoundFailed ? { status: 'failed' as const } : {}),
  };
  // entry-state=pick 清掉记住的仓库,自查本地仓库档的选目录空态
  // ?mode= / ?theme= 直接开在某套配色上:出图与逐屏比色都要它,靠点 rail 那颗钮只能切明暗、切不了主题
  const asMode = params.get('mode');
  const asTheme = params.get('theme');
  let uiSettings: UiSettings = {
    ...UI_SETTINGS,
    ...(params.get('entry-state') === 'pick' ? { lastRepoPath: '' } : {}),
    ...(asMode === 'light' || asMode === 'dark' ? { dataMode: asMode } : {}),
    ...(asTheme === 'duetlens' || asTheme === 'github' || asTheme === 'parchment'
      ? { dataTheme: asTheme }
      : {}),
  };
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
  const rounds: ReviewRound[] =
    asClean || asStream ? [] : asRoundFailed ? [{ ...ROUNDS[0] }, { ...FAILED_ROUND }] : ROUNDS.map((r) => ({ ...r }));
  const discussions = asClean || asStream ? [] : DISCUSSIONS.map((d) => ({ ...d }));
  const msgStore: Record<string, Message[]> = structuredClone(SEED_MESSAGES);
  const proposals: FindingProposal[] =
    asClean || asStream ? [] : structuredClone(SEED_PROPOSALS);
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

  const updateListeners = new Set<(s: UpdateStatus) => void>();
  const fireUpdate = (): void => {
    for (const l of updateListeners) l(updateStatus);
  };
  let updateStatus: UpdateStatus = UPDATE_FIXTURES[params.get('upd') ?? 'current'] ?? {
    phase: 'current',
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
      version: APP_VERSION,
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
      // ?review=error 模拟读库失败,自查依赖它的屏不会卡在加载态
      get: async () => {
        if (params.get('review') === 'error') throw new Error('database is locked');
        return review;
      },
      findings: async () => findings,
      diff: async () => diff,
      // ?submit=invalid 时最新 diff 已推进(锚点落空),?latest=error 模拟 gh 读不到
      latestDiff: async () => {
        await new Promise((r) => setTimeout(r, 600));
        if (params.get('latest') === 'error')
          return { ok: false, message: 'gh: Could not resolve to a PullRequest with the number of 482.' };
        const moved = forceSubmit === 'invalid';
        return {
          ok: true,
          diff: moved ? parseUnifiedDiff(RAW_DIFF_MOVED) : diff,
          headSha: moved ? 'c7d19ab4e102' : 'bb17e4f0a993',
          headMoved: moved,
        };
      },
      fileContent: async (_r, path) => (path === 'src/pipeline.ts' ? PIPELINE_SRC : null),
      discussions: async () => discussions,
      proposals: async () => proposals,
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
        if (params.get('retry') === 'error')
          throw new Error(
            "Error invoking remote method 'review:rerun': Error: Command failed: but diff feat/entry-branch-picker --format json --no-tui\nNo ID found for entity No ID found for entity\n",
          );
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
          errorMessage: null,
          errorKind: null,
          changedFiles: [],
          codeChanged: true,
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
          const settled = scanDoneStatus(review.source);
          review = { ...review, status: settled };
          fire({ reviewId: 'demo', type: 'round', payload: done });
          fire({ reviewId: 'demo', type: 'status', payload: settled });
        }, 4000);
        return round;
      },
      // 重试:沿用同一轮号覆盖失败记录,3s 后收轮 —— 与后端 startRound 的 upsert 语义一致
      retryRound: async () => {
        // ?retry=error:重跑/重试在**开跑前**就失败(source 没了),自查 LaunchError 的呈现
        if (params.get('retry') === 'error')
          throw new Error(
            "Error invoking remote method 'review:retry-round': Error: Command failed: but diff feat/entry-branch-picker --format json --no-tui\nNo ID found for entity No ID found for entity\n",
          );
        const failed = rounds[rounds.length - 1];
        const round: ReviewRound = {
          ...failed,
          status: 'scanning',
          errorMessage: null,
          errorKind: null,
          startedAt: Date.now(),
          endedAt: null,
        };
        rounds[rounds.length - 1] = round;
        review = { ...review, status: 'scanning' };
        fire({ reviewId: 'demo', type: 'round', payload: round });
        fire({ reviewId: 'demo', type: 'status', payload: 'scanning' });
        setTimeout(() => {
          const done: ReviewRound = { ...round, status: 'done', newFindings: 1, endedAt: Date.now() };
          rounds[rounds.length - 1] = done;
          const settled = scanDoneStatus(review.source);
          review = { ...review, status: settled };
          fire({ reviewId: 'demo', type: 'round', payload: done });
          fire({ reviewId: 'demo', type: 'status', payload: settled });
        }, 3000);
        return round;
      },
      // 叫停:本轮就地收成 stopped,已上报的 findings 一条不动 —— 与后端 settleRound 同语义
      stopScan: async () => {
        if (params.get('stop') === 'error')
          throw new Error(
            "Error invoking remote method 'review:stop-scan': Error: 本轮机审已结束,无需停止",
          );
        const cur = rounds[rounds.length - 1];
        const stopped: ReviewRound = { ...cur, status: 'stopped', endedAt: Date.now() };
        rounds[rounds.length - 1] = stopped;
        const settled = scanDoneStatus(review.source);
        review = { ...review, status: settled };
        fire({ reviewId: 'demo', type: 'round', payload: stopped });
        fire({ reviewId: 'demo', type: 'status', payload: settled });
      },
      resume: async () => review,
      // ?busy=N 模拟 N 条会话正在跑;=4 即满载,入口据此显示拦截面板
      capacity: async () => {
        const busyCount = Math.min(4, Number(params.get('busy') ?? 0) || 0);
        return {
          max: 4,
          live: Math.max(busyCount, busyCount ? 4 : 0),
          busy: BUSY_REVIEWS.slice(0, busyCount),
        };
      },
      release: async () => {},
      delete: async () => {},
      addDiscussion: async (_r, anchor) => {
        const d: Discussion = {
          id: `d-user-${Date.now()}`,
          reviewId: 'demo',
          kind: 'user',
          origin: 'manual',
          file: anchor?.file ?? null,
          line: anchor?.line ?? null,
          lineEnd: anchor?.lineEnd ?? null,
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
      // 提案三个去向:与后端同样真的改内存态并回推,便于在预览里走完「应用 → 卡片刷新 → 撤销」
      applyProposal: async (_r, proposalId) => {
        const i = proposals.findIndex((p) => p.id === proposalId);
        const p = proposals[i];
        const f = p.findingId ? findings.find((x) => x.id === p.findingId) : null;
        // 旧值快照与后端同步落下 —— 不记的话预览里永远走不到「↩ 撤销」那条路
        let before: FindingProposal['before'] = null;
        if (p.kind === 'update' && f) {
          // 与后端同口径:只拍 patch 动过的字段,拍全量会让撤销顺手回滚应用之后的编辑
          before = Object.fromEntries(
            Object.keys(p.patch).map((k) => [k, (f as unknown as Record<string, unknown>)[k]]),
          );
          emit({ ...f, ...p.patch, updatedAt: Date.now() });
        } else if ((p.kind === 'dismiss' || p.kind === 'restore') && f) {
          before = { triage: f.triage, dismissReason: f.dismissReason, autoClosed: f.autoClosed };
          emit({
            ...f,
            triage: p.kind === 'dismiss' ? 'dismiss' : 'open',
            dismissReason: p.kind === 'dismiss' ? p.patch.reason : null,
            autoClosed: false,
            updatedAt: Date.now(),
          });
        }
        const next = { ...p, before, status: 'applied' as const, resolvedAt: Date.now() } as FindingProposal;
        proposals[i] = next;
        fire({ reviewId: 'demo', type: 'finding-proposal', payload: next });
        return next;
      },
      skipProposal: async (_r, proposalId) => {
        const i = proposals.findIndex((p) => p.id === proposalId);
        const next = { ...proposals[i], status: 'skipped' as const, resolvedAt: Date.now() };
        proposals[i] = next;
        fire({ reviewId: 'demo', type: 'finding-proposal', payload: next });
        return next;
      },
      undoProposal: async (_r, proposalId) => {
        const i = proposals.findIndex((p) => p.id === proposalId);
        const p = proposals[i];
        const f = p.findingId ? findings.find((x) => x.id === p.findingId) : null;
        if (f && p.before) emit({ ...f, ...p.before, updatedAt: Date.now() });
        const next = { ...p, status: 'skipped' as const, resolvedAt: Date.now() };
        proposals[i] = next;
        fire({ reviewId: 'demo', type: 'finding-proposal', payload: next });
        return next;
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
          submittedRound: null,
          round: 2,
          lastSeenRound: 2,
          resolution: null,
          resolutionNote: null,
          autoClosed: false,
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
          submittedRound: null,
          round: 2,
          lastSeenRound: 2,
          resolution: null,
          resolutionNote: null,
          autoClosed: false,
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
        const pending = findings.filter((f) => isSubmittable(f, review.currentRound));
        for (const f of pending) {
          const next = {
            ...f,
            submission: 'submitted' as const,
            submittedUrl: url,
            submittedRound: review.currentRound,
            updatedAt: Date.now(),
          };
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
        // 状态栏那枚上下文环只有收到 token-usage 才出现;给一发真实量级的数(gpt-5.6 有效窗口 258,400)
        if (!usageSimulated) {
          usageSimulated = true;
          setTimeout(
            () => fire({ reviewId: 'demo', type: 'agent', payload: { kind: 'token-usage', used: 62_732, cumulative: 1_161_165, total: 258_400 } }),
            300,
          );
        }
        // ?scan&round=retrying:扫描期插一串 agent 退避重试事件,自查进度条的重试提示。
        // 只排一次 —— StrictMode 双挂载会订阅两次,不设闸门次数就会翻倍。
        if (asRetrying && !retrySimulated) {
          retrySimulated = true;
          for (const n of [1, 2, 3])
            setTimeout(
              () =>
                fire({
                  reviewId: 'demo',
                  type: 'agent',
                  payload: {
                    kind: 'turn-retrying',
                    turnId: 't1',
                    error: 'stream disconnected: 503 Service Unavailable',
                    errorKind: 'server-overloaded',
                  },
                }),
              n * 900,
            );
        }
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
    // ?upd=current|checking|downloading|ready|error|unsupported(缺省 current)
    update: {
      getStatus: async () => updateStatus,
      check: async () => {
        updateStatus = { phase: 'checking' };
        fireUpdate();
        setTimeout(() => {
          updateStatus = { phase: 'current' };
          fireUpdate();
        }, 900);
      },
      install: async () => undefined,
      onStatus: (handler) => {
        updateListeners.add(handler);
        return () => updateListeners.delete(handler);
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
      // entry-state:no-branches 演示没有领先 base 的分支(选择器禁用);many-branches 演示长列表(浮层定高/上翻)
      // 留一点延迟:列举中途切走仓库/模式的竞态,只有异步才复现得出来
      listLocalBranches: async (_repoPath, base) => {
        await new Promise((r) => setTimeout(r, 400));
        const state = params.get('entry-state');
        const branches = [
          { name: 'feat/stream-transcode', isHead: true, ahead: 4, updatedAt: Date.now() - 12 * 60_000, subject: 'wire streaming encoder' },
          { name: 'fix/feed-encoding', isHead: false, ahead: 2, updatedAt: Date.now() - 3 * 3600_000, subject: 'guard non-utf8 titles' },
          ...(state === 'many-branches'
            ? Array.from({ length: 14 }, (_, i) => ({
                name: `chore/cleanup-${i + 1}`,
                isHead: false,
                ahead: (i % 5) + 1,
                updatedAt: Date.now() - (i + 1) * 7 * 3600_000,
                subject: `drop dead code in module ${i + 1}`,
              }))
            : []),
        ];
        return {
          base: base ?? 'main',
          baseCandidates: ['main', 'develop', 'release/2.0'],
          branches: state === 'no-branches' ? [] : branches,
        };
      },
      // entry-state=no-gb 演示普通 git 分支模式;gb-degraded 演示 HEAD 在 workspace 但 but 不可用
      inspectRepo: async (repoPath) => {
        await new Promise((r) => setTimeout(r, 250));
        const state = params.get('entry-state');
        const gitbutler = {
          isWorkspace: true,
          repoName: 'podcast-go',
          branches: [
            { name: 'virtual/streaming', fileCount: 7, commitCount: 2, hasUncommitted: true },
            { name: 'virtual/api-cleanup', fileCount: 3, commitCount: 0, hasUncommitted: true },
          ],
        };
        const base = { repoPath, repoName: 'podcast-go', isGit: true, gitbutler: null, degraded: null } as const;
        // ?repo=gone 演示目录已被移走/删除(git rev-parse 失败即 isGit=false)
        if (params.get('repo') === 'gone')
          return { ...base, isGit: false, head: null, mode: 'local' };
        if (state === 'no-gb' || state === 'no-branches' || state === 'many-branches')
          return { ...base, head: 'feat/stream-transcode', mode: 'local' };
        if (state === 'gb-degraded')
          return { ...base, head: 'gitbutler/workspace', mode: 'local', degraded: 'but-missing' };
        return { ...base, head: 'gitbutler/workspace', mode: 'gitbutler', gitbutler };
      },
      listRepoPaths: async () => ['/Users/dev/GitHub/backend-podcast-node', '/Users/dev/duetlens'],
    },
    prompt: {
      get: async (cwd) => buildPromptView(cwd),
      // ?prompt=save-error 模拟写盘失败(目录只读 / 磁盘满),自查失败态与 draft 保留
      save: async (input) => {
        if (params.get('prompt') === 'save-error')
          throw new Error("EACCES: permission denied, open '/repo/.duetlens/review.md'");
        // ?prompt=slow-save 撑开写盘窗口:保存在途时切层另开编辑器的竞态,只有异步才复现得出来
        if (params.get('prompt') === 'slow-save') await new Promise((r) => setTimeout(r, 8000));
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
