import { randomUUID } from 'node:crypto';
import type { AgentErrorKind } from '@shared/agent-events';
import type { RecentReview } from '@shared/ipc';
import type { DB } from './database';
import {
  DEFAULT_UI_SETTINGS,
  type Discussion,
  type Finding,
  type FindingResolution,
  type Message,
  type MessageRole,
  type ReportFindingInput,
  DEFAULT_REVIEW_UI_STATE,
  type Review,
  type ReviewRound,
  type ReviewStatus,
  type ReviewUiState,
  type RoundStatus,
  type SourceKind,
  type Submission,
  type Triage,
  type UiSettings,
  type UpdateFindingInput,
} from '@shared/domain';

const now = () => Date.now();

interface ReviewRow {
  id: string;
  source: string;
  source_ref: string;
  repo_path: string | null;
  codex_thread_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  intensity: string;
  title: string | null;
  status: string;
  summary_body: string | null;
  current_round: number;
  created_at: number;
  updated_at: number;
}

interface RoundRow {
  review_id: string;
  round: number;
  codex_thread_id: string | null;
  head_sha: string | null;
  status: string;
  note: string | null;
  new_findings: number;
  fixed_count: number;
  suppressed_count: number;
  error_message: string | null;
  error_kind: string | null;
  changed_files: string;
  code_changed: number;
  started_at: number;
  ended_at: number | null;
}

interface FindingRow {
  id: string;
  review_id: string;
  discussion_id: string;
  origin: string;
  severity: string;
  category: string | null;
  title: string;
  body: string;
  file: string;
  line: number;
  suggestion: string | null;
  triage: string;
  dismiss_reason: string | null;
  submission: string;
  submitted_url: string | null;
  round: number;
  last_seen_round: number;
  resolution: string | null;
  resolution_note: string | null;
  created_at: number;
  updated_at: number;
}

interface DiscussionRow {
  id: string;
  review_id: string;
  kind: string;
  origin: string;
  file: string | null;
  line: number | null;
  line_end: number | null;
  created_at: number;
}

interface MessageRow {
  id: string;
  discussion_id: string;
  role: string;
  text: string;
  created_at: number;
}

