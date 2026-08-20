import { randomUUID } from 'node:crypto';
import type { AgentErrorKind } from '@shared/agent-events';
import type { RecentReview } from '@shared/ipc';
import type { DB } from './database';
import {
  DEFAULT_UI_SETTINGS,
  isAutoClosedFixed,
  isStillPresent,
  summaryFileSchema,
  SUMMARY_FILES_LIMIT,
  type Discussion,
  type Finding,
  type FindingProposal,
  type FindingResolution,
  type FindingVerdict,
  type Message,
  type MessageRole,
  type ProposalBefore,
  type ProposalKind,
  type ProposalPatch,
  type ProposalStatus,
  type ProposalUpdateBefore,
  type ReportFindingInput,
  DEFAULT_REVIEW_UI_STATE,
  type Review,
  type ReviewRound,
  type ReviewStatus,
  type ReviewUiState,
  type RoundStatus,
  type SourceKind,
  type Submission,
  type TurnKind,
  type SummaryFile,
  type Triage,
  type UiSettings,
  type UpdateFindingInput,
} from '@shared/domain';

const now = () => Date.now();

/** 复核判定已修复时自动写下的剔除理由(结案来源记在 auto_closed,这里只是给人看的文案)。 */
const AUTO_CLOSE_REASON = (round: number): string => `第 ${round} 轮复核判定已修复`;

