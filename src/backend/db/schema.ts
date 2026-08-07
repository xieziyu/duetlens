/**
 * SQLite schema 迁移。用 `PRAGMA user_version` 记录版本,顺序应用。
 * 新增变更 = 往 MIGRATIONS 追加一条,勿改历史条目 —— **哪怕它还没合并**:
 * 只要在任何一台机器上跑过一次,那台的 user_version 就记住了序号。事后合并/删除条目会让
 * 数组变短,而 `for (v = current; v < length)` 对 current > length 的库直接空转:
 * 眼下靠列恰好对得上而不报错,下一条新迁移却会被静默跳过。
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

-- per-user 外观偏好:单行 kv(见 docs/design/architecture.md)
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

// 提交发生在第几轮 —— 复核仍存在的条目要能在**之后的轮次**追发一条复核评论,
// 只看 submission 分不出「本轮刚发的」与「上一轮发的」。存量记录无从追溯,按所在 review 的当前轮次算:
// 宁可少发一条追评,也不要给存量数据凭空重发一遍已经在 PR 上的评论。
const V11 = `
ALTER TABLE findings ADD COLUMN submitted_round INTEGER;
UPDATE findings
   SET submitted_round = (SELECT current_round FROM reviews WHERE reviews.id = findings.review_id)
 WHERE submission = 'submitted';
`;

// 结案来源:复核判定已修复而自动结案,与 reviewer 主动剔除在库里长得一样(都是 triage=dismiss),
// 但对回归的态度相反(见 isAutoClosedFixed),只能显式记。存量行按当时唯一的判据回填 ——
// 那会儿 reviewer 剔过又被判 fixed 的条目本就分不出来,回填只是把旧口径原样接过来。
const V12 = `
ALTER TABLE findings ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0;
UPDATE findings SET auto_closed = 1 WHERE triage = 'dismiss' AND resolution = 'fixed';
`;

// 讨论里 agent 对 finding 的回写提案(update / dismiss / restore / create)。
// 独立成表而非挂在 finding 上:一条 finding 可以先后有多个提案,且应用/忽略之后要留在对话里 ——
// 「谁在什么时候把这条改成了什么」除此之外没有第二处凭据。
// message_id 可空:该 turn 没有回复文本时提案就地接在线程末尾;消息被清空(clearMessages)时置空而非连坐删除。
const V13 = `
CREATE TABLE finding_proposals (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  discussion_id  TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  message_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  finding_id     TEXT REFERENCES findings(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  patch          TEXT NOT NULL,
  before_snapshot TEXT,
  base_updated_at INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);
CREATE INDEX idx_proposals_review ON finding_proposals(review_id);
CREATE INDEX idx_proposals_discussion ON finding_proposals(discussion_id);
`;

// 「降级为摘要评论」从此记在独立一格,不再靠把 line 清成 0 来表达 —— 摘要条目要写出 file:line
// 给作者定位,清掉行号等于把这信息扔了,也让降级不可回退。存量的 line=0 行只能按脱锚回填,
// 原行号已不可追溯(findingAnchorText 对它只给文件名)。
const V14 = `
ALTER TABLE findings ADD COLUMN anchor_dropped INTEGER NOT NULL DEFAULT 0;
UPDATE findings SET anchor_dropped = 1 WHERE line <= 0;
`;

// agent 经 write_summary 回写的重点关注文件。JSON 存一列而非独立成表:
// 每轮整份重写、只随 review 一起读,没有单查或外键的用法,拆表只多一次 join。
const V15 = `
ALTER TABLE reviews ADD COLUMN summary_files TEXT NOT NULL DEFAULT '[]';
`;

// 总结写于第几轮。总结是 review 级单份值、重跑不清空,没有这一列就分不出屏上这份是
// 本轮结论还是上一轮的旧结论(见 isSummaryStale)。
//
// 存量行留 NULL,这同时成了**来源判据**:本列出现之前 agent 没有任何写入通道
// (总结只在回复文本里,从不落库),故 `summary_body 非空 + summary_round 为 NULL`
// 必是 reviewer 手写的旧数据。不清空、也不当作 agent 产出展示,见 isLegacySummary。
const V16 = `
ALTER TABLE reviews ADD COLUMN summary_round INTEGER;
`;

// 正文写于第几轮。复核说明会被后来的正文改写作废(见 ReviewStore.updateFinding),此后
// 「本轮到底有没有给作者新写一句话」就只剩这一列可问 —— 去重兜底命中的条目同样是
// 「仍存在 + 没有说明」,但它一个字都没新写,不该据此追发一条与已提交评论重复的追评。
//
// 存量行按首报轮次回填:改写轮次无从追溯,宁可少发一条追评,也不要凭空重发已在 PR 上的话。
const V17 = `
ALTER TABLE findings ADD COLUMN body_round INTEGER;
UPDATE findings SET body_round = round;
`;

const MIGRATIONS: string[] = [
  V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17,
];

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
