# 架构改动 SOP

配套：[架构评审](architecture-review.md) §6 的方案 A · [额度设计](quota.md) · [风险清单](risk-fixes.md)

**适用范围**：A1–A4 这四类架构改动，以及任何动到 `worker/`、`db/`、`wrangler.toml` 的变更。

---

## 0. 先纠正一处设计

评审里写的「A1 上传改前端直传 R2」**不能照字面做**。模型要读文件，`file_id` 必须由 DeepSeek Files API 发，文件本身得在它那儿。所以 A1 拆成两段：

| 编号 | 做什么 | 时机 |
|---|---|---|
| **A1a** | 上传加护栏：Worker 端 size 预检 + `usage_requests` 计量 + 纳入限流。**文件仍走 DeepSeek Files API** | 现在，半天 |
| **A1b** | 文件自托管到 R2、自己解析后喂模型（脱离 Files API 的成本与 100 MB 限制） | 未来，需要 RAG/解析能力时 |

本文的 A1 指 **A1a**。

---

## 1. 通用规约（所有改动都适用）

### 1.1 变更分级

| 级别 | 例子 | 必须做 |
|---|---|---|
| **L1 代码** | 改 `tapUsage` 筛帧、改文案 | 本地跑通 → deploy → 观察 15 min |
| **L2 数据** | 给 `quota_plans` 加列、建 R2 桶 | L1 + `d1 export` 备份 + `--local` 先验 + 逐条执行 |
| **L3 架构** | 上 QuotaDO、迁 Queues | L2 + 特性开关 + 双写/双读校验期 + 回滚演练 |

### 1.2 五条硬规矩

1. **一个 deploy 只做一件事**。A1 和 A2 不能塞进同一次部署——出问题分不清是谁的锅。
2. **动数据先备份**：`npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-$(日期).sql`（偶发超时，重试一次）。
3. **生产 SQL 一律先在 `--local` 跑**：`npx wrangler d1 execute model-test-demo-db --local --file ../db/xxx.sql`。
4. **任何改动都要有开关**：新逻辑默认 `off`，先发代码再翻开关。开关用 `[vars]`（要 deploy 生效）或 D1 里的配置行（立即生效）。
5. **发布后观察 15–30 分钟**：`npx wrangler tail`，重点看 `exceededCpu`、`1101`、`1102`、D1 `overloaded`、5xx 比例。

### 1.3 时间窗

避开用户活跃时段（当前就是你自己，随意）。不做周五下午的 L3 变更。

---

## 2. 变更前检查清单

- [ ] 工作区没有未提交的无关改动（`git status` 只看得到本次要改的文件）
- [ ] `node --check worker/src/index.js` 通过
- [ ] `cd web && npx tsc -p tsconfig.json --noEmit && npx oxlint src` 通过（动了前端才需要）
- [ ] 本地 `wrangler dev --local` 跑通目标路径
- [ ] 这次改动需要的开关名、默认值已想好
- [ ] 回滚方式写进了变更记录（见 §9）
- [ ] 远端备份已导出（L2/L3 必须）

---

## 3. A1a：上传护栏（半天）

> **已完成 2026-11-17**，部署 `d1db38c6`。记录见 [CHANGELOG-ops.md](./CHANGELOG-ops.md) 与 [quota.md](./quota.md) §16。
> 与计划的差异（照实际执行修正）：
> - 没有改 `computeCost()`，另加 `computeUploadCost(plan, bytes)`，`settleUsage()` 用可选 `costMicro` 覆盖——对话链路完全不动。
> - `MAX_UPLOAD_MB` 只是兜底，实际以 `quota_plans.max_upload_mb` 为准（`maxUploadMb()`：套餐优先）。
> - 下面「验收」里伪造 `content-length: 70000000` 的 curl **会挂住**（服务端等不到声明的 body）；实测 413 要改成「临时把套餐 `max_upload_mb` 设成 1，再传一个真实 2 MB 文件」。
> - 附带修复：`ensureWallet()` 开户即发当期额度（原先开户余额 0，新用户要等下个周期，等于不可用）。

### 改动清单

| 文件 | 位置 | 改什么 |
|---|---|---|
| `worker/src/index.js` | `passthrough()`（约 790 行） | files 路由前读 `content-length`，超 `MAX_UPLOAD_MB` 直接 413 |
| `worker/src/index.js` | `proxyAnthropic()` 的 files 分支（约 865 行） | `preflight()` + `startRequest({route:'/anthropic/v1/files'})`，成功后按字节记账 |
| `worker/src/index.js` | `computeCost()` | 增加「按 MB 计价」分支 |
| `db/quota.sql` | `quota_plans` | 加 `price_per_mb_micro`（默认 1000）、`max_upload_mb`（默认 64） |

### 步骤

```powershell
cd C:\WorkSpace\model-test-demo\worker
# 1) 备份 + 本地迁移验证
npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-a1a.sql
npx wrangler d1 execute model-test-demo-db --local --file ../db/quota-a1a.sql   # 新增两列的 ALTER
npx wrangler d1 execute model-test-demo-db --remote --file ../db/quota-a1a.sql
# 2) 代码改动后本地验证
npx wrangler dev --local
# 3) 部署
npx wrangler deploy
```

