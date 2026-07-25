/**
 * Headless 验证导出 Markdown 生成(纯函数,不烧 token、不碰 DB)。运行:npm run spike:export
 */
import { strict as assert } from 'node:assert';
import type { Finding, Review } from '../src/shared/domain';
import {
  buildReviewMarkdown,
  exportFileName,
  isKept,
  DEFAULT_EXPORT_OPTIONS,
} from '../src/shared/export-markdown';

function log(msg: string) {
  process.stdout.write(`[export] ${msg}\n`);
}

const T0 = Date.UTC(2026, 6, 20); // 固定时间戳 → 报告日期确定(2026-07-20)

const review: Review = {
  id: 'r1',
  source: 'local-branch',
  sourceRef: 'feat/streaming-transcode',
  repoPath: '/repo',
  codexThreadId: null,
  model: null,
  reasoningEffort: null,
  intensity: 'standard',
  title: null,
  status: 'completed',
  summaryBody: '并发方向合理,需收口共享状态的线程安全。',
  currentRound: 1,
  createdAt: T0,
  updatedAt: T0,
};

function mkFinding(p: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'title' | 'file' | 'line'>): Finding {
  return {
    reviewId: 'r1',
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
    createdAt: T0,
    updatedAt: T0,
    ...p,
  };
}

const findings: Finding[] = [
  mkFinding({
    id: 'f1',
    severity: 'high',
    category: 'Correctness',
    title: 'Cell 跨 spawn 数据竞争',
    body: '用 Arc<AtomicUsize> 替代。',
    file: 'src/pipeline.rs',
    line: 121,
    suggestion: 'let c = Arc::new(AtomicUsize::new(0));',
  }),
  mkFinding({
    id: 'f2',
    severity: 'low',
    category: 'Naming',
    title: '变量名 c 可读性差',
    body: '',
    file: 'src/pipeline.rs',
    line: 123,
  }),
  mkFinding({
    id: 'f3',
    severity: 'medium',
    category: 'Architecture',
    title: 'JoinSet 无背压',
    body: '用 Semaphore 限并发。',
    file: 'src/worker.rs',
    line: 40,
    triage: 'dismiss', // 已剔除项
  }),
];

function main() {
  // ---- 文件名 slug ----
  assert.equal(exportFileName(review), 'review-feat-streaming-transcode.md');
  assert.equal(exportFileName({ ...review, title: 'Fix: 并发 Bug!!' }), 'review-fix-bug.md');
  log('exportFileName slug ok');

  // ---- 默认选项:摘要 + 保留项按严重度 + suggestion,不含剔除项 ----
  const md = buildReviewMarkdown(review, findings);
  assert.match(md, /^# Review — feat\/streaming-transcode/);
  assert.match(md, /2026-07-20/);
  assert.match(md, /## 摘要\n\n并发方向合理/);
  assert.match(md, /## Findings（保留 2）/);
  // 按严重度:high(f1)应在 medium 之前;f3 已剔除不出现在保留区
  assert.ok(md.indexOf('Cell 跨 spawn') < md.indexOf('变量名 c'), '按严重度排序 high 在 low 前');
  assert.ok(!md.includes('JoinSet 无背压'), '剔除项默认不出现');
  assert.match(md, /```suggestion\nlet c = Arc::new/, 'suggestion 代码块');
  assert.match(md, /`src\/pipeline\.rs:121`/, '锚点行');
  log('默认导出结构 ok');

  // ---- 关闭 summary / suggestion ----
  const md2 = buildReviewMarkdown(review, findings, {
    ...DEFAULT_EXPORT_OPTIONS,
    summary: false,
    suggestion: false,
  });
  assert.ok(!md2.includes('## 摘要'), 'summary=false 去摘要');
  assert.ok(!md2.includes('```suggestion'), 'suggestion=false 去代码块');
  log('开关 summary/suggestion ok');

  // ---- 含已剔除项 ----
  const md3 = buildReviewMarkdown(review, findings, { ...DEFAULT_EXPORT_OPTIONS, dismissed: true });
  assert.match(md3, /## 已剔除（1）/);
  assert.match(md3, /~~JoinSet 无背压~~/);
  log('已剔除项列出 ok');

  // ---- 按文件分组 ----
  const md4 = buildReviewMarkdown(review, findings, { ...DEFAULT_EXPORT_OPTIONS, group: 'file' });
  assert.match(md4, /### src\/pipeline\.rs/, '文件级 h3');
  assert.match(md4, /#### 🔴 high · Correctness/, 'finding 降为 h4');
  log('按文件分组 ok');

  // ---- 全部剔除:findings 区提示空 ----
  const allDropped = findings.map((f) => ({ ...f, triage: 'dismiss' as const }));
  const md5 = buildReviewMarkdown(review, allDropped);
  assert.match(md5, /## Findings（保留 0）/);
  assert.match(md5, /没有保留任何 finding/);
  assert.equal(allDropped.filter(isKept).length, 0);
  log('全部剔除空态 ok');

  log('────────────────────────');
  log('✅ PASS — 导出 Markdown 生成:slug/结构/开关/分组/剔除/空态全通过');
}

try {
  main();
  process.exit(0);
} catch (e) {
  process.stdout.write(`[export] ❌ FAIL — ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
