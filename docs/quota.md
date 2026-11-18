# 额度管理系统设计（替代「每日 20 次」）

DDL 见 [`db/quota.sql`](../db/quota.sql)。本文讲为什么这么设计、每张表干什么、怎么扣、怎么对账、怎么迁。
运维操作（上线、发额度、改价、对账、排障、回滚）见 [quota-sop.md](quota-sop.md)。

## 1. 现状与它的问题

现在只有一个计数器：`usage_daily.requests`，上限来自 `wrangler.toml` 的 `DAILY_QUOTA=20`，UTC 零点归零。

三个问题：

1. **计量单位错了**。一次请求可能是 50 token，也可能是 40 万 token，但都记 1 次。深度思考 + 长文输出的人，成本是别人的几十倍，扣的次数一样。
2. **没有每次请求的记录**。只知道「今天用了 7 次」，不知道这 7 次是谁、什么模型、多少 token、多少钱、失败没有。查不了纠纷，也算不出真实成本。
3. **改额度要发版**。`DAILY_QUOTA` 在 `wrangler.toml` 里，调一次要么改代码部署、要么改环境变量重启；没法按用户、按套餐给不同额度。

另外要分清两个概念——现在的「20 次/天」其实是**限流（rate limit）**，不是**额度（quota）**：

| | 限流 rate limit | 额度 quota / balance |
|---|---|---|
| 回答的问题 | 单位时间内最多打几次（防刷、防打爆上游） | 一共还能用多少（算钱、算权益） |
| 典型实现 | 令牌桶 / 滑动窗口 | 余额 + 流水 |
| 重置 | 每个窗口自动满血 | 充值/发放时增加，消费时减少 |

**结论：两个都要。** 换成额度体系之后，仍然保留一个轻量限流（建议 10 次/分钟/IP+用户），否则一个脚本能在几秒内把整月额度刷光。

## 2. 调研：成熟做法

| 方案 | 代表 | 数据模型 | 优点 | 不适用的地方 |
|---|---|---|---|---|
| **A. 余额字段**（当前思路的升级版） | 早期 SaaS | `users.credits` 一个整数 | 最简单，一条 SQL 搞定 | 答不出「为什么是这个数」；退款/过期/促销额度无法区分；有纠纷只能翻日志 |
| **B. 复式记账式流水** | Stripe Billing Credits、Modern Treasury、LuxLedger | `accounts` + `transactions` + `entries`，余额 = `SUM(amount_signed)` | 每一分钱都有出处；可冲正、可审计、可对账 | 需要多写一张表、一个对账任务 |
| **C. 用量计量 + 实时额度引擎** | Lago、OpenMeter、Schematic、Stripe Meters | 事件流 → 计量规则 → 钱包/额度 | 支持按 token 计价、套餐、超额 | 对单人小站是过度设计 |

调研里反复出现的几条硬结论：

- **余额字段不是错，是阶段性选择**。Elma 的判断标准很实在：只要出现「付费额度 + 促销额度混用」「退款/冲正」「预占」「多服务写余额」「客户质疑账单」「要和支付渠道对账」「多种计量单位」中的两三条，就该上流水表。
- **扣减必须是一条带条件的 UPDATE**，不是「先查再写」：
  `UPDATE ... SET balance = balance - ? WHERE user_id = ? AND balance >= ?`，然后看 `changes()` 是不是 0。这是所有「money path 竞态」文章给出的同一个答案（TOCTOU 的经典解法）。
- **幂等键是必须的**。Stripe 的做法：客户端带 `Idempotency-Key`，服务端把结果和这个 key 一起落库，重放请求直接返回上次结果，不重复扣费。我们的场景里，网络抖动导致前端重发、或者用户狂点「重新生成」，都会重复扣。
- **预占（reserve / hold）** 用于「先开工、后知道花多少」的场景，并且**必须带 TTL**，否则进程崩了就永久占用。
- **计价规则要放在数据里**，不能写死在代码里——否则改价就得发版（Solvimon 把这列为「v1 破产点」之一）。