### 影响范围

- **用户可见**：单个文件上限仍是 64 MB（前端没变），但**上传开始计费**（64 MB ≈ 0.064 额度）。
- **不变量**：`/anthropic/v1/files` 从「免额度」变成「按 MB 扣费」；老客户端无感（不传新参数）。
- **不受影响**：聊天、会话同步、语音。
- **风险**：`content-length` 可能缺省（chunked 上传）→ 缺省时放行并靠上游兜底，不能在这里误拒。

### 验收

```powershell
# 413：伪造一个超大 content-length
curl.exe -s -o NUL -w "%{http_code}\n" -X POST https://aivmz.dpdns.org/anthropic/v1/files `
  -H "x-api-key: <TOKEN>" -H "content-length: 70000000" -H "content-type: multipart/form-data; boundary=x" --data "x"
# 计费：传一个真实 1 MB 文件后
npx wrangler d1 execute model-test-demo-db --remote --command "SELECT route, cost_micro, status FROM usage_requests ORDER BY started_at DESC LIMIT 3;"
```

### 回滚

`UPDATE quota_plans SET price_per_mb_micro = 0;` —— 立即停止计费，代码不用回滚。

---

## 4. A2：额度迁 Durable Object（1 天，L3）

最大的一步。分三个阶段，任一阶段都可停。

### 目标形态

```
Worker ──RPC──> QuotaDO(userId)          # 每用户一个对象，天然串行
                  ├─ storage: balance_micro / reserved / period
                  └─ alarm: 周期发放 & 过期清理
