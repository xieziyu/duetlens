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

// 长任务完成提示开关(SQLite 无 bool,用 INTEGER 0/1)。
const V4 = `
ALTER TABLE ui_settings ADD COLUMN notify_on_complete INTEGER NOT NULL DEFAULT 1;
`;

// 独立设置屏引入的偏好:默认来源 / findings 分组 / 已看折叠 + 外部 CLI 路径覆盖。
const V5 = `
ALTER TABLE ui_settings ADD COLUMN default_source TEXT NOT NULL DEFAULT 'github-pr';
ALTER TABLE ui_settings ADD COLUMN findings_grouping TEXT NOT NULL DEFAULT 'severity';
ALTER TABLE ui_settings ADD COLUMN collapse_viewed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ui_settings ADD COLUMN codex_path TEXT NOT NULL DEFAULT '';
ALTER TABLE ui_settings ADD COLUMN gh_path TEXT NOT NULL DEFAULT '';
`;

// 多轮重跑:轮次表 + finding 的轮次归属与复审判定 + 剔除理由。
// 存量数据一律视作第 1 轮(默认值),无需回填。
const V6 = `
CREATE TABLE review_rounds (
  review_id       TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  codex_thread_id TEXT,
  head_sha        TEXT,
  status          TEXT NOT NULL,
  note            TEXT,
  new_findings    INTEGER NOT NULL DEFAULT 0,
  fixed_count     INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  PRIMARY KEY (review_id, round)
);

ALTER TABLE reviews ADD COLUMN current_round INTEGER NOT NULL DEFAULT 1;

ALTER TABLE findings ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE findings ADD COLUMN last_seen_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE findings ADD COLUMN resolution TEXT;
ALTER TABLE findings ADD COLUMN resolution_note TEXT;
ALTER TABLE findings ADD COLUMN dismiss_reason TEXT;
`;

// 审核强度(标准 / 对抗);存量数据按 standard(默认值),无需回填。
const V7 = `
ALTER TABLE reviews ADD COLUMN intensity TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE ui_settings ADD COLUMN default_intensity TEXT NOT NULL DEFAULT 'standard';
`;

// 入口本地仓库来源的上次选择:统一入口后选目录是必经第一步,预填省掉每次重开的重选。
const V8 = `
ALTER TABLE ui_settings ADD COLUMN last_repo_path TEXT NOT NULL DEFAULT '';
`;

// 轮次失败留证 + 本轮变更文件快照。存量轮次没有这些信息,留空即可(失败原因无法追溯回填)。
const V9 = `
ALTER TABLE review_rounds ADD COLUMN error_message TEXT;
ALTER TABLE review_rounds ADD COLUMN error_kind TEXT;
ALTER TABLE review_rounds ADD COLUMN changed_files TEXT NOT NULL DEFAULT '[]';
ALTER TABLE review_rounds ADD COLUMN code_changed INTEGER NOT NULL DEFAULT 0;
`;

// 本地分支 / vbranch 扫完即终态(见 scanDoneStatus):这类 source 没有「提交 PR」那一步,
// 存量的 reviewing 是永远闭不了环的旧态,一次性收成 completed;扫描中/失败/已提交不动。
const V10 = `
UPDATE reviews SET status = 'completed'
 WHERE status = 'reviewing' AND source <> 'github-pr';
`;

const MIGRATIONS: string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10];

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
