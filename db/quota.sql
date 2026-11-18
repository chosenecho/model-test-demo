-- 额度系统 v1（叠加在 schema-v2 之上，不改动已有表）
-- 金额单位：微额度（micro），1 额度 = 1,000,000 micro。整数运算，不用浮点。
-- 所有时间：INTEGER 毫秒。

-- ---------- 套餐 / 定价（改价只改数据，不发版） ----------

CREATE TABLE IF NOT EXISTS quota_plans (
  id                TEXT PRIMARY KEY,                   -- free | vip | internal
  name              TEXT NOT NULL,
  period            TEXT NOT NULL DEFAULT 'month',      -- month | day | none
  grant_micro       INTEGER NOT NULL DEFAULT 0,         -- 每周期发放额度
  rollover          INTEGER NOT NULL DEFAULT 0,         -- 1 = 未用完结转
  price_in_micro    INTEGER NOT NULL DEFAULT 0,         -- 每 1K 输入 token 的价格
  price_out_micro   INTEGER NOT NULL DEFAULT 0,         -- 每 1K 输出 token 的价格
  per_request_micro INTEGER NOT NULL DEFAULT 0,         -- 每次请求固定费（含缓存命中）
  soft_limit_pct    INTEGER NOT NULL DEFAULT 80,        -- 低于该百分比时前端提醒
  overage           INTEGER NOT NULL DEFAULT 0,         -- 1 = 允许透支（记欠款），0 = 硬停
  price_per_mb_micro INTEGER NOT NULL DEFAULT 1000,     -- 每 MB 上传的单价（0 = 不计费）
  max_upload_mb     INTEGER NOT NULL DEFAULT 64,        -- 单文件上限，Worker 据此拦 413
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- ---------- 钱包：每人一行，物化的可用余额 ----------
-- 余额是"缓存"，真相在 quota_ledger；对账任务校验两者一致。

CREATE TABLE IF NOT EXISTS quota_wallets (
  user_id         TEXT PRIMARY KEY,                     -- = users.token_id
  plan_id         TEXT NOT NULL DEFAULT 'free',
  balance_micro   INTEGER NOT NULL DEFAULT 0,           -- 可用
  reserved_micro  INTEGER NOT NULL DEFAULT 0,           -- 预占中（流式请求未结算）
  period_start    INTEGER,
  period_end      INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',       -- active | exhausted | suspended
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallets_status ON quota_wallets(status);
CREATE INDEX IF NOT EXISTS idx_wallets_period ON quota_wallets(period_end);

-- ---------- 流水：追加式，只能 INSERT，永不 UPDATE/DELETE ----------

CREATE TABLE IF NOT EXISTS quota_ledger (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,                         -- grant | consume | refund | expire | adjust | reserve | release
  amount_micro   INTEGER NOT NULL,                      -- 正 = 入账，负 = 出账
  balance_after  INTEGER NOT NULL,                      -- 记账后的可用余额（对账用）
  request_id     TEXT,                                  -- 关联 usage_requests.request_id
  note           TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON quota_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON quota_ledger(request_id);
CREATE INDEX IF NOT EXISTS idx_ledger_kind_time ON quota_ledger(kind, created_at DESC);

-- ---------- 每次请求一条独立记录（含被拒的） ----------
-- request_id 同时是幂等键：重试复用同一条，不会重复扣费。

CREATE TABLE IF NOT EXISTS usage_requests (
  request_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  session_id     TEXT,
  message_id     TEXT,
  route          TEXT NOT NULL,                         -- /anthropic/v1/messages | /api/chat
  model          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_micro     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,                         -- pending | ok | error | aborted | rejected | insufficient
  http_status    INTEGER,
  error_code     TEXT,
  latency_ms     INTEGER,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_requests(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_status_time ON usage_requests(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_requests(session_id);

-- ---------- 预占（流式请求用；可选，第一阶段可不启用） ----------

CREATE TABLE IF NOT EXISTS quota_reservations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  amount_micro   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'held',          -- held | settled | released | expired
  expires_at     INTEGER NOT NULL,                      -- 崩溃兜底：过期后由定时任务释放
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON quota_reservations(status, expires_at);

-- ---------- 视图：一次查询拿到"这个人还能不能用" ----------

CREATE VIEW IF NOT EXISTS v_quota AS
SELECT
  w.user_id,
  w.plan_id,
  p.name            AS plan_name,
  w.balance_micro,
  w.reserved_micro,
  (w.balance_micro - w.reserved_micro) AS available_micro,
  w.period_end,
  w.status,
  p.soft_limit_pct,
  p.grant_micro
FROM quota_wallets w
LEFT JOIN quota_plans p ON p.id = w.plan_id;

-- ---------- 初始套餐（示例数值，按 DeepSeek 实际价格改） ----------
-- 计费示例：输入 2,000 micro/1K + 输出 8,000 micro/1K，常驻费 1,000 micro/次
--   一次 1K 输入 + 1K 输出 ≈ 11,000 micro ≈ 0.011 额度
--   free 每月 6,000,000 micro（6 额度）≈ 约 545 次这样的请求
INSERT OR IGNORE INTO quota_plans
  (id, name, period, grant_micro, rollover, price_in_micro, price_out_micro, per_request_micro, soft_limit_pct, overage)
VALUES
  ('free',     '免费版',   'month', 6000000,  0, 2000, 8000, 1000, 80, 0),
  ('vip',      '会员版',   'month', 60000000, 1, 2000, 8000, 1000, 80, 1),
  ('internal', '内部测试', 'none',  0,        1, 0,    0,    0,    100, 1);
