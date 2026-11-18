-- 安全边界加固 / db/hardening.sql
-- 配套：worker/src/core.js、docs/security-hardening-sop.md
-- 执行：npx wrangler d1 execute model-test-demo-db --remote --file ../db/hardening.sql
-- 前置：npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-hardening.sql
--
-- 本文件包含三段：
--   A. 只新增（可重复执行）
--   B. 需要一次性执行（SQLite 不支持 IF NOT EXISTS 的 ALTER）
--   C. 数据迁移：邀请码明文 → 摘要（旧码失效，需重新发码）
--
-- 先读第 C 段再执行：它会重建 invite_codes，明文码全部作废。
-- 建议先跑 A、B 两段、验证通过后再跑 C。

-- ================================================================
-- A. 新增表与索引（幂等）
-- ================================================================

-- 可撤销登录会话：库内只存凭证摘要，明文只在登录响应里出现一次
CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,                 -- uuid，也是凭证前半段
  user_id       TEXT NOT NULL,                    -- = users.token_id
  secret_hash   TEXT NOT NULL,                    -- sha256('dsh-session-v1:' || secret)
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER,                          -- 非空即失效（退出、封禁、泄露处置）
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

-- 登录尝试计数：按 bucket（来源维度）+ key + 固定窗口计数
CREATE TABLE IF NOT EXISTS login_attempts (
  bucket        TEXT NOT NULL,                    -- login:ip | login:code
  key           TEXT NOT NULL,                    -- IP，或邀请码摘要
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_window
  ON login_attempts(window_start);

-- 文件归属：客户端只持本地 id，上游 file_id 只存在库里
CREATE TABLE IF NOT EXISTS file_objects (
  id            TEXT PRIMARY KEY,                 -- 本地文件标识（返回给前端）
  user_id       TEXT NOT NULL,
  upstream_id   TEXT NOT NULL,                    -- DeepSeek Files API 的 file_id
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT,                             -- 可选：按内容去重
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_file_objects_user
  ON file_objects(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_objects_upstream
  ON file_objects(upstream_id);

-- 运行期开关：改一行即生效，不需要 deploy
CREATE TABLE IF NOT EXISTS app_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('new_upstream_calls', 'allow', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('upstream_daily_budget_micro', '0', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- ================================================================
-- B. 一次性增量（执行一次，重复执行会报 duplicate column）
-- ================================================================

-- 预占金额：结算时按它释放，状态机 reserved → settled / released / reconcile_required
ALTER TABLE usage_requests ADD COLUMN reserved_micro INTEGER NOT NULL DEFAULT 0;
-- 待对账原因：没有拿到 usage 的请求把原因写在这里，绝不静默清零
ALTER TABLE usage_requests ADD COLUMN reconcile_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_reserved
  ON usage_requests(status, started_at) WHERE status = 'reserved';

-- 邀请码加摘要列（C 段会用它替换明文主键）
ALTER TABLE invite_codes ADD COLUMN code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_hash ON invite_codes(code_hash);

-- ================================================================
-- C. 迁移：邀请码改为摘要存储
-- ================================================================
-- 为什么重建：invite_codes 原本以明文 code 为主键，无法在不改主键的前提下
-- 换成摘要。重建期间旧码一律失效，需要重新发码。
--
-- 步骤（建议先发码、再删旧表，把「登录失败窗口」压到一条 C3 语句）：
--   C1) 建 invite_codes_new 并写入新码（下面的 node 命令逐个生成）
--   C2) 核对新表：SELECT COUNT(*) FROM invite_codes_new;（应为待发码数）
--   C3) DROP TABLE invite_codes; ALTER TABLE invite_codes_new RENAME TO invite_codes;
--   C4) 抽查登录：拿一个新码 POST /api/login，应 200 且下发 Cookie
--   停流不是必须的：C3 只有两条语句、毫秒级，且旧码在 C3 之前依然有效。
--   要万无一失就先停流，跑完 C3 再放流（见文件末尾 E 段）。
--
-- 生成新码（code_hash = sha256('dsh-invite-v1:' || code)，前缀见 core.js INVITE_HASH_PREFIX）：
--   node -e "const c=require('crypto');for(let i=0;i<20;i++){const code=c.randomBytes(12).toString('base64url');console.log(code, c.createHash('sha256').update('dsh-invite-v1:'+code).digest('hex'))}"
--   然后：INSERT INTO invite_codes_new (id, code_hash, note, expires_at, created_at)
--         VALUES (lower(hex(randomblob(16))), '<hash>', 'batch-2026-11', NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS invite_codes_new (
  id          TEXT PRIMARY KEY,                   -- uuid
  code_hash   TEXT NOT NULL UNIQUE,               -- sha256('dsh-invite-v1:' || code)
  used_by     TEXT,
  used_at     INTEGER,
  note        TEXT,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_new_unused
  ON invite_codes_new(used_by) WHERE used_by IS NULL;

-- 旧码一律不迁移：未用的码作废（重新发码），已用的码已无兑换价值。
-- 账户历史在 users / sessions，不受影响；只是旧码无法再用于续签，需重新登录。

-- C3 之前请先执行 C1、C2（新表必须先有码，否则重建完一个能用的码都没有）。
-- 下面的 DROP 留在文件里只为留下完整迁移脚本；日常用 --file 整文件执行会跳过它，
-- 真正上线时手工执行这两行：
--   DROP TABLE invite_codes;
--   ALTER TABLE invite_codes_new RENAME TO invite_codes;

-- ================================================================
-- D. 对账查询（只读，日常核查用）
-- ================================================================
-- D1) 钱包余额 vs 流水合计：两者不等说明有人绕过流水改了余额
--   SELECT w.user_id, w.balance_micro,
--          COALESCE(SUM(l.amount_micro), 0) AS ledger_sum,
--          w.balance_micro - COALESCE(SUM(l.amount_micro), 0) AS diff
--     FROM quota_wallets w LEFT JOIN quota_ledger l ON l.user_id = w.user_id
--    GROUP BY w.user_id HAVING diff != 0;
--
-- D2) 滞留预占：正常情况下 3 分钟内应被结算或回收
--   SELECT request_id, user_id, route, reserved_micro, started_at
--     FROM usage_requests WHERE status = 'reserved' AND started_at < ?
--    ORDER BY started_at LIMIT 50;
--
-- D3) 待对账金额：这部分是「已经花了但没算准」的敞口
--   SELECT COUNT(*) AS n, SUM(cost_micro) AS cost_micro
--     FROM usage_requests WHERE status = 'reconcile_required';

-- ================================================================
-- E. 运行期开关（随时可用，不需 deploy）
-- ================================================================
-- 停流：拒绝新的上游调用（已发出的请求不受影响，返回 503「服务暂停中」）
--   UPDATE app_settings SET value='deny', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
--    WHERE key='new_upstream_calls';
-- 放流：
--   UPDATE app_settings SET value='allow', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
--    WHERE key='new_upstream_calls';
-- 每日上游预算（micro 单位；0 表示不设上限）：
--   UPDATE app_settings SET value='50000000'
--    WHERE key='upstream_daily_budget_micro';