上面这些都能落到 D1 上，代价只是多两张表和一段对账 SQL，不值得引入外部计费系统。

## 3. 选型

**B + C 的轻量版**：追加式流水做真相，钱包做缓存，每次请求一条独立计量记录，套餐/单价放表里。

五张表：

| 表 | 角色 | 一句话 |
|---|---|---|
| `quota_plans` | 配置 | 每个套餐发多少、按 token 怎么计价、超不超额 |
| `quota_wallets` | 缓存 | 每人一行：可用余额、预占中、当前周期、状态 |
| `quota_ledger` | **真相** | 追加式流水，只能 INSERT：发放 / 消费 / 退款 / 过期 / 手工调整 |
| `usage_requests` | 计量 | **每次请求一条**，含被拒的；`request_id` 兼幂等键 |
| `quota_reservations` | 并发 | 流式请求的预占，带 `expires_at` 兜底 |

外加一个视图 `v_quota`，一条查询拿到「这个人还能不能用、还剩多少」。

### 为什么不用一个余额字段了事

因为我们明确要「每次请求独立记录」。一旦有了 `usage_requests`，余额就必须能从流水推回来，否则两份数据会打架。反过来说，只要 `quota_ledger` 在，`balance_micro` 只是为了避免每次都 `SUM()` 的物化值——丢了也能重建。

## 4. 金额怎么表示

**整数微额度**：1 额度 = 1,000,000 `micro`。理由：

- 浮点数在金额上是灾难（`0.1 + 0.2 !== 0.3`），SQLite 只有 REAL，一定要用整数。
- 单价的粒度足够细：`0.002 额度 / 1K token` 写成 `2000 micro / 1K token`。

一条请求的成本：

```
cost_micro = ceil(input_tokens  / 1000 * price_in_micro)
           + ceil(output_tokens / 1000 * price_out_micro)
           + per_request_micro
```

其中 `input_tokens` 用 `input_tokens + cache_creation_input_tokens`（缓存读按更低价可另设字段，暂按同价）。

## 5. 扣减：一条原子 UPDATE

D1 的关键事实（[官方 limits](https://developers.cloudflare.com/d1/platform/limits/)）：**每个数据库单线程、逐条执行**；**事务不能跨请求**，只有 `db.batch()` 是一批原子提交；`batch` 在「每次 Worker 调用最多 1000 条 query」里只算 1 条。

所以扣费走一个 batch，三句话：

```js
const requestId = body.request_id ?? crypto.randomUUID()   // 幂等键
const cost = computeCost(plan, tokens)                     // 先算价

const [deduct] = await env.DB.batch([
  // 1) 条件扣减：余额不足时 changes()=0，什么都不会发生
  env.DB.prepare(`UPDATE quota_wallets
                     SET balance_micro = balance_micro - ?, updated_at = ?
                   WHERE user_id = ? AND balance_micro >= ?`)
    .bind(cost, now, userId, cost),

  // 2) 只有扣成功了才记流水（changes() 读的是上一条语句影响的行数）
  env.DB.prepare(`INSERT INTO quota_ledger
                    (id, user_id, kind, amount_micro, balance_after, request_id, created_at)
                  SELECT ?, ?, 'consume', ?, balance_micro, ?, ?
                    FROM quota_wallets WHERE user_id = ? AND changes() = 1`)
    .bind(ledgerId, userId, -cost, requestId, now, userId),

  // 3) 请求记录无条件写（被拒的也要留档）
  env.DB.prepare(`INSERT OR IGNORE INTO usage_requests
                    (request_id, user_id, route, model, cost_micro, status, started_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(requestId, userId, route, model, cost, deduct?.meta?.changes ? 'ok' : 'insufficient', now),
])

