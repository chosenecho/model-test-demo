# 额度系统 SOP

配套：[设计文档](quota.md) · [`db/quota.sql`](../db/quota.sql)。本文只讲「怎么操作」，所有 SQL 都在本地 D1 跑通过。

---

## 0. 前置

| 项 | 值 |
|---|---|
| 库 | `model-test-demo-db`（`af16a4fb-ed3d-42e3-8a3c-c0f26b84187d`） |
| 命令目录 | `C:\WorkSpace\model-test-demo\worker` |
| 查询要加 | `--remote`（不加就是本地空库） |

**单位**：1 额度 = 1,000,000 `micro`。表里所有金额字段都是 micro 整数，别写小数。

**四种流水（`quota_ledger.kind`）**

| kind | 方向 | 什么时候写 |
|---|---|---|
| `grant` | + | 开户、周期发放 |
| `consume` | − | 一次请求扣费 |
| `refund` | + | 上游失败、请求异常时退回 |
| `expire` | − | 周期结束、`rollover=0` 时清零 |
| `adjust` | ± | 人工补/扣（工单、补偿） |

**一条铁律**：`quota_wallets.balance_micro` 是缓存，`quota_ledger` 才是真相。**任何改动余额的操作，必须在同一批里写一条流水**，否则对账立刻报差额。

---

## 1. 上线（P1）

### 1.1 数据侧

```powershell
cd C:\WorkSpace\model-test-demo\worker

# 备份
npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-before-quota.sql

# 本地先验证（影子库，不碰线上）
npx wrangler d1 execute model-test-demo-db --local --file ../db/quota.sql

# 线上建表（5 表 + v_quota 视图 + 3 个套餐）
npx wrangler d1 execute model-test-demo-db --remote --file ../db/quota.sql

# 核对
npx wrangler d1 execute model-test-demo-db --remote --command "SELECT id, name, grant_micro, price_in_micro, price_out_micro FROM quota_plans;"
```

### 1.2 给存量用户开钱包

```powershell
npx wrangler d1 execute model-test-demo-db --remote --command "
INSERT OR IGNORE INTO quota_wallets (user_id, plan_id, balance_micro, status, updated_at)
SELECT token_id, 'free', 0, 'active', CAST(strftime('%s','now') AS INTEGER)*1000 FROM users;"
```

余额从 0 起、等首次周期发放 —— **不要**手填一个初始余额当「开户赠送」，那会绕过流水。

### 1.3 代码侧

1. 登录成功时开钱包（`INSERT OR IGNORE`），并配 `period_start/period_end`
2. `checkQuota` + `incrQuota` → 一个 `chargeRequest()`（`docs/quota.md` §5 的 batch）
3. `/api/me` 返回 `v_quota` 的字段
4. `wrangler.toml` 加 Cron：`[triggers] crons = ["10 0 * * *"]`，Worker 里实现 `scheduled()`
5. `DAILY_QUOTA` 改名 `RATE_LIMIT_PER_MIN`（限流还在，额度换了）

### 1.4 上线验收（5 步）

```powershell
# 1) 额度不足应当 402，不是 429
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://aivmz.dpdns.org/anthropic/v1/messages `
  -H "x-api-key: <TOKEN>" -H "Content-Type: application/json" `
  -d '{"model":"x","max_tokens":8,"stream":true,"messages":[{"role":"user","content":"hi"}]}'

# 2) /api/me 返回余额
curl.exe -s https://aivmz.dpdns.org/api/me -H "x-api-key: <TOKEN>"

# 3) 一次请求后 usage_requests 多一行、ledger 多一条 consume
npx wrangler d1 execute model-test-demo-db --remote --command "SELECT request_id, cost_micro, status FROM usage_requests ORDER BY started_at DESC LIMIT 3;"

# 4) 对账为空
npx wrangler d1 execute model-test-demo-db --remote --command "
SELECT w.user_id, w.balance_micro, COALESCE(SUM(l.amount_micro),0) ledger_sum
FROM quota_wallets w LEFT JOIN quota_ledger l ON l.user_id = w.user_id
GROUP BY w.user_id HAVING w.balance_micro <> COALESCE(SUM(l.amount_micro),0);"

# 5) 同一 request_id 重发不重复扣
#    重放第 1 步的请求，再查 usage_requests 是否仍只有 1 行
```