D1 quota_ledger / usage_requests         # 只追加，不做并发写
```

### 阶段 1：影子写（不动读路径）

1. `wrangler.toml` 加 DO 绑定与迁移：

```toml
[[durable_objects.bindings]]
name = "QUOTA"
class_name = "QuotaDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["QuotaDO"]
```

2. 新增 `worker/src/quota-do.js`，实现 `credit(userId, micro, requestId)` / `balance(userId)` / `reset(userId)`，内部用 `storage.transaction()` 保证读改写原子。
3. `settleUsage()` 里**并行**调一次 `env.QUOTA.get(id).credit(...)`，结果只打日志，不影响 D1 结算。
4. **开关**：`QUOTA_BACKEND = "d1"`（默认，读写都走 D1），DO 只影子写。

**观察**：比对每笔 DO 的余额变化与 D1 `quota_ledger` 的 `amount_micro`，差额必须为 0（写一条定时对账 SQL）。

### 阶段 2：双读校验

`QUOTA_BACKEND = "shadow"`：读余额时同时读 DO 和 D1，不一致就 `console.error` 并继续用 D1。

### 阶段 3：切主

`QUOTA_BACKEND = "do"`：额度读写全走 DO，D1 只留 `quota_ledger` 追加（对账用）。周期发放从 `rollPeriods` 挪到 DO 的 `alarm`（每用户自己定闹钟，不再有「一次 cron 处理 250 人」的问题）。

### 影响范围

- **阶段 1/2**：无用户可见影响；多一次 DO 调用（约 1–3 ms）。
- **阶段 3**：余额来源变更。若 DO 数据初始化有误，用户会看到错误余额——所以阶段 2 必须跑满 24 小时、差额为 0 才切。
- **DO 冷启动**：首次访问从 D1 懒加载余额（`SELECT` 最后一次 `balance_after`），必须写对，否则余额归零。
- **成本**：DO 按请求计费，量小可忽略。

### 验收

- 对账：`SELECT` 比对 DO 余额 vs `SUM(quota_ledger.amount_micro)`，全用户在 24 小时内差额恒为 0。
- 并发：同一用户并发 10 个请求，扣费总额 = 10 × 单次成本（不再出现 R6 的免费搭车）。
- 周期：把某用户 `period_end` 改到过去，等 alarm 触发，余额按套餐发放。

### 回滚

`QUOTA_BACKEND = "d1"`，一次 deploy。DO 的数据不删（`deleted_classes` 不要写），保留观察。

---

## 5. A3：消息体外置 R2（半天）

### 触发条件

`content_json` 超过 `BODY_INLINE_MAX`（建议 64 KB）时，把 `blocks` 原文写 R2，行里只存 `{ body_ref: "r2://...", blocks: [] }`。

### 步骤

1. `wrangler r2 bucket create model-test-demo-bodies`
2. `putSession()` 里：序列化后测长度 → 超阈值则 `env.BODIES.put(key, json)` → 落库只存引用。
3. `getSession()` 里：看到 `body_ref` 就 `env.BODIES.get(key)` 取回。
4. 开关：`BODY_EXTERNAL = "off" | "on"`。

### 影响范围

- 读路径多一跳 R2（仅超大消息）。
- 删除会话时要连带删 R2 对象（写 `deleted_at` 时记一份待删列表，或按前缀清理）。
- 历史数据不迁移：老消息仍是内联，新消息才外置——两种形态共存，读取端都要支持。

### 验收

造一条 500 KB 的回答 → `messages.content_json` 长度 < 1 KB 且含 `body_ref`；读回来内容与原文一致。

### 回滚

`BODY_EXTERNAL = "off"`（新写入回到内联），已外置的仍可读（读取端保留两种分支）。

---

## 6. A4：定时任务迁 Queues（半天）

### 步骤

1. `wrangler queues create quota-jobs`
2. `wrangler.toml` 加 producer/consumer 绑定。
3. `scheduled()` 只做一件事：查到期钱包 → 逐个 `send({ userId, action: 'reset' })`（一次最多 100 条/批）。
4. Consumer 处理单个用户，失败自动重试（最多 100 次、保留 14 天）。

### 影响范围

- 发放从「一次 cron 循环」变成「每用户一条消息」→ 天然分批、单点失败不影响其他用户（解决 R4）。
- 多一个队列费用（量小可忽略）。
- **幂等**：consumer 可能重复投递 → 发放前必须检查 `period_end > now` 就跳过（现有逻辑已满足）。

### 验收

- 手工把 3 个用户 `period_end` 改成过去 → 触发 cron → 3 条消息各被消费一次，余额正确、`period_end` 推进。
- 故意让其中一个用户的 `plan_id` 指向不存在的套餐 → 只有它重试，另两个正常。

### 回滚

`CRON_MODE = "direct"`，cron 仍走旧循环。

---

## 7. 数据库迁移规约

| 规约 | 说明 |
|---|---|
| 只做增量 | `ADD COLUMN` 带 `DEFAULT`；不改列类型、不重命名 |
| 可重复执行 | 用 `IF NOT EXISTS` / `IF NOT EXISTS INDEX` |
| 单文件单目的 | 一个 `.sql` 只做一件事，文件名带目的：`quota-a1a.sql` |
| 双向兼容 | 加列后**旧代码必须仍能跑**（新列有默认值）；删列要等两轮发布后 |
| 备份先行 | 每次远端执行前 `d1 export` |
| 分批 | 单条 SQL 影响行数控制在 1,000 以内（D1 单查询 30 s 限制） |
| 回滚方式 | 只加不删的迁移，回滚 = 保留列不用；要真回滚就 `d1 import` 备份 |

---

## 8. 发布与回滚矩阵

| 变更 | 开关 | 出问题时的止血动作 | 彻底回滚 |
|---|---|---|---|
| A1a 上传计费 | `quota_plans.price_per_mb_micro` | 置 0 | `wrangler rollback <上一版本>` |
| A2 QuotaDO | `QUOTA_BACKEND` | 改 `d1` 并 deploy | 同上（DO 数据留着） |
| A3 消息外置 | `BODY_EXTERNAL` | 改 `off` 并 deploy | 同上 |
| A4 Queues | `CRON_MODE` | 改 `direct` 并 deploy | 同上 |
| 通用 | — | `wrangler versions list` → `wrangler rollback <id>` | 回滚只回代码与静态资产，**不回 D1** |

**灰度发布**（L3 建议）：`npx wrangler versions upload` → `npx wrangler versions deploy <version-id>@10%`，观察 30 分钟再 `@100%`。

---

## 9. 变更记录模板

每次改动在 `docs/CHANGELOG-ops.md` 追加一段（没有就新建，一行也写）：

```markdown
## 2026-11-17 20:10 · A1a 上传计费
- 级别：L2
- 改了：worker/src/index.js passthrough/proxyAnthropic/computeCost；db/quota-a1a.sql
- 迁移：ALTER TABLE quota_plans ADD COLUMN price_per_mb_micro INTEGER NOT NULL DEFAULT 1000;（已备份 backup-a1a.sql）
- 开关：quota_plans.price_per_mb_micro = 1000
- 部署版本：<wrangler 输出的 version id>
- 验收：413 通过 / 1 MB 上传 cost_micro=1000 / 余额下降 / 对账 0 差额
- 回滚：置 0 或 rollback <上一版本>
- 观察：tail 15 min，无 5xx 增量
```

---

## 10. 观测指标（每次发布后看这四个）

| 指标 | 怎么取 | 正常值 |
|---|---|---|
| `exceededCpu` / 1102 | `npx wrangler tail` | 0 |
| D1 写量 | `npx wrangler d1 info model-test-demo-db` 的 `rows_written_24h` | 与请求量线性，无异常放大 |
| 对账差额 | `quota.md` §8 的对账 SQL | 空 |
| 402 / 413 / 429 次数 | `usage_requests.status` 分组 | 突变要查原因 |

---

## 11. 禁止事项

1. 不在**同一个 deploy** 里做两件互不相关的事
2. 不跳过 `--local` 直接在远端跑新 SQL
3. 不在工作日高峰做 L3 变更（虽然现在用户只有你）
4. 不把开关做成「只能靠回滚代码」——每个新逻辑必须有运行时可翻的开关
5. 不删 `quota_ledger` / `usage_requests` 的历史行（归档靠导出）
6. 不在没有备份的情况下 `wrangler d1 import`
