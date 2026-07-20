import { randomUUID } from 'node:crypto';
import type { DB } from './database';
import {
  DEFAULT_UI_SETTINGS,
  type Discussion,
  type Finding,
  type Message,
  type MessageRole,
  type ReportFindingInput,
  type Review,
  type ReviewStatus,
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
  title: string | null;
  status: string;
  summary_body: string | null;
  created_at: number;
  updated_at: number;
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
  submission: string;
  submitted_url: string | null;
  created_at: number;
  updated_at: number;
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
    title: r.title,
    status: r.status as ReviewStatus,
    summaryBody: r.summary_body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
    triage: r.triage as Triage,
    submission: r.submission as Submission,
    submittedUrl: r.submitted_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
  }): Review {
    const ts = now();
    const row: ReviewRow = {
      id: randomUUID(),
      source: input.source,
      source_ref: input.sourceRef,
      repo_path: input.repoPath ?? null,
      codex_thread_id: null,
      title: input.title ?? null,
      status: 'scanning',
      summary_body: null,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO reviews (id, source, source_ref, repo_path, codex_thread_id, title, status, summary_body, created_at, updated_at)
         VALUES (@id, @source, @source_ref, @repo_path, @codex_thread_id, @title, @status, @summary_body, @created_at, @updated_at)`,
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

  setCodexThreadId(reviewId: string, threadId: string): void {
    this.db
      .prepare('UPDATE reviews SET codex_thread_id = ?, updated_at = ? WHERE id = ?')
      .run(threadId, now(), reviewId);
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
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO discussions (id, review_id, kind, origin, file, line, line_end, created_at)
           VALUES (?, ?, 'finding', ?, ?, ?, NULL, ?)`,
        )
        .run(discussionId, reviewId, origin, input.file, input.line, ts);
      this.db
        .prepare(
          `INSERT INTO findings (id, review_id, discussion_id, origin, severity, category, title, body, file, line, suggestion, triage, submission, submitted_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'unsubmitted', NULL, ?, ?)`,
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
          ts,
          ts,
        );
    });
    insert();
    return this.getFinding(findingId)!;
  }

  getFinding(id: string): Finding | null {
    const r = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as
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

  setTriage(findingId: string, triage: Triage): void {
    this.db
      .prepare('UPDATE findings SET triage = ?, updated_at = ? WHERE id = ?')
      .run(triage, now(), findingId);
  }

  setSubmission(findingId: string, submission: Submission, url: string | null = null): void {
    this.db
      .prepare('UPDATE findings SET submission = ?, submitted_url = ?, updated_at = ? WHERE id = ?')
      .run(submission, url, now(), findingId);
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
    };
  }

  saveUiSettings(s: UiSettings): void {
    this.db
      .prepare(
        `INSERT INTO ui_settings (id, data_mode, data_theme, left_width, right_width, default_tab, default_diff_view)
         VALUES (1, @dataMode, @dataTheme, @leftWidth, @rightWidth, @defaultTab, @defaultDiffView)
         ON CONFLICT(id) DO UPDATE SET
           data_mode = @dataMode, data_theme = @dataTheme, left_width = @leftWidth,
           right_width = @rightWidth, default_tab = @defaultTab, default_diff_view = @defaultDiffView`,
      )
      .run(s);
  }
}