---

## 2. 开钱包（新用户）

登录接口里做，等价 SQL：

```sql
-- 幂等：已存在就跳过
INSERT OR IGNORE INTO quota_wallets (user_id, plan_id, balance_micro, period_start, period_end, status, updated_at)
VALUES (:userId, 'free', 0, :periodStart, :periodEnd, 'active', :now);

-- 开户台账（0 额度也记一条，保证从第一天起可对账）
INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, note, created_at)
SELECT :ledgerId, :userId, 'grant', 0, 0, '开户', :now
WHERE changes() > 0;
```

`WHERE changes() > 0` 让重复开户不会写两条开户流水。

---

## 3. 日常运营

### 3.1 补额度 / 退款（人工）

```powershell
$uid = "用户 token_id"
npx wrangler d1 execute model-test-demo-db --remote --command "
UPDATE quota_wallets SET balance_micro = balance_micro + 5000000, updated_at = 1767225600000 WHERE user_id='$uid';
INSERT INTO quota_ledger (id,user_id,kind,amount_micro,balance_after,note,created_at)
SELECT 'adj-'||hex(randomblob(8)), '$uid','adjust', 5000000, balance_micro, '手工补额度：工单 #123', 1767225600000
FROM quota_wallets WHERE user_id='$uid';"
```

顺序不能反：**先 UPDATE，再 SELECT `balance_micro` 当 `balance_after`**，这样流水里的余额是变更后的真实值。实测：余额 0 补 5,000,000 → 流水 `balance_after=5000000`，对账 0 差额。

退某一次请求的钱，用 `refund` 并把 `request_id` 带上，方便日后查：

```sql
INSERT INTO quota_ledger (id,user_id,kind,amount_micro,balance_after,request_id,note,created_at)
SELECT 'rf-'||hex(randomblob(8)), :userId, 'refund', :cost, balance_micro, :requestId, '上游超时退款', :now
FROM quota_wallets WHERE user_id = :userId;
```

### 3.2 改价 / 改套餐

```powershell
# 改价（立即生效，已扣的历史不受影响）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE quota_plans SET price_in_micro=1500, price_out_micro=6000 WHERE id='free';"

# 换套餐（只改指针；要不要补发差额看业务）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE quota_wallets SET plan_id='vip', updated_at=1767225600000 WHERE user_id='$uid';"
```

改价不用发版——这是把定价放表里的唯一理由。

上传单独计价（A1a，2026-11-17 起）：`price_per_mb_micro`（每 MB，默认 1000）、`max_upload_mb`（单文件上限）。

```powershell
# 关闭上传计费（止血开关，不用回滚代码）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE quota_plans SET price_per_mb_micro=0;"
# 放宽/收紧单文件上限（worker 端 413 会立即跟着变）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE quota_plans SET max_upload_mb=128 WHERE id='vip';"
```

### 3.3 封禁 / 解封

```powershell
# 只停额度（还能登录、看历史，但发消息 402）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE quota_wallets SET status='suspended', updated_at=1767225600000 WHERE user_id='$uid';"

# 连登录一起停（鉴权层就挡住）
npx wrangler d1 execute model-test-demo-db --remote --command "UPDATE users SET status='banned' WHERE token_id='$uid';"
```

### 3.4 查某人额度

```powershell
npx wrangler d1 execute model-test-demo-db --remote --command "
SELECT * FROM v_quota WHERE user_id='$uid';
SELECT kind, amount_micro, balance_after, note, datetime(created_at/1000,'unixepoch') AS at
FROM quota_ledger WHERE user_id='$uid' ORDER BY created_at DESC LIMIT 20;
SELECT request_id, model, input_tokens, output_tokens, cost_micro, status
FROM usage_requests WHERE user_id='$uid' ORDER BY started_at DESC LIMIT 20;"
```

### 3.5 补额度 / 扣额度（adjust）

先改钱包，再按新余额记一条 `adjust` 流水（顺序不能反，`balance_after` 要读改后的值）：