interface ReviewRow {
  id: string;
  source: string;
  source_ref: string;
  base_ref: string | null;
  repo_path: string | null;
  codex_thread_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  intensity: string;
  title: string | null;
  status: string;
  summary_body: string | null;
  summary_files: string;
  summary_round: number | null;
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
  anchor_dropped: number;
  suggestion: string | null;
  triage: string;
  dismiss_reason: string | null;
  submission: string;
  submitted_url: string | null;
  submitted_round: number | null;
  round: number;
  body_round: number | null;
  last_seen_round: number;
  resolution: string | null;
  resolution_note: string | null;
  auto_closed: number;
  origin_turn: string | null;
  verdict: string | null;
  verdict_note: string | null;
  verdict_turn: string | null;
  verdict_round: number | null;
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

interface ProposalRow {
  id: string;
  review_id: string;
  discussion_id: string;
  message_id: string | null;
  finding_id: string | null;
  kind: string;
  patch: string;
  before_snapshot: string | null;
  base_updated_at: number | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

function toReview(r: ReviewRow): Review {
  return {
    id: r.id,
    source: r.source as SourceKind,
    sourceRef: r.source_ref,
    baseRef: r.base_ref,
    repoPath: r.repo_path,
    codexThreadId: r.codex_thread_id,
    model: r.model,
    reasoningEffort: r.reasoning_effort as Review['reasoningEffort'],
    intensity: r.intensity as Review['intensity'],
    title: r.title,
    status: r.status as ReviewStatus,
    summaryBody: r.summary_body,
    summaryFiles: parseSummaryFiles(r.summary_files),
    summaryRound: r.summary_round,
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

/** 同 parseChangedFiles:坏值退化成空列表,不让一列脏 JSON 把整个 review 读不出来。 */
function parseSummaryFiles(raw: string): SummaryFile[] {
  try {
    const v: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      const parsed = summaryFileSchema.safeParse(x);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
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
    anchorDropped: r.anchor_dropped === 1,
    suggestion: r.suggestion,
    triage: (r.triage === 'keep' ? 'open' : r.triage) as Triage,
    dismissReason: r.dismiss_reason,
    submission: r.submission as Submission,
    submittedUrl: r.submitted_url,
    submittedRound: r.submitted_round,
    round: r.round,
    // 没改写过就是首报时那份;新建路径不必逐个填这一列
    bodyRound: r.body_round ?? r.round,
    lastSeenRound: r.last_seen_round,
    resolution: r.resolution as FindingResolution | null,
    resolutionNote: r.resolution_note,
    autoClosed: r.auto_closed === 1,
    originTurn: r.origin_turn as TurnKind | null,
    verdict: r.verdict as FindingVerdict | null,
    verdictNote: r.verdict_note,
    verdictTurn: r.verdict_turn as TurnKind | null,
    verdictRound: r.verdict_round,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 提案行 → 领域对象。patch / before 是 JSON 列:坏值不能让整条讨论读不出来,
 * 故解析失败退化成空 patch(UI 会把它显示成没有改动的提案),而不是抛。
 */
function toProposal(r: ProposalRow): FindingProposal {
  const parse = <T>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  return {
    id: r.id,
    reviewId: r.review_id,
    discussionId: r.discussion_id,
    messageId: r.message_id,
    findingId: r.finding_id,
    kind: r.kind,
    patch: parse<ProposalPatch>(r.patch) ?? {},
    before: parse<ProposalBefore>(r.before_snapshot),
    baseUpdatedAt: r.base_updated_at,
    status: r.status as ProposalStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  } as FindingProposal;
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
 * 前端不本地臆造权威数据,一律经此落库后回推(见 docs/design/architecture.md 状态分层)。
 */
export class ReviewStore {
  constructor(private readonly db: DB) {}

  // ---- reviews ----
  createReview(input: {
    source: SourceKind;
    sourceRef: string;
    baseRef?: string | null;
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
      base_ref: input.baseRef ?? null,
      repo_path: input.repoPath ?? null,
      codex_thread_id: null,
      model: input.model ?? null,
      reasoning_effort: input.reasoningEffort ?? null,
      intensity: input.intensity ?? 'standard',
      title: input.title ?? null,
      status: 'scanning',
      summary_body: null,
      summary_files: '[]',
      summary_round: null,
      current_round: 1,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO reviews (id, source, source_ref, base_ref, repo_path, codex_thread_id, model, reasoning_effort, intensity, title, status, summary_body, summary_files, summary_round, current_round, created_at, updated_at)
         VALUES (@id, @source, @source_ref, @base_ref, @repo_path, @codex_thread_id, @model, @reasoning_effort, @intensity, @title, @status, @summary_body, @summary_files, @summary_round, @current_round, @created_at, @updated_at)`,
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

  /** 按最后更新时间删除过期审核(级联同 deleteReview);返回删掉的条数。 */
  pruneReviewsBefore(cutoff: number): number {
    return this.db.prepare('DELETE FROM reviews WHERE updated_at < ?').run(cutoff).changes;
  }

  /** 把父 review 的 updated_at 推到 ts;调用方须已在事务内(见 withReviewTouch)。 */
  private touchReview(reviewId: string, ts: number): void {
    this.db.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(ts, reviewId);
  }

  /**
   * 子表写入 + 父 review 的 updated_at 冒泡,同一事务内完成。
   *
   * 保留窗口与历史排序都只读 `reviews.updated_at`,而消息/finding 写的是子表 ——
   * 不冒泡的话,一条昨天刚被追问过的旧审核会因为「最后一次改状态」在 30 天前而被清掉。
   */
  private withReviewTouch<T>(
    scope: { review: string } | { finding: string } | { discussion: string },
    write: (ts: number) => T,
  ): T {
    const ts = now();
    return this.db.transaction(() => {
      const written = write(ts);
      if ('review' in scope) this.touchReview(scope.review, ts);
      else if ('finding' in scope)
        this.db
          .prepare('UPDATE reviews SET updated_at = ? WHERE id = (SELECT review_id FROM findings WHERE id = ?)')
          .run(ts, scope.finding);
      else
        this.db
          .prepare('UPDATE reviews SET updated_at = ? WHERE id = (SELECT review_id FROM discussions WHERE id = ?)')
          .run(ts, scope.discussion);
      return written;
    })();
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

  /**
   * agent 经 write_summary 回写:正文与重点文件同一次落库,两者本就是一次收尾的两半。
   * 总结没有人工编辑入口,故这是它唯一的写入者 —— summary_round 就地取 current_round
   * (同一条 UPDATE 内,不经应用层往返),之后靠它判断屏上这份是不是本轮的结论。
   */
  writeAgentSummary(reviewId: string, body: string, files: readonly SummaryFile[]): void {
    this.db
      .prepare(
        'UPDATE reviews SET summary_body = ?, summary_files = ?, summary_round = current_round, updated_at = ? WHERE id = ?',
      )
      .run(body, JSON.stringify(files.slice(0, SUMMARY_FILES_LIMIT)), now(), reviewId);
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
    /** 报出它的 turn 类型;只有 agent 上报路径给得出,手动/提升留 null(origin 列已区分那两者) */
    originTurn: TurnKind | null = null,
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
          `INSERT INTO findings (id, review_id, discussion_id, origin, severity, category, title, body, file, line, suggestion, triage, dismiss_reason, submission, submitted_url, round, last_seen_round, resolution, resolution_note, origin_turn, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'unsubmitted', NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
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
          originTurn,
          ts,
          ts,
        );
      this.touchReview(reviewId, ts);
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

  /**
   * 对话打磨后回写可编辑字段(codex update_finding 与用户就地编辑共用此路径)。
   *
   * 本轮判定「仍存在」的条目一旦被改写正文,旧的复核说明与旧 suggestion 一并作废:两者都写在
   * 这份正文之前,而提交/导出时复核说明取代正文发出去(见 findingNarrative)。留着的话,屏上
   * 写着新结论、发出去的却是旧那条;那份补丁更是照着作者已经改过的代码写的,一键采纳就覆盖回去。
   * 例外是这次更新自带的新 suggestion —— 那才是看过复核之后给的。
   *
   * 判据取「本轮判定仍存在」而非「有没有复核说明」:去重兜底命中的条目同样是本轮仍存在,只是
   * 没附说明(见 touchFindingSeen),按说明问会漏掉它,把首轮补丁留到追评里发出去。
   *
   * 只认正文:改严重度 / 换分类 / 单调补丁都不动它 —— 说的仍是同一条问题。
   * 空正文也不算改写:它取代不了任何东西,清掉只会让这条 finding 什么说明都不剩。
   */
  updateFinding(input: UpdateFindingInput): Finding | null {
    const existing = this.getFinding(input.findingId);
    if (!existing) return null;
    const next = {
      severity: input.severity ?? existing.severity,
      category: input.category === undefined ? existing.category : input.category,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      suggestion: input.suggestion === undefined ? existing.suggestion : input.suggestion,
    };
    const round = this.currentRound(existing.reviewId);
    const rewritten = next.body.trim() !== '' && next.body !== existing.body;
    const supersedesRecheck = rewritten && isStillPresent(existing, round);
    const resolutionNote = supersedesRecheck ? null : existing.resolutionNote;
    const suggestion =
      supersedesRecheck && input.suggestion === undefined ? null : next.suggestion;
    // 正文一改,自检判据针对的东西就没了 —— 留着会让一段说着旧正文的判据挂在新正文旁边。
    // 与上面 resolutionNote 被作废是同一条规矩:改写即作废,不猜它是否仍然成立。
    const keepVerdict = !rewritten;
    this.withReviewTouch({ finding: input.findingId }, (ts) => {
      this.db
        .prepare(
          `UPDATE findings
              SET severity = ?, category = ?, title = ?, body = ?, suggestion = ?,
                  resolution_note = ?, body_round = ?,
                  verdict = ?, verdict_note = ?, verdict_turn = ?, verdict_round = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          next.severity,
          next.category,
          next.title,
          next.body,
          suggestion,
          resolutionNote,
          rewritten ? round : existing.bodyRound,
          keepVerdict ? existing.verdict : null,
          keepVerdict ? existing.verdictNote : null,
          keepVerdict ? existing.verdictTurn : null,
          keepVerdict ? existing.verdictRound : null,
          ts,
          input.findingId,
        );
    });
    return this.getFinding(input.findingId);
  }

  /**
   * 记下自检轮对一条 finding 的裁决。**只写这三列**,刻意不走 {@link updateFinding} ——
   * 裁决是标注不是动作:不动 severity(机器降档等于软剔除)、不动 triage(剔除权在 reviewer)、
   * 也不碰 body_round(它没有给作者新写一句话,不该据此追发评论)。
   *
   * 同一条被反复裁决时后写覆盖先写:一轮内 agent 改主意了,留最后那次即可。
   */
  setFindingVerdict(
    findingId: string,
    verdict: FindingVerdict,
    note: string | null,
    turn: TurnKind,
  ): Finding | null {
    const existing = this.getFinding(findingId);
    if (!existing) return null;
    const round = this.currentRound(existing.reviewId);
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(
          `UPDATE findings
              SET verdict = ?, verdict_note = ?, verdict_turn = ?, verdict_round = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(verdict, note, turn, round, ts, findingId);
    });
    return this.getFinding(findingId);
  }

  /**
   * 提案撤销专用:把旧值快照**逐字**写回,不走 {@link updateFinding} 的派生规则。
   *
   * 撤销是回滚,不是一次新表态。借 updateFinding 写回旧正文的话,那条规则会把这次回滚当成
   * 「改写正文」重算一遍:应用之后新写下的复核说明会被它一并清掉,而快照里没有那份新值,
   * 补都补不回来。这里只碰快照点名的列 —— 应用没动过的字段,撤销就不该碰。
   */
  restoreFinding(findingId: string, before: ProposalUpdateBefore): void {
    const COLUMNS: Record<keyof ProposalUpdateBefore, string> = {
      severity: 'severity',
      category: 'category',
      title: 'title',
      body: 'body',
      suggestion: 'suggestion',
      resolutionNote: 'resolution_note',
      bodyRound: 'body_round',
    };
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(COLUMNS) as [keyof ProposalUpdateBefore, string][]) {
      const value = before[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(value);
    }
    if (!sets.length) return;
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(`UPDATE findings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...args, ts, findingId);
    });
  }

  /**
   * 用户裁决。剔除可带理由(复审时注入,让 agent 明白为何不是问题、不再报同类);
   * 恢复为 open 时理由随之清空,避免陈旧理由在下一轮误导 agent。
   *
   * 一经手动裁决就不再是自动结案:reviewer 恢复后重新剔除的,是他自己的决定,
   * 下一轮复核说「仍存在」也不该把它翻回保留(见 setFindingResolution 的恢复分支)。
   */
  setTriage(findingId: string, triage: Triage, reason?: string | null): void {
    const dismissReason = triage === 'dismiss' ? (reason?.trim() || null) : null;
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(
          'UPDATE findings SET triage = ?, dismiss_reason = ?, auto_closed = 0, updated_at = ? WHERE id = ?',
        )
        .run(triage, dismissReason, ts, findingId);
    });
  }

  /**
   * agent 在复审轮次对一条旧 finding 表态;同时把它标记为「本轮已看过」。
   *
   * `fixed` 顺带自动剔除:代码里已经没有的问题不该继续占着待提交清单,让用户逐条手点纯属体力活。
   * 判错了有出口 —— 卡上的「↩ 恢复」照常可用,下一轮回归重报也会自动恢复(见 isAutoClosedFixed)。
   * `wont_fix` 则不自动剔除:作者一句"可忽略"不该关掉一条真实问题,采纳与否是 reviewer 的决定。
   *
   * 反向也要走通:自动结案的条目在后续轮次被判「仍存在 / 作者已回应」时立即恢复保留 ——
   * 结案的前提("代码里已经没有了")已被本轮推翻,继续挂着剔除等于把回归悄悄咽掉。
   * 重报走 report_finding 的回归路径由 ReviewSession.absorbDuplicate 兜底,这里管的是 agent
   * 直接对旧 id 表态的那条路。
   *
   * 恢复只认落库的 auto_closed,不能用「剔除 + fixed」去推 —— reviewer 亲自剔除过的条目照样
   * 可能挂着 fixed(他先剔除、agent 之后才表态;或结案后他「↩ 恢复」再重新剔除),
   * 那是他的判断,不该被下一轮的表态推翻。
   */
  setFindingResolution(
    findingId: string,
    round: number,
    resolution: FindingResolution,
    note?: string | null,
  ): void {
    const prior = this.getFinding(findingId);
    if (!prior) return;
    const autoDismiss = resolution === 'fixed' && prior.triage === 'open';
    const restore = resolution !== 'fixed' && isAutoClosedFixed(prior);
    const triage: Triage = autoDismiss ? 'dismiss' : restore ? 'open' : prior.triage;
    const dismissReason = autoDismiss
      ? AUTO_CLOSE_REASON(round)
      : restore
        ? null
        : prior.dismissReason;
    const autoClosed = autoDismiss ? 1 : restore ? 0 : Number(prior.autoClosed);
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(
          `UPDATE findings
              SET resolution = ?, resolution_note = ?, last_seen_round = ?, updated_at = ?,
                  triage = ?, dismiss_reason = ?, auto_closed = ?
            WHERE id = ?`,
        )
        .run(resolution, note?.trim() || null, round, ts, triage, dismissReason, autoClosed, findingId);
    });
  }

  /**
   * 兜底去重命中已有 finding 时调用:等价于 agent 表态「仍存在」,但这次表态没有附说明。
   * 只前推 last_seen_round,不回退(同一轮多次命中幂等,故同轮里已填的说明不会被这里抹掉)。
   *
   * 跨轮推进时必须清空 resolution_note:说明属于写下它的那一轮,留着会被下游(UI 的本轮结论、
   * 提交/导出的正文主体、复核追评)当成本轮新说明,把上一轮的话重新发给 author。
   */
  touchFindingSeen(findingId: string, round: number): void {
    this.db
      .prepare(
        `UPDATE findings
            SET last_seen_round = ?, resolution = 'still_present', resolution_note = NULL, updated_at = ?
          WHERE id = ? AND last_seen_round < ?`,
      )
      .run(round, now(), findingId, round);
  }

  /** round 记下这次提交发生在第几轮:之后的轮次复核仍存在时,据此判断是否还欠一条追评。 */
  setSubmission(
    findingId: string,
    submission: Submission,
    url: string | null = null,
    round: number | null = null,
  ): void {
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(
          `UPDATE findings SET submission = ?, submitted_url = ?, submitted_round = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(submission, url, submission === 'submitted' ? round : null, ts, findingId);
    });
  }

  /**
   * 改锚点行(提交屏修锚点 / 降级为摘要):line=0 表示脱锚,归入 review 摘要。
   * 脱锚只置 anchor_dropped,原行号照留 —— 摘要条目要写出 file:line,且据此可改回行评论。
   */
  setFindingAnchor(findingId: string, line: number): void {
    this.withReviewTouch({ finding: findingId }, (ts) => {
      if (line > 0) {
        this.db
          .prepare('UPDATE findings SET line = ?, anchor_dropped = 0, updated_at = ? WHERE id = ?')
          .run(line, ts, findingId);
        return;
      }
      this.db
        .prepare('UPDATE findings SET anchor_dropped = 1, updated_at = ? WHERE id = ?')
        .run(ts, findingId);
    });
  }

  // ---- discussions / messages ----
  /** anchor 为空 = 不锚定任何代码的全局讨论(问架构 / 问整体,后续也可补锚点提升为 finding)。 */
  addUserDiscussion(
    reviewId: string,
    anchor?: { file: string; line: number; lineEnd?: number | null } | null,
  ): Discussion {
    const id = randomUUID();
    const ts = this.withReviewTouch({ review: reviewId }, (writeTs) => {
      this.db
        .prepare(
          `INSERT INTO discussions (id, review_id, kind, origin, file, line, line_end, created_at)
           VALUES (?, ?, 'user', 'manual', ?, ?, ?, ?)`,
        )
        .run(id, reviewId, anchor?.file ?? null, anchor?.line ?? null, anchor?.lineEnd ?? null, writeTs);
      return writeTs;
    });
    return {
      id,
      reviewId,
      kind: 'user',
      origin: 'manual',
      file: anchor?.file ?? null,
      line: anchor?.line ?? null,
      lineEnd: anchor?.lineEnd ?? null,
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
      this.touchReview(disc.reviewId, ts);
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
    const id = randomUUID();
    const ts = this.withReviewTouch({ discussion: discussionId }, (writeTs) => {
      this.db
        .prepare('INSERT INTO messages (id, discussion_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, discussionId, role, text, writeTs);
      return writeTs;
    });
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
    this.withReviewTouch({ discussion: discussionId }, () => {
      this.db.prepare('DELETE FROM messages WHERE discussion_id = ?').run(discussionId);
    });
  }

  /**
   * 把一组写操作收进同一个数据库事务(better-sqlite3 同步执行,故直接传同步闭包)。
   * 内层的 {@link withReviewTouch} 会以 savepoint 嵌套,不会互相冲突。
   *
   * 给编排层用:提案的采纳既要改 finding 又要改提案自己,分两次提交的话,
   * 第二步一挂就留下「finding 已改、卡片还写着待确认」的半状态。
   */
  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }

  // ---- 回写提案(讨论里 agent 提出、reviewer 确认后才落库)----

  /**
   * 记一条待确认提案。message_id 此刻还没有(agent 的回复要等 turn 收尾才落库),
   * 由 {@link attachProposalsToMessage} 补上。
   */
  addProposal(input: {
    reviewId: string;
    discussionId: string;
    findingId: string | null;
    kind: ProposalKind;
    patch: ProposalPatch;
    baseUpdatedAt: number | null;
  }): FindingProposal {
    const id = randomUUID();
    this.withReviewTouch({ discussion: input.discussionId }, (ts) => {
      this.db
        .prepare(
          `INSERT INTO finding_proposals (id, review_id, discussion_id, message_id, finding_id, kind, patch, before_snapshot, base_updated_at, status, created_at, resolved_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'pending', ?, NULL)`,
        )
        .run(
          id,
          input.reviewId,
          input.discussionId,
          input.findingId,
          input.kind,
          JSON.stringify(input.patch),
          input.baseUpdatedAt,
          ts,
        );
    });
    return this.getProposal(id)!;
  }

  getProposal(id: string): FindingProposal | null {
    const r = this.db.prepare('SELECT * FROM finding_proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
    return r ? toProposal(r) : null;
  }

  listProposals(reviewId: string): FindingProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM finding_proposals WHERE review_id = ? ORDER BY created_at ASC')
      .all(reviewId) as ProposalRow[];
    return rows.map(toProposal);
  }

  /**
   * 把本轮新记的提案挂到刚落库的 agent 回复上。
   * 提案先于回复文本产生(工具调用在前),不回挂的话它们会排在解释它们的那句话**上面**。
   */
  attachProposalsToMessage(ids: readonly string[], messageId: string): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE finding_proposals SET message_id = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) stmt.run(messageId, id);
    })();
  }

  /**
   * 落定一条提案的去向;applied 时连同旧值快照一起记下,供撤销还原。
   *
   * 同样要冒泡 review 的 updated_at:「忽略提案」不伴随任何 finding 写入,不冒泡的话,
   * 一条刚被处置过的 review 在历史里仍顶着旧时间排序,并可能按旧时间进 30 天清理。
   */
  setProposalStatus(
    id: string,
    status: ProposalStatus,
    opts: { before?: ProposalBefore | null; findingId?: string } = {},
  ): FindingProposal | null {
    const existing = this.getProposal(id);
    if (!existing) return null;
    this.withReviewTouch({ discussion: existing.discussionId }, (ts) => {
      this.db
        .prepare(
          `UPDATE finding_proposals
              SET status = ?, resolved_at = ?,
                  before_snapshot = COALESCE(?, before_snapshot),
                  finding_id = COALESCE(?, finding_id)
            WHERE id = ?`,
        )
        .run(
          status,
          status === 'pending' ? null : ts,
          opts.before == null ? null : JSON.stringify(opts.before),
          opts.findingId ?? null,
          id,
        );
    });
    return this.getProposal(id);
  }

  /**
   * 原样还原一条 finding 的裁决态(撤销 dismiss/restore 提案用)。
   *
   * 不能用 {@link setTriage} 顶替:它会把 auto_closed 一律清零(手动裁决就该如此),
   * 于是复核自动结案的条目撤销后会变成「reviewer 亲手剔的」,下一轮回归不再自动恢复
   * (见 {@link isAutoClosedFixed}),真问题就此被一直抑制下去。
   */
  restoreTriage(
    findingId: string,
    snapshot: { triage: Triage; dismissReason: string | null; autoClosed: boolean },
  ): void {
    this.withReviewTouch({ finding: findingId }, (ts) => {
      this.db
        .prepare(
          'UPDATE findings SET triage = ?, dismiss_reason = ?, auto_closed = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          snapshot.triage,
          snapshot.dismissReason,
          Number(snapshot.autoClosed),
          ts,
          findingId,
        );
    });
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
      fileListView: (r.file_list_view as UiSettings['fileListView'] | null) ?? DEFAULT_UI_SETTINGS.fileListView,
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
        `INSERT INTO ui_settings (id, data_mode, data_theme, left_width, right_width, default_tab, default_diff_view, file_list_view, default_source, last_repo_path, findings_grouping, collapse_viewed, default_model, default_effort, default_intensity, notify_on_complete, codex_path, gh_path)
         VALUES (1, @dataMode, @dataTheme, @leftWidth, @rightWidth, @defaultTab, @defaultDiffView, @fileListView, @defaultSource, @lastRepoPath, @findingsGrouping, @collapseViewedFiles, @defaultModel, @defaultEffort, @defaultIntensity, @notifyOnComplete, @codexPath, @ghPath)
         ON CONFLICT(id) DO UPDATE SET
           data_mode = @dataMode, data_theme = @dataTheme, left_width = @leftWidth,
           right_width = @rightWidth, default_tab = @defaultTab, default_diff_view = @defaultDiffView,
           file_list_view = @fileListView,
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
