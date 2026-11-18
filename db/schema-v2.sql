-- model-test-demo D1 schema v2
-- 目标态：用户 / 邀请码 / 会话 / 消息 / 附件 / 搜索缓存 / 用量 / 工具调用
-- 全部语句可重复执行（IF NOT EXISTS），时间统一用 INTEGER 毫秒时间戳（与前端 Date.now() 对齐）

-- ---------- 用户 ----------

CREATE TABLE IF NOT EXISTS users (
  token_id        TEXT PRIMARY KEY,                 -- uuid，即 HMAC Token 里的 tokenId
  display_name    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | banned
  quota_override  INTEGER,                          -- 每日次数覆盖；NULL 用全局 DAILY_QUOTA
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  last_seen_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ---------- 邀请码 ----------

CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  used_by     TEXT,                                 -- 使用者的 token_id；NULL 表示未用
  used_at     INTEGER,
  note        TEXT,                                 -- 备注：发给谁、哪一批
  expires_at  INTEGER,                              -- NULL 表示不过期
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_invite_unused ON invite_codes(used_by) WHERE used_by IS NULL;

-- ---------- 会话 ----------

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,               -- 前端生成的 uuid，服务端不重写
  user_id           TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived          INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  root_message_id   TEXT,                           -- NULL = 空会话
  selected_leaf_id  TEXT,                           -- 当前选中分支的末端消息
  model             TEXT,
  settings_json     TEXT NOT NULL DEFAULT '{}',     -- {thinking:bool, search:bool}
  deleted_at        INTEGER                         -- 软删；定时任务物理清理
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
  ON sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_purge
  ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;

-- ---------- 消息 ----------

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,                   -- 前端生成的 uuid
  session_id    TEXT NOT NULL,
  parent_id     TEXT,                               -- 分支：上一条消息；NULL = 根
  role          TEXT NOT NULL,                      -- user | assistant | latest_reminder
  content_json  TEXT NOT NULL,                      -- user: {text, files[]}；assistant: blocks[]
  status        TEXT NOT NULL DEFAULT 'done',       -- pending | streaming | done | stopped | error
  model         TEXT,
  thinking      INTEGER,                            -- 本轮是否开深度思考
  search        INTEGER,                            -- 本轮是否开联网搜索
  prefix        INTEGER NOT NULL DEFAULT 0,         -- 是否允许作为续写前缀
  stop_reason   TEXT,
  error_json    TEXT,
  usage_json    TEXT,                               -- {input_tokens, output_tokens, ...}
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages(parent_id);

-- ---------- 附件 ----------

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,                 -- 前端本地 id（IndexedDB files 主键）
  user_id         TEXT NOT NULL,
  message_id      TEXT,                             -- 挂在哪条消息上；NULL = 草稿
  server_file_id  TEXT,                             -- DeepSeek Files API 的 file_id
  name            TEXT NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT NOT NULL DEFAULT '',
  is_image        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- ---------- 搜索缓存（Firecrawl 结果，省 credits） ----------

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key     TEXT PRIMARY KEY,                   -- sha256(provider|query|limit|lang|freshness)
  provider      TEXT NOT NULL DEFAULT 'firecrawl',
  query         TEXT NOT NULL,
  results_json  TEXT NOT NULL,                      -- 归一化后的 [{title,url,snippet,site_name,page_age}]
  credits       REAL NOT NULL DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expiry ON search_cache(expires_at);

-- ---------- 搜索调用日志（配额与成本核算） ----------

CREATE TABLE IF NOT EXISTS search_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  message_id    TEXT,
  query         TEXT NOT NULL,
  result_count  INTEGER NOT NULL DEFAULT 0,
  credits       REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  status        TEXT NOT NULL DEFAULT 'ok',         -- ok | cached | error | quota
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_log_user ON search_log(user_id, created_at DESC);

-- ---------- 工具调用（Firecrawl / MCP 循环留痕） ----------

CREATE TABLE IF NOT EXISTS tool_calls (
  id            TEXT PRIMARY KEY,                   -- tool_use id
  session_id    TEXT NOT NULL,
  message_id    TEXT,
  name          TEXT NOT NULL,                      -- web_search | read_url | mcp:*
  input_json    TEXT NOT NULL,
  output_json   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending | ok | error
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, started_at);

-- ---------- 每日用量（替代 v1 的 quota 表） ----------

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id        TEXT NOT NULL,
  day            TEXT NOT NULL,                     -- 'YYYY-MM-DD'（UTC）
  requests       INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  search_calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ---------- 密钥元数据（值只存在 Worker secret，表里只放指纹） ----------

CREATE TABLE IF NOT EXISTS provider_keys (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,                      -- deepseek | firecrawl
  label         TEXT NOT NULL DEFAULT '',
  key_tail      TEXT NOT NULL,                      -- 末 4 位，用于人工核对是哪把 key
  enabled       INTEGER NOT NULL DEFAULT 1,
  weight        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- ---------- Skill（保留） ----------

CREATE TABLE IF NOT EXISTS skills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  system_prompt  TEXT NOT NULL,
  tools          TEXT NOT NULL DEFAULT '[]'
);

INSERT OR IGNORE INTO skills (id, name, description, system_prompt, tools) VALUES
  (1, '通用对话', '默认模式，直接对话', '你是一个乐于助人的中文助手。', '[]'),
  (2, '行业分析师', '先列分析框架，再逐点论证，最后给结论', '你是一位严谨的行业分析师。回答时：先给出分析框架，再逐点论证，每个关键论断标注信息来源类型，最后给出明确结论与不确定性说明。', '[]'),
  (3, '深度调研', '联网搜集资料后输出带引用的调研纪要', '你是一位研究助理。先规划检索步骤，再逐步搜集信息，输出结构化调研纪要，所有事实性内容附来源。', '["web_search"]');