```powershell
$uid='<用户 token_id>'; $amount=6000000   # 正数补、负数扣
$now=1794914100000
$sql1 = "UPDATE quota_wallets SET balance_micro = balance_micro + $amount, updated_at=$now WHERE user_id='$uid'"
$sql2 = "INSERT INTO quota_ledger (id,user_id,kind,amount_micro,balance_after,note,created_at) SELECT lower(hex(randomblob(16))), user_id, 'adjust', $amount, balance_micro, '手工补额度', $now FROM quota_wallets WHERE user_id='$uid'"
npx wrangler d1 execute model-test-demo-db --remote --command $sql1
npx wrangler d1 execute model-test-demo-db --remote --command $sql2
```

改完立刻跑 §6 对账，`diff` 必须为 0。

---

## 4. 周期发放（Cron，每天 00:10 UTC）

**触发**：`wrangler.toml` 的 `[triggers] crons = ["10 0 * * *"]`，Worker 导出 `scheduled()`。

**扫描**（只处理到期且激活的）：

```sql
SELECT w.user_id, w.balance_micro, p.grant_micro, p.rollover, p.period
FROM quota_wallets w JOIN quota_plans p ON p.id = w.plan_id
WHERE w.status = 'active' AND w.period_end IS NOT NULL AND w.period_end <= :now;
```

**每人三步**（实测通过：余额 5,000,000 → 清零 → 发 6,000,000，流水 4 条，对账 0 差额）：

```sql
-- ① rollover=0 才清零：先记 expire（读旧余额），balance_after 记 0
INSERT INTO quota_ledger (id,user_id,kind,amount_micro,balance_after,note,created_at)
SELECT 'exp-'||hex(randomblob(8)), :userId, 'expire', -balance_micro, 0, '周期结束清零', :now
FROM quota_wallets WHERE user_id = :userId AND balance_micro > 0;

-- ② 余额归零 + 推进周期
UPDATE quota_wallets
SET balance_micro = 0,
    period_start = :nextStart, period_end = :nextEnd, updated_at = :now
WHERE user_id = :userId;

-- ③ 发放：先加余额，再记 grant（balance_after 读新值）
UPDATE quota_wallets SET balance_micro = balance_micro + :grantMicro WHERE user_id = :userId;
INSERT INTO quota_ledger (id,user_id,kind,amount_micro,balance_after,note,created_at)
SELECT 'gr-'||hex(randomblob(8)), :userId, 'grant', :grantMicro, balance_micro, '周期发放', :now
FROM quota_wallets WHERE user_id = :userId;
```

- `rollover=1` 的套餐：**跳过 ①（不清零）**，只做 ②③
- `period='none'`（内部账号）：整段跳过
- 单次 cron 里处理不完要分批（每次 Worker 调用最多 1000 条 query，一个用户 3 条 → 每次最多约 300 人）

---

## 5. 预占释放（P3 才需要）

```sql
-- 找过期未结算的预占
SELECT id, user_id, amount_micro, request_id FROM quota_reservations
WHERE status = 'held' AND expires_at < :now LIMIT 200;

-- 逐条释放
UPDATE quota_wallets SET reserved_micro = reserved_micro - :amount, updated_at = :now WHERE user_id = :userId;
UPDATE quota_reservations SET status = 'expired' WHERE id = :id;
```

释放只动 `reserved_micro`，**不动 `balance_micro`、不写 ledger**（否则对账会不平）。

---

## 6. 对账

```powershell
npx wrangler d1 execute model-test-demo-db --remote --command "
SELECT w.user_id, w.balance_micro, COALESCE(SUM(l.amount_micro),0) AS ledger_sum,
       w.balance_micro - COALESCE(SUM(l.amount_micro),0) AS diff
FROM quota_wallets w LEFT JOIN quota_ledger l ON l.user_id = w.user_id
GROUP BY w.user_id HAVING diff <> 0;"
```

空 = 一致。**发现差额不要直接改余额抹平**，先按下面顺序查：

1. 有没有 `UPDATE quota_wallets` 却没写流水（改价脚本、手工修数最常见）
2. `quota_ledger` 里 `reserve/release` 有没有被误记（这两类不该进 ledger）
3. 有没有并发双写（同一 `request_id` 出现两条 consume）

确认原因后，用一条 `adjust` 流水把差额补平，并在 `note` 里写清原因。

---

## 7. 排障