if (!deduct.meta.changes) return apiErr('额度不足，请充值或等下次发放', 402)
```

三个要点：

- **不用「先 SELECT 再 UPDATE」**。D1 单写但请求会并发到达，读-改-写之间一定有时间窗。
- **流水插入用 `WHERE changes() = 1`** 兜住「扣失败却记了账」的情况，整个 batch 原子。
- **`INSERT OR IGNORE` on `usage_requests`** 让同一个 `request_id` 重放时不会重复写、重复扣。

## 6. 流式请求：先预占，后结算

token 数在 `message_delta` 才拿到，但请求必须立刻放行。成熟做法是两阶段：

```
1. 预占  hold  = 预估成本（可用 max_tokens × 输出单价 + 输入估长）
         UPDATE quota_wallets SET reserved_micro = reserved_micro + hold
         INSERT INTO quota_reservations(... status='held', expires_at=now+5min)
2. 放行  转发上游，SSE 透传
3. 结算  流结束后（ctx.waitUntil）按真实 usage 算 actual
         quota_wallets.balance_micro -= actual, reserved_micro -= hold
         INSERT ledger(kind='consume', amount=-actual)
         UPDATE reservations SET status='settled'
4. 兜底  定时任务扫 status='held' AND expires_at < now → 释放预占
```

**第一阶段可以先不做预占**（直接后结算），代价是并发大户能瞬间透支。真要防，必须开预占 + 释放任务。设计里表已经建好，开关由 `quota_plans.overage` 与是否写入 `quota_reservations` 决定。

## 7. 周期发放与到期

不用「清零」，用「发放」——每次都记一条 `grant` 流水，历史可查。

- 定时任务（Cloudflare Cron Trigger，每天 00:10 UTC）扫 `quota_wallets` 里 `period_end <= now` 的用户：
  1. `rollover=0` 的，把余额记一条 `expire`（负数）清零
  2. 记一条 `grant`（+`grant_micro`）
  3. 更新 `period_start/period_end` 到下一周期
- 结转（`rollover=1`）就跳过第 1 步。

这样「这个月为什么少了 500」永远能回答，而不是一句「到点清零了」。

## 8. 对账（三分钟能写完，但必须有）

余额是缓存，所以要不定期验证：`balance_micro == SUM(quota_ledger.amount_micro)`。

```sql
SELECT w.user_id, w.balance_micro, COALESCE(SUM(l.amount_micro), 0) AS ledger_sum
FROM quota_wallets w
LEFT JOIN quota_ledger l ON l.user_id = w.user_id
GROUP BY w.user_id
HAVING w.balance_micro <> COALESCE(SUM(l.amount_micro), 0);
```

空结果 = 一致。定时任务跑，非空就告警（先写 `console.error` + `wrangler tail`，后面接告警）。

**推论：任何直接改 `balance_micro` 的操作都必须同时写一条流水。** 开户、补额度、退款都不能只改钱包——本地实测过：手工 `INSERT` 一个 `balance=1000000` 的钱包再扣 300000，对账立刻报出 `balance_micro=700000 vs ledger_sum=-300000`。这条检查就是用来抓这类「绕过流水」的写入的。

注意：`reserve`/`release` 不改变 `balance`，只改 `reserved`，所以这两类流水不计入上面的等式（要么不记流水，要么在等式里排除）。

## 9. 接口变更

| 接口 | 现在 | 换成 |
|---|---|---|
| `GET /api/me` | `{quota:{used,limit}}` | `{quota:{balance_micro, available_micro, plan, period_end, soft_limit_pct}}` |
| 超限响应 | `429 daily quota exceeded` | `402 payment_required`（额度不足）/ `429`（限流）——**要分开**，前端提示不同 |
| `POST /anthropic/v1/messages` | 计数 | 幂等键 + 预占/结算 + `usage_requests` 落库 |
| 新增 `GET /api/usage?limit=50` | — | 该用户最近请求记录（前端「用量」页） |
| 新增 `GET /api/ledger?limit=50` | — | 流水（前端「账单」页） |

错误码分开很重要：额度不足要让用户看到「去充值/等下月」，限流要让用户看到「慢点」。

## 10. 迁移路径

现有数据只有 `usage_daily` 的计数，没有 token 维度，**不值得转换**，按「重置」处理：

```bash
cd worker
npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-before-quota.sql
npx wrangler d1 execute model-test-demo-db --remote --file ../db/quota.sql