function toReview(r: ReviewRow): Review {
  return {
    id: r.id,
    source: r.source as SourceKind,
    sourceRef: r.source_ref,
    repoPath: r.repo_path,
    codexThreadId: r.codex_thread_id,
    model: r.model,
    reasoningEffort: r.reasoning_effort as Review['reasoningEffort'],
    intensity: r.intensity as Review['intensity'],
    title: r.title,
    status: r.status as ReviewStatus,
    summaryBody: r.summary_body,
    currentRound: r.current_round,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRound(r: RoundRow): ReviewRound {
  return {
    reviewId: r.review_id,
    round: r.round,
    codexThreadId: r.codex_thread_id,
    headSha: r.head_sha,
    status: r.status as RoundStatus,
    note: r.note,
    newFindings: r.new_findings,
    fixedCount: r.fixed_count,
    suppressedCount: r.suppressed_count,
    errorMessage: r.error_message,
    errorKind: (r.error_kind as ReviewRound['errorKind']) ?? null,
    changedFiles: parseChangedFiles(r.changed_files),
    codeChanged: r.code_changed === 1,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/** 手改过库或旧版本写坏都不该让整屏轮次读不出来,坏值退化成空列表。 */
function parseChangedFiles(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    reviewId: r.review_id,
    discussionId: r.discussion_id,
    origin: r.origin as Finding['origin'],
    severity: r.severity as Finding['severity'],
    category: r.category,
    title: r.title,
    body: r.body,
    file: r.file,
    line: r.line,
    suggestion: r.suggestion,
    triage: (r.triage === 'keep' ? 'open' : r.triage) as Triage,
    dismissReason: r.dismiss_reason,
    submission: r.submission as Submission,
    submittedUrl: r.submitted_url,
    round: r.round,
    lastSeenRound: r.last_seen_round,
    resolution: r.resolution as FindingResolution | null,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDiscussion(r: DiscussionRow): Discussion {
  return {
    id: r.id,
    reviewId: r.review_id,
    kind: r.kind as Discussion['kind'],
    origin: r.origin as Discussion['origin'],
    file: r.file,
    line: r.line,
    lineEnd: r.line_end,
    createdAt: r.created_at,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    discussionId: r.discussion_id,
    role: r.role as MessageRole,
    text: r.text,
    createdAt: r.created_at,
  };
}

/**
 * review / discussion / finding / message + UI 状态的权威读写。
 * 前端不本地臆造权威数据,一律经此落库后回推(见 frontend-components.md 状态分层)。
 */
export class ReviewStore {
  constructor(private readonly db: DB) {}

  // ---- reviews ----
  createReview(input: {
    source: SourceKind;
    sourceRef: string;
    repoPath?: string | null;
    title?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    intensity?: Review['intensity'];
  }): Review {
    const ts = now();
    const row: ReviewRow = {
      id: randomUUID(),
      source: input.source,
      source_ref: input.sourceRef,
      repo_path: input.repoPath ?? null,
      codex_thread_id: null,
      model: input.model ?? null,
      reasoning_effort: input.reasoningEffort ?? null,
      intensity: input.intensity ?? 'standard',
      title: input.title ?? null,
      status: 'scanning',
      summary_body: null,
      current_round: 1,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO reviews (id, source, source_ref, repo_path, codex_thread_id, model, reasoning_effort, intensity, title, status, summary_body, current_round, created_at, updated_at)
         VALUES (@id, @source, @source_ref, @repo_path, @codex_thread_id, @model, @reasoning_effort, @intensity, @title, @status, @summary_body, @current_round, @created_at, @updated_at)`,
      )
      .run(row);
    return toReview(row);
  }

  getReview(id: string): Review | null {
    const r = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
    return r ? toReview(r) : null;
  }

  listReviews(): Review[] {
    const rows = this.db
      .prepare('SELECT * FROM reviews ORDER BY updated_at DESC')
      .all() as ReviewRow[];
    return rows.map(toReview);
  }

  /** 最近审核列表:每条 review 附带 finding / 用户 discussion / 已提交计数(入口展示用)。 */
  listRecentReviews(): RecentReview[] {
    const rows = this.db
      .prepare(
        `SELECT r.*,
            (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id) AS finding_count,
            (SELECT COUNT(*) FROM discussions d WHERE d.review_id = r.id AND d.kind = 'user') AS discussion_count,
            (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id AND f.submission = 'submitted') AS submitted_count
         FROM reviews r
         ORDER BY r.updated_at DESC`,
      )
      .all() as (ReviewRow & { finding_count: number; discussion_count: number; submitted_count: number })[];
    return rows.map((r) => ({
      ...toReview(r),
      findingCount: r.finding_count,
      discussionCount: r.discussion_count,
      submittedCount: r.submitted_count,
    }));
  }

  /** 历史审核用过的本地仓库路径(去重、最近在前),供 PR 反推本地 clone 时优先比对与取扫描根。 */
  listRepoPaths(limit = 50): string[] {
    const rows = this.db
      .prepare(
        `SELECT repo_path FROM reviews
         WHERE repo_path IS NOT NULL AND repo_path <> ''
         GROUP BY repo_path
         ORDER BY MAX(updated_at) DESC
         LIMIT ?`,
      )
      .all(limit) as { repo_path: string }[];
    return rows.map((r) => r.repo_path);
  }

  /** 删除一次审核;discussions / findings / messages / ui_state / diffs 经 FK 级联清理。 */
  deleteReview(id: string): void {
    this.db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  }

  setCodexThreadId(reviewId: string, threadId: string): void {
    this.db
      .prepare('UPDATE reviews SET codex_thread_id = ?, updated_at = ? WHERE id = ?')
      .run(threadId, now(), reviewId);
  }

  /** 记下 agent 侧实际生效的模型(用户未指定时由 thread 起会话后回填)。 */
  setReviewModel(reviewId: string, model: string): void {
    this.db
      .prepare('UPDATE reviews SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, now(), reviewId);
  }

  setReviewStatus(reviewId: string, status: ReviewStatus): void {
    this.db
      .prepare('UPDATE reviews SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), reviewId);
  }

  setReviewSummary(reviewId: string, body: string): void {
    this.db
      .prepare('UPDATE reviews SET summary_body = ?, updated_at = ? WHERE id = ?')
      .run(body, now(), reviewId);
  }

  /** 调整审核强度(重跑时可改档;续接与后续轮次沿用)。 */
  setReviewIntensity(reviewId: string, intensity: Review['intensity']): void {
    this.db
      .prepare('UPDATE reviews SET intensity = ?, updated_at = ? WHERE id = ?')
      .run(intensity, now(), reviewId);
  }

  // ---- diff 缓存(unified 原文;renderer 侧解析成结构化 diff 渲染)----
  setDiff(reviewId: string, raw: string): void {
    this.db
      .prepare(
        `INSERT INTO review_diffs (review_id, raw, created_at) VALUES (?, ?, ?)
         ON CONFLICT(review_id) DO UPDATE SET raw = excluded.raw, created_at = excluded.created_at`,
      )
      .run(reviewId, raw, now());
  }

  getRawDiff(reviewId: string): string | null {
    const r = this.db.prepare('SELECT raw FROM review_diffs WHERE review_id = ?').get(reviewId) as
      | { raw: string }
      | undefined;
    return r?.raw ?? null;
  }

  // ---- 轮次(首轮 + 每次重跑各一条;轮次号只增不退,失败轮次留在历史里)----

  /** 开一轮:写轮次记录并把 review 的当前轮推到该轮。round 由调用方从 currentRound+1 推得。 */
  /**
   * 开一轮。**同一轮号可重开** —— 失败的那一轮重试时沿用原轮号覆盖本行,否则「第 N 轮」
   * 会退化成重试次数。重开即把上次的失败痕迹与统计一并清零。
   */
  startRound(
    reviewId: string,
    round: number,
    input: {
      headSha?: string | null;
      note?: string | null;
      changedFiles?: readonly string[];
      codeChanged?: boolean;
    } = {},
  ): ReviewRound {
    const ts = now();
    const row: RoundRow = {
      review_id: reviewId,
      round,
      codex_thread_id: null,
      head_sha: input.headSha ?? null,
      status: 'scanning',
      note: input.note?.trim() || null,
      new_findings: 0,
      fixed_count: 0,
      suppressed_count: 0,
      error_message: null,
      error_kind: null,
      changed_files: JSON.stringify(input.changedFiles ?? []),
      code_changed: input.codeChanged ? 1 : 0,
      started_at: ts,
      ended_at: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_rounds (review_id, round, codex_thread_id, head_sha, status, note, new_findings, fixed_count, suppressed_count, error_message, error_kind, changed_files, code_changed, started_at, ended_at)
           VALUES (@review_id, @round, @codex_thread_id, @head_sha, @status, @note, @new_findings, @fixed_count, @suppressed_count, @error_message, @error_kind, @changed_files, @code_changed, @started_at, @ended_at)
           ON CONFLICT(review_id, round) DO UPDATE SET
             codex_thread_id = excluded.codex_thread_id,
             head_sha = excluded.head_sha,
             status = excluded.status,
             note = excluded.note,
             new_findings = 0, fixed_count = 0, suppressed_count = 0,
             error_message = NULL, error_kind = NULL,
             changed_files = excluded.changed_files,
             code_changed = excluded.code_changed,
             started_at = excluded.started_at,
             ended_at = NULL`,
        )
        .run(row);
      this.db
        .prepare('UPDATE reviews SET current_round = ?, updated_at = ? WHERE id = ?')
        .run(round, ts, reviewId);
    })();
    return toRound(row);
  }

  setRoundThreadId(reviewId: string, round: number, threadId: string): void {
    this.db
      .prepare('UPDATE review_rounds SET codex_thread_id = ? WHERE review_id = ? AND round = ?')
      .run(threadId, reviewId, round);
  }

  /** 收一轮:统计由调用方在轮次结束时算好一并写入;失败时连原因一起留下(UI 与重启后都靠它)。 */
  finishRound(
    reviewId: string,
    round: number,
    status: RoundStatus,
    counts: {
      newFindings?: number;
      fixedCount?: number;
      suppressedCount?: number;
      errorMessage?: string | null;
      errorKind?: AgentErrorKind | null;
    } = {},
  ): ReviewRound | null {
    this.db
      .prepare(
        `UPDATE review_rounds
            SET status = ?, ended_at = ?,
                new_findings = COALESCE(?, new_findings),
                fixed_count = COALESCE(?, fixed_count),
                suppressed_count = COALESCE(?, suppressed_count),
                error_message = ?, error_kind = ?
          WHERE review_id = ? AND round = ?`,
      )
      .run(
        status,
        now(),
        counts.newFindings ?? null,
        counts.fixedCount ?? null,
        counts.suppressedCount ?? null,
        counts.errorMessage ?? null,
        counts.errorKind ?? null,
        reviewId,
        round,
      );
    return this.getRound(reviewId, round);
  }

  /** 累加本轮被抑制的重复上报数(每次命中即时 +1,不必等收轮)。 */
  bumpSuppressed(reviewId: string, round: number): void {
    this.db
      .prepare(
        'UPDATE review_rounds SET suppressed_count = suppressed_count + 1 WHERE review_id = ? AND round = ?',
      )
      .run(reviewId, round);
  }

  getRound(reviewId: string, round: number): ReviewRound | null {
    const r = this.db
      .prepare('SELECT * FROM review_rounds WHERE review_id = ? AND round = ?')
      .get(reviewId, round) as RoundRow | undefined;
    return r ? toRound(r) : null;
  }

  listRounds(reviewId: string): ReviewRound[] {
    const rows = this.db
      .prepare('SELECT * FROM review_rounds WHERE review_id = ? ORDER BY round ASC')
      .all(reviewId) as RoundRow[];
    return rows.map(toRound);
  }

  // ---- findings(每条 finding 同时建一条 kind=finding 的 discussion 承载后续追问)----
  // id 可显式传入(用 MCP 生成的 id,使 codex 的 finding id === 存储 id,便于 update_finding)
  addFinding(
    reviewId: string,
    input: ReportFindingInput,
    origin: Finding['origin'] = 'agent',
    id: string = randomUUID(),
  ): Finding {
    const ts = now();
    const discussionId = randomUUID();
    const findingId = id;
    // 轮次由 review 当前轮推导,而非由调用方传入 —— 保证 agent / 手动 / 提升三条入口一致。
    const round = this.currentRound(reviewId);
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO discussions (id, review_id, kind, origin, file, line, line_end, created_at)
           VALUES (?, ?, 'finding', ?, ?, ?, NULL, ?)`,
        )
        .run(discussionId, reviewId, origin, input.file, input.line, ts);
      this.db
        .prepare(
          `INSERT INTO findings (id, review_id, discussion_id, origin, severity, category, title, body, file, line, suggestion, triage, dismiss_reason, submission, submitted_url, round, last_seen_round, resolution, resolution_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'unsubmitted', NULL, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          findingId,
          reviewId,
          discussionId,
          origin,
          input.severity,
          input.category ?? null,
          input.title,
          input.body ?? '',
          input.file,
          input.line,
          input.suggestion ?? null,
          round,
          round,
          ts,
          ts,
        );
    });
    insert();
    return this.getFinding(findingId)!;
  }

  /** review 当前轮次;review 不存在时按第 1 轮兜底(调用方随后自会因外键失败)。 */
  private currentRound(reviewId: string): number {
    const r = this.db.prepare('SELECT current_round FROM reviews WHERE id = ?').get(reviewId) as
      | { current_round: number }
      | undefined;
    return r?.current_round ?? 1;
  }

  getFinding(id: string): Finding | null {
    const r = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as
      | FindingRow
      | undefined;
    return r ? toFinding(r) : null;
  }

  /** 按承载 discussion 反查 finding(追问某条 finding 时定位其可编辑字段/id)。 */
  getFindingByDiscussion(discussionId: string): Finding | null {
    const r = this.db.prepare('SELECT * FROM findings WHERE discussion_id = ?').get(discussionId) as
      | FindingRow
      | undefined;
    return r ? toFinding(r) : null;
  }

  listFindings(reviewId: string): Finding[] {
    const rows = this.db
      .prepare('SELECT * FROM findings WHERE review_id = ? ORDER BY created_at ASC')
      .all(reviewId) as FindingRow[];
    return rows.map(toFinding);
  }

  /** 对话打磨后回写可编辑字段(codex update_finding 与用户就地编辑共用此路径)。 */
  updateFinding(input: UpdateFindingInput): Finding | null {
    const existing = this.getFinding(input.findingId);
    if (!existing) return null;
    const next = {
      severity: input.severity ?? existing.severity,
      category: input.category ?? existing.category,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      suggestion: input.suggestion === undefined ? existing.suggestion : input.suggestion,
    };
    this.db
      .prepare(
        `UPDATE findings SET severity = ?, category = ?, title = ?, body = ?, suggestion = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.severity, next.category, next.title, next.body, next.suggestion, now(), input.findingId);
    return this.getFinding(input.findingId);
  }

  /**
   * 用户裁决。剔除可带理由(复审时注入,让 agent 明白为何不是问题、不再报同类);
   * 恢复为 open 时理由随之清空,避免陈旧理由在下一轮误导 agent。
   */
  setTriage(findingId: string, triage: Triage, reason?: string | null): void {
    const dismissReason = triage === 'dismiss' ? (reason?.trim() || null) : null;
    this.db
      .prepare('UPDATE findings SET triage = ?, dismiss_reason = ?, updated_at = ? WHERE id = ?')
      .run(triage, dismissReason, now(), findingId);
  }

  /**
   * agent 在复审轮次对一条旧 finding 表态;同时把它标记为「本轮已看过」。
   *
   * `fixed` 顺带自动剔除:代码里已经没有的问题不该继续占着待提交清单,让用户逐条手点纯属体力活。
   * 判错了有出口 —— 卡上的「↩ 恢复」照常可用,下一轮回归重报也会自动恢复(见 isAutoClosedFixed)。
   * `wont_fix` 则不自动剔除:作者一句"可忽略"不该关掉一条真实问题,采纳与否是 reviewer 的决定。
   * 用户已自行剔除的不动,免得覆盖掉他填的理由(CASE 里读的是本行更新前的 triage)。
   */
  setFindingResolution(
    findingId: string,
    round: number,
    resolution: FindingResolution,
    note?: string | null,
  ): void {
    const autoDismiss = resolution === 'fixed' ? 1 : 0;
    this.db
      .prepare(
        `UPDATE findings
            SET resolution = ?, resolution_note = ?, last_seen_round = ?, updated_at = ?,
                triage = CASE WHEN ? = 1 AND triage = 'open' THEN 'dismiss' ELSE triage END,
                dismiss_reason = CASE WHEN ? = 1 AND triage = 'open' THEN ? ELSE dismiss_reason END
          WHERE id = ?`,
      )
      .run(
        resolution,
        note?.trim() || null,
        round,
        now(),
        autoDismiss,
        autoDismiss,
        `第 ${round} 轮复核判定已修复`,
        findingId,
      );
  }

  /**
   * 兜底去重命中已有 finding 时调用:等价于 agent 表态「仍存在」,但不覆盖已有的 resolution note。
   * 只前推 last_seen_round,不回退(同一轮多次命中幂等)。
   */
  touchFindingSeen(findingId: string, round: number): void {
    this.db
      .prepare(
        `UPDATE findings SET last_seen_round = ?, resolution = 'still_present', updated_at = ?
         WHERE id = ? AND last_seen_round < ?`,
      )
      .run(round, now(), findingId, round);
  }

  setSubmission(findingId: string, submission: Submission, url: string | null = null): void {
    this.db
      .prepare('UPDATE findings SET submission = ?, submitted_url = ?, updated_at = ? WHERE id = ?')
      .run(submission, url, now(), findingId);
  }

  /** 改锚点行(提交屏修锚点 / 降级为摘要):line=0 表示脱锚,归入 review 摘要。 */
  setFindingAnchor(findingId: string, line: number): void {
    this.db
      .prepare('UPDATE findings SET line = ?, updated_at = ? WHERE id = ?')
      .run(line, now(), findingId);
  }

  // ---- discussions / messages ----
  addUserDiscussion(
    reviewId: string,
    anchor: { file: string; line: number; lineEnd?: number | null },
  ): Discussion {
    const ts = now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO discussions (id, review_id, kind, origin, file, line, line_end, created_at)
         VALUES (?, ?, 'user', 'manual', ?, ?, ?, ?)`,
      )
      .run(id, reviewId, anchor.file, anchor.line, anchor.lineEnd ?? null, ts);
    return {
      id,
      reviewId,
      kind: 'user',
      origin: 'manual',
      file: anchor.file,
      line: anchor.line,
      lineEnd: anchor.lineEnd ?? null,
      createdAt: ts,
    };
  }

  /** 把一条 user discussion 提升为 finding:翻转 kind/origin 并建 finding,保留原会话历史。 */
  promoteDiscussion(
    discussionId: string,
    input: {
      severity: Finding['severity'];
      category?: string | null;
      title: string;
      body?: string;
      suggestion?: string | null;
    },
  ): Finding {
    const disc = this.getDiscussion(discussionId);
    if (!disc) throw new Error(`discussion 不存在: ${discussionId}`);
    if (disc.kind === 'finding') throw new Error('该 discussion 已是 finding');
    if (!disc.file || disc.line == null) throw new Error('无代码锚点的 discussion 不能提升为 finding');
    const ts = now();
    const findingId = randomUUID();
    const round = this.currentRound(disc.reviewId);
    const run = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE discussions SET kind = 'finding', origin = 'promoted' WHERE id = ?`)
        .run(discussionId);
      this.db
        .prepare(
          `INSERT INTO findings (id, review_id, discussion_id, origin, severity, category, title, body, file, line, suggestion, triage, dismiss_reason, submission, submitted_url, round, last_seen_round, resolution, resolution_note, created_at, updated_at)
           VALUES (?, ?, ?, 'promoted', ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'unsubmitted', NULL, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          findingId,
          disc.reviewId,
          discussionId,
          input.severity,
          input.category ?? null,
          input.title,
          input.body ?? '',
          disc.file,
          disc.line,
          input.suggestion ?? null,
          round,
          round,
          ts,
          ts,
        );
    });
    run();
    return this.getFinding(findingId)!;
  }

  getDiscussion(id: string): Discussion | null {
    const r = this.db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as
      | DiscussionRow
      | undefined;
    return r ? toDiscussion(r) : null;
  }

  listDiscussions(reviewId: string): Discussion[] {
    const rows = this.db
      .prepare('SELECT * FROM discussions WHERE review_id = ? ORDER BY created_at ASC')
      .all(reviewId) as DiscussionRow[];
    return rows.map(toDiscussion);
  }

  addMessage(discussionId: string, role: MessageRole, text: string): Message {
    const ts = now();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, discussion_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, discussionId, role, text, ts);
    return { id, discussionId, role, text, createdAt: ts };
  }

  listMessages(discussionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE discussion_id = ? ORDER BY created_at ASC')
      .all(discussionId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** 清空一条 discussion 的往来消息(discussion / finding 锚点保留),用于重开讨论。 */
  clearMessages(discussionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE discussion_id = ?').run(discussionId);
  }

  // ---- UI 状态 ----
  getUiSettings(): UiSettings {
    const r = this.db.prepare('SELECT * FROM ui_settings WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!r) return { ...DEFAULT_UI_SETTINGS };
    return {
      dataMode: r.data_mode as UiSettings['dataMode'],
      dataTheme: r.data_theme as UiSettings['dataTheme'],
      leftWidth: r.left_width as number,
      rightWidth: r.right_width as number,
      defaultTab: r.default_tab as UiSettings['defaultTab'],
      defaultDiffView: r.default_diff_view as UiSettings['defaultDiffView'],
      defaultSource: (r.default_source as UiSettings['defaultSource'] | null) ?? DEFAULT_UI_SETTINGS.defaultSource,
      lastRepoPath: (r.last_repo_path as string | null) ?? DEFAULT_UI_SETTINGS.lastRepoPath,
      findingsGrouping:
        (r.findings_grouping as UiSettings['findingsGrouping'] | null) ?? DEFAULT_UI_SETTINGS.findingsGrouping,
      collapseViewedFiles:
        r.collapse_viewed == null ? DEFAULT_UI_SETTINGS.collapseViewedFiles : !!r.collapse_viewed,
      defaultModel: (r.default_model as string | null) ?? DEFAULT_UI_SETTINGS.defaultModel,
      defaultEffort: (r.default_effort as UiSettings['defaultEffort'] | null) ?? DEFAULT_UI_SETTINGS.defaultEffort,
      defaultIntensity:
        (r.default_intensity as UiSettings['defaultIntensity'] | null) ?? DEFAULT_UI_SETTINGS.defaultIntensity,
      notifyOnComplete:
        r.notify_on_complete == null ? DEFAULT_UI_SETTINGS.notifyOnComplete : !!r.notify_on_complete,
      codexPath: (r.codex_path as string | null) ?? DEFAULT_UI_SETTINGS.codexPath,
      ghPath: (r.gh_path as string | null) ?? DEFAULT_UI_SETTINGS.ghPath,
    };
  }

  saveUiSettings(s: UiSettings): void {
    this.db
      .prepare(
        `INSERT INTO ui_settings (id, data_mode, data_theme, left_width, right_width, default_tab, default_diff_view, default_source, last_repo_path, findings_grouping, collapse_viewed, default_model, default_effort, default_intensity, notify_on_complete, codex_path, gh_path)
         VALUES (1, @dataMode, @dataTheme, @leftWidth, @rightWidth, @defaultTab, @defaultDiffView, @defaultSource, @lastRepoPath, @findingsGrouping, @collapseViewedFiles, @defaultModel, @defaultEffort, @defaultIntensity, @notifyOnComplete, @codexPath, @ghPath)
         ON CONFLICT(id) DO UPDATE SET
           data_mode = @dataMode, data_theme = @dataTheme, left_width = @leftWidth,
           right_width = @rightWidth, default_tab = @defaultTab, default_diff_view = @defaultDiffView,
           default_source = @defaultSource, last_repo_path = @lastRepoPath,
           findings_grouping = @findingsGrouping, collapse_viewed = @collapseViewedFiles,
           default_model = @defaultModel, default_effort = @defaultEffort, default_intensity = @defaultIntensity,
           notify_on_complete = @notifyOnComplete, codex_path = @codexPath, gh_path = @ghPath`,
      )
      // SQLite 不能绑定 boolean:布尔字段转 0/1
      .run({
        ...s,
        collapseViewedFiles: s.collapseViewedFiles ? 1 : 0,
        notifyOnComplete: s.notifyOnComplete ? 1 : 0,
      });
  }

  getReviewUiState(reviewId: string): ReviewUiState {
    const r = this.db
      .prepare('SELECT viewed_files, last_active_tab FROM review_ui_state WHERE review_id = ?')
      .get(reviewId) as { viewed_files: string; last_active_tab: string | null } | undefined;
    if (!r) return { ...DEFAULT_REVIEW_UI_STATE };
    let viewedFiles: string[] = [];
    try {
      const parsed = JSON.parse(r.viewed_files);
      if (Array.isArray(parsed)) viewedFiles = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // 落库 JSON 损坏 → 降级为空进度,不阻断
    }
    return { viewedFiles, lastActiveTab: r.last_active_tab };
  }

  saveReviewUiState(reviewId: string, state: ReviewUiState): void {
    this.db
      .prepare(
        `INSERT INTO review_ui_state (review_id, viewed_files, last_active_tab)
         VALUES (@reviewId, @viewedFiles, @lastActiveTab)
         ON CONFLICT(review_id) DO UPDATE SET
           viewed_files = @viewedFiles, last_active_tab = @lastActiveTab`,
      )
      .run({
        reviewId,
        viewedFiles: JSON.stringify(state.viewedFiles),
        lastActiveTab: state.lastActiveTab ?? null,
      });
  }
}