| 症状 | 先查 | 处置 |
|---|---|---|
| 用户报「额度不足」但看着还有 | `SELECT * FROM v_quota WHERE user_id=?` | `available_micro = balance - reserved`，预占没释放会让可用变 0；查 §5 |
| 一次请求扣了两次 | `SELECT * FROM usage_requests WHERE user_id=? ORDER BY started_at DESC` | 同一 `request_id` 正常只有一行；两行说明代码没走幂等路径，补一条 `refund` 并修代码 |
| 扣了费但没回答 | `usage_requests.status` 是否 `error` | 应自动 `refund`；没退就手工补 |
| 对账不平 | §6 | 见上 |
| 周期没发额度 | `period_end` 是否为 NULL；cron 是否触发 | 手工跑一次发放（§4） |
| 402 和 429 分不清 | — | 额度不足 `402`、静流限流 `429`；混用会让用户以为要充值 |
| 某人额度异常大 | `SELECT SUM(amount_micro) FROM quota_ledger WHERE user_id=? AND kind='adjust'` | 查是否有误操作，记反向 `adjust` |

看实时日志：`npx wrangler tail`。

---

## 8. 回滚

额度系统是独立表，回滚不影响会话数据。

```powershell
# QUOTA_MODE 是 wrangler.toml 里的 [vars]，改完要 deploy 才生效
# 1) 紧急放行（先止血）：改成 off，跳过扣费与限流检查
#    编辑 worker/wrangler.toml: QUOTA_MODE = "off"
cd worker; npx wrangler deploy

# 2) 或整体回到计数版（读 usage_daily，DAILY_QUOTA=20 生效）
#    QUOTA_MODE = "count"
cd worker; npx wrangler deploy
```

`QUOTA_MODE`：`credits`（默认）/ `count`（旧计数）/ `off`（只记录不拦）。**切换不需要改表**，但要重新 deploy 使 var 生效。

真要删表（不建议，会丢全部台账）：

```powershell
# 先导出
npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-quota-final.sql
```

---

## 9. 变更检查清单

改额度相关代码或数据后，逐条打勾：

- [ ] `quota.sql` 的改动能 `--local` 跑通，再 `--remote`
- [ ] 远端执行前有 `d1 export` 备份
- [ ] 任何 `UPDATE quota_wallets` 都配了对应流水
- [ ] 新增的 `kind` 值同步更新 §0 的流水表和对账口径
- [ ] 对账 SQL 返回空
- [ ] 用真 token 验证：402（额度不足）/ 429（限流）/ 200（正常）三条路径
- [ ] `usage_requests` 里能查到这次请求
- [ ] 文档（quota.md / quota-sop.md）同步改了

---

## 10. 禁止事项

1. **禁止直接 `UPDATE quota_wallets SET balance_micro = ...` 而不写流水** —— 对账必报，且没人查得清是谁改的
2. **禁止 `UPDATE`/`DELETE` 已有流水** —— 冲正只能新增一条反向流水
3. **禁止用浮点表示金额** —— 一律 micro 整数
4. **禁止把 `reserved_micro` 计入 `balance_micro`** —— 可用 = balance − reserved
5. **禁止在 `usage_requests` 上用 `DELETE` 清理** —— 归档靠时间分区/导出，不靠删
6. **禁止不备份就改 `quota_plans` 的价格** —— 改价影响所有后续请求

---

## 11. 落地记录（2026-11）

- 代码函数名不叫 `chargeRequest()`，拆成了 `preflight()`（限流+余额预检）→ `startRequest()`（落 pending）→ `settleUsage()`（按真实 usage 扣费）。语义与本文档一致：扣减用 `UPDATE ... WHERE balance_micro >= ?` + `WHERE changes() = 1` 同 batch。
- 已部署 Version `6287f163-d93f-475d-b426-98e887bb7c7e`，cron `10 0 * * *` 已注册，远端 quota 5 表 + `v_quota` 已建。
- 存量用户已一次性回填 free 套餐当期 6,000,000 micro（`note='首次开户发放'`）。
- 本地实测：结算 4,600 micro（1000 in / 200 out）、402、429、幂等 409、cron 过期+发放，全部符合 §4/§6/§7 的预期。
- 未配置 `DEEPSEEK_API_KEY`，真实 200 链路待补。