# 给每个已有用户开钱包（没有用户时是空操作）
npx wrangler d1 execute model-test-demo-db --remote --command "
  INSERT OR IGNORE INTO quota_wallets (user_id, plan_id, balance_micro, updated_at)
  SELECT token_id, 'free', 0, CAST(strftime('%s','now') AS INTEGER)*1000 FROM users;"
```

代码侧一次性切换：

1. `checkQuota`/`incrQuota` 换成 `chargeRequest()`（上面的 batch）
2. 登录时开钱包（`INSERT OR IGNORE INTO quota_wallets`）
3. `wrangler.toml` 的 `DAILY_QUOTA` 退役，改成 `RATE_LIMIT_PER_MIN`
4. `usage_daily` 表保留 30 天做对照，之后删除

`usage_daily` 不会立刻删——先让新链路跑一周，用它对账「次数是否对得上」，再删。

## 11. 容量与性能

| 项 | 估算 |
|---|---|
| `usage_requests` 单行 | ~200 B（含索引） |
| 1000 请求/天 × 365 天 | 36.5 万行 ≈ 75 MB/年 |
| `quota_ledger` 单行 | ~150 B，每人每月 1 条 grant + N 条 consume |
| D1 上限 | 单库 10 GB，够用几十年 |
| 写入 | 每请求 1 个 batch（3 条语句），D1 单库串行，1 ms/条 → 上限约 300 请求/秒，远超需要 |

D1 的 10 GB 上限不可提升，但按上面的量级到不了。真到瓶颈，按用户分库（`per-user database`）是 D1 官方推荐的横向扩展方式。

## 12. 边界情况怎么处理

| 情况 | 处理 |
|---|---|
| 同一请求前端重发两次 | `request_id` 相同 → `usage_requests` 主键冲突被忽略，第二次走「已存在」分支，不再扣 |
| 上游 500 / 网络超时 | 先扣后结算的，结算时按 0 成本退款（`refund` 流水，+cost） |
| 用户中途停止生成 | 已收到的 token 照常计费（上游已经算了），`usage_requests.status='aborted'` |
| 余额刚好不够一次 | `402` + 明确文案；`overage=1` 的套餐允许负余额并记欠款 |
| 预占后进程崩溃 | `expires_at` 过期，定时任务释放 |
| 改价 | 改 `quota_plans` 一行，下一个请求立即生效；已扣的历史不受影响 |
| 手工补额度 | 记一条 `adjust` 流水 + 改钱包，`note` 写原因 |
| 退款/冲正 | 绝不 UPDATE 旧流水，新增一条反向 `refund` |

## 13. 落地顺序

1. **P1（半天）**：建表 + 登录开钱包 + `GET /api/me` 返回余额 + 后结算扣费 + `usage_requests` 落库。此时已经没有「20 次」限制。
2. **P2（半天）**：周期发放的 Cron + 对账任务 + `/api/usage`。
3. **P3（按需）**：预占/释放、套餐后台、充值入口。

## 14. 参考资料

- Cloudflare D1 Limits（单线程、batch 原子、每次调用 1000 query）— https://developers.cloudflare.com/d1/platform/limits/
- Stripe: Credit Grant / Credit Balance Transactions / Idempotent requests — https://docs.stripe.com/api/billing/credit-grant/object, https://docs.stripe.com/api/idempotent_requests
- Elma: SaaS Credit Ledger — when a balance column stops working（余额字段的五个失效信号）— https://www.elma.sh/blog/saas-credit-ledger
- Solvimon: Credit billing infrastructure for AI products（五层模型、v1 破产点）— https://www.solvimon.com/blog/credit-billing-infrastructure-that-scales-for-ai
- Modern Treasury: Digital Wallet / ledger accounts & entries — https://docs.moderntreasury.com/ledgers/docs/digital-wallet-tutorial
- 余额扣减竞态与预占的 TTL 处理 — https://vibe-eval.com/patterns/race-conditions-in-money-paths/

## 15. 落地记录（P1 + P2 已上线）

代码：`worker/src/index.js` 的「额度（credit）」段——`MICRO` / `quotaMode()` / `rateLimitPerMin()` / `periodOf()` / `ensureWallet()` / `loadQuota()` / `computeCost()` / `countRecentRequests()` / `preflight()` / `startRequest()` / `markRequestFailed()` / `settleUsage()` / `tapUsage()` / `rollPeriods()`。旧的 `checkQuota` / `incrQuota` / `addTokens` 已删除，只在 `QUOTA_MODE=count` 时保留 `countQuotaCheck()` / `countQuotaIncr()` 作回滚。

| 项 | 值 |
|---|---|
| 结算公式 | `cost = ceil(input/1000 × price_in) + ceil(output/1000 × price_out) + per_request`，input 含 `cache_creation_input_tokens` |
| 扣减 | 单条 `UPDATE ... WHERE balance_micro >= ?` + `INSERT ... SELECT ... WHERE changes() = 1`，同 `db.batch()` 原子提交 |
| `overage=1` | 允许扣成负数（记欠款）；`overage=0` 最多扣到 0，差额保留在 `cost_micro` 里可查 |
| 幂等 | `request_id` 取 `x-request-id` 头或 uuid；重复且上次成功 → `409`；上次失败 → 允许原 id 重试 |
| 限流 | `RATE_LIMIT_PER_MIN=10`，按 `usage_requests.started_at` 60 秒滑动窗口 |
| 周期 | `[triggers] crons = ["10 0 * * *"]`（UTC 00:10），`rollover=0` 先记 `expire` 再清零后发 `grant` |
| 新接口 | `GET /api/usage?limit=`（最近请求）、`GET /api/ledger?limit=`（流水）；`/api/me` 直接返回 `balance_micro` / `available_micro` |

**本地实测（`wrangler dev --local` + 假上游返回 `input_tokens=1000 / output_tokens=200`）**

| 场景 | 结果 |
|---|---|
| 正常结算 | `cost_micro=4600`，余额 5,000,000 → 4,995,400，`ledger` 一条 `consume -4600` |
| 额度不足 | 余额 0 → `402 {"error":{"message":"额度不足，剩 0.0000 额度"}}` |
| 限流 | 连发 12 次 → 前 10 次 502（假 key），第 11、12 次 `429` |
| 幂等 | 同一 `x-request-id` 发两次 → 200 / 409，只扣一次 |
| 周期发放 | 把 `period_end` 改成过去 → 触发 cron：`expire -4,995,400` → `grant +6,000,000`，余额 6,000,000，`period_end=2026-12-01` |
| 老用户补开户 | 删掉钱包后直接请求 → 自动建钱包（余额 0）→ 402，不报 500 |

**远端状态**

- D1 已建 quota 5 表 + `v_quota` 视图 + 3 个套餐（free / vip / internal），迁移前备份：`db/backup-before-quota.sql`。
- 已部署 Version `6287f163-d93f-475d-b426-98e887bb7c7e`，cron `10 0 * * *` 已注册。
- 线上验证：`/api/me` 返回 `plan=free, balance_micro=0`；`/api/ledger` 有「开户」流水；无 token → 401；余额 0 请求 → 402。
- 存量用户回填：给迁移前已存在的用户按 free 套餐发了当期 6,000,000 micro（`note='首次开户发放'`）。

**待办**：`DEEPSEEK_API_KEY` 仍未配置，真实 200 结算链路只在假上游下验证过；配 key 后需再跑一次线上 200 → 余额下降 → `/api/usage` 有 `cost_micro` 的完整链路。

> 注：上表「老用户补开户 → 余额 0 → 402」是当时的实现；§16 已改成开户即发当期额度。

## 16. A1a 落地记录：上传计量 + 大小闸门（已上线）

**目标**：关掉「上传三免」里的「免额度 / 无 size 预检」，只保留「不落 D1」（文件仍走 DeepSeek Files API，因为模型要 `file_id`）。

**表结构**（`db/quota-a1a.sql`，已并入 `db/quota.sql` 的建表语句）

| 列 | 类型 | 含义 |
|---|---|---|
| `quota_plans.price_per_mb_micro` | INTEGER DEFAULT 1000 | 每 MB 上传单价；0 = 不计费（internal 设为 0） |
| `quota_plans.max_upload_mb` | INTEGER DEFAULT 64 | 单文件上限；free 64、vip 128 |

**Worker 改动**（`worker/src/index.js`）

| 函数 | 作用 |
|---|---|
| `computeUploadCost(plan, bytes)` | `ceil(bytes / 1MB) × price_per_mb_micro`，1 MB 起算 |
| `maxUploadMb(env, plan)` | 套餐优先，`MAX_UPLOAD_MB` 环境变量兜底 |
| `handleUpload(request, env, tokenId)` | 只挂在 `POST /anthropic/v1/files`：① `content-length > limit` → 413（不转发、不记请求）② 走 `preflight`（限流 + 额度，预估按满额 MB）③ `startRequest` 幂等 ④ 流式转发 → 成功后按声明字节 `settleUsage(costMicro)` ⑤ 上游非 2xx → `markRequestFailed` + 502 |
| `settleUsage(..., costMicro)` | 新增可选参数：传了按它扣，不传按 token 算（对话链路不变） |
| `ensureWallet()` | 开户即发当期 `grant_micro`（原先开户 0 额度，新用户要等下个周期，等于不可用） |

**计费口径**

- 有 `content-length`（浏览器 FormData 一定有）：按字节计费，512 KB 记 1 MB → 1000 micro。
- 无 `content-length`（chunked）：按 `per_request_micro` 兜底，避免白嫖。
- 上传被 413 / 402 拒绝：不写 `usage_requests`、不扣费；成功但上游报错的：记 `status=error, cost_micro=0`。

**本地实测**（`wrangler dev --local` + `worker/.smoke/mock2.py`）

| 场景 | 结果 |
|---|---|
| 2 MB 文件、套餐上限 1 MB | `413`，不转发 |
| 512 KB 文件 | `200` + 上游 JSON 原样返回，余额 −1000，`usage_requests.route=/anthropic/v1/files, cost_micro=1000` |
| chunked 上传（无 content-length） | `200`，按 `per_request` 扣 1000 |
| 余额 0 上传 | `402 额度不足`，无流水 |
| 会话分块推送 150 + 50 条 | 两个 PUT 都 `200 {"saved":150/50}`，GET 回来共 200 条 |

**线上**

- 迁移：`db/backup-a1a.sql`（14071 B）→ `db/quota-a1a.sql` 应用成功，三套餐列值正确（free 1000/64、vip 1000/128、internal 0/64）。
- 部署：Version `d1db38c6-bf15-4e30-97f1-8f8a0d7022cd`（含前端 `main.3ab81162.js`）。
- 线上验证：新用户 `/api/me` 余额 6,000,000（开户首期发放生效）；上传 2 KB → `502 upstream 401`（未配 key），`usage_requests` 记 `status=error, http_status=401, cost_micro=0`，余额不变。
- 413 线上未跑（要真实 >64 MB 文件）；逻辑与本地一致。

**运维开关**：紧急关闭上传计费 → `UPDATE quota_plans SET price_per_mb_micro = 0`（不改代码）；紧急放宽上限 → 改 `max_upload_mb` 或 `MAX_UPLOAD_MB`。

