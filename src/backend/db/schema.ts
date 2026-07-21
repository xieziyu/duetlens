/**
 * SQLite schema 迁移。用 `PRAGMA user_version` 记录版本,顺序应用。
 * 新增变更 = 往 MIGRATIONS 追加一条,勿改历史条目。
 */
import type { Database } from 'better-sqlite3';

const V1 = `
CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  repo_path     TEXT,
  codex_thread_id TEXT,
  title         TEXT,
  status        TEXT NOT NULL,
  summary_body  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE discussions (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  origin      TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  line_end    INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_discussions_review ON discussions(review_id);

CREATE TABLE findings (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL,
  severity      TEXT NOT NULL,
  category      TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  file          TEXT NOT NULL,
  line          INTEGER NOT NULL,
  suggestion    TEXT,
  triage        TEXT NOT NULL,
  submission    TEXT NOT NULL,
  submitted_url TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_findings_review ON findings(review_id);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_messages_discussion ON messages(discussion_id);

-- per-user 外观偏好:单行 kv(见 frontend-components.md)
CREATE TABLE ui_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  data_mode         TEXT NOT NULL,
  data_theme        TEXT NOT NULL,
  left_width        INTEGER NOT NULL,
  right_width       INTEGER NOT NULL,
  default_tab       TEXT NOT NULL,
  default_diff_view TEXT NOT NULL
);

-- per-review 进度(viewed 等),随会话恢复
CREATE TABLE review_ui_state (
  review_id       TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  viewed_files    TEXT NOT NULL DEFAULT '[]',
  last_active_tab TEXT
);
`;

// 缓存本次改动的 unified diff 原文;单独一表,避免 reviews 的 SELECT * 拖大 blob。
const V2 = `
CREATE TABLE review_diffs (
  review_id  TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  raw        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// 用户在发起时可选的 codex 模型/effort:落库以便续接会话复用;ui_settings 存发起表单缺省。
const V3 = `
ALTER TABLE reviews ADD COLUMN model TEXT;
ALTER TABLE reviews ADD COLUMN reasoning_effort TEXT;
ALTER TABLE ui_settings ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
ALTER TABLE ui_settings ADD COLUMN default_effort TEXT NOT NULL DEFAULT 'medium';
`;

const MIGRATIONS: string[] = [V1, V2, V3];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
