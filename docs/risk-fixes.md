# 风险确认与修复计划

确认时间：2026-11-17 · 代码基线：`worker/src/index.js`（已部署 `6287f163`）、`web/src/services/chat/sync.ts`

> 每条风险的平台根因见 [architecture-review.md](architecture-review.md) §3。

**当前线上实际状态**（先把影响范围说清楚）：

| 指标 | 值 | 含义 |
|---|---|---|
| `users` | 1 | 只有 1 个真实用户 |
| `sessions` / `messages` | 1 / 2 | 只有你自己的测试会话 |
| `usage_requests` | 0 | 还没有人真正发过消息扣过费 |
| 附件上传 | 0 | 没人用过上传 |
| Workers 套餐 | **未确认** | Dashboard → Workers & Pages → Plans；这一项决定 R2 是「必现」还是「极端情况」 |

结论：**这些风险目前一条都没有造成实际损失，全部是「一有真实流量就会踩」的潜伏缺陷。** 所以修复窗口很好，现在改是纯收益。

---

## 风险总表

| 编号 | 风险 | 等级 | 影响半径 | 修复量 |
|---|---|---|---|---|
| R1 | 文件上传免额度、免限流、无大小校验 | 高 | 所有登录用户 × DeepSeek 账户成本 | ~35 行 + 1 字段 |
| R2 | `tapUsage` 逐帧 `JSON.parse`，CPU 随输出长度线性涨 | 低（**实测后降级**：Free 仅超长输出 / Paid 可忽略） | 单轮输出 >1.5 万 token 的用户 | ~4 行 |
| R3 | 会话同步上限不一致（客户端 500 / 服务端 200） | 中 | 消息数 >200 的会话 | ~4 行 |
| R4 | `rollPeriods` 无分批、无逐用户容错 | 中 | 用户数 >250 后；或任意一条坏数据 | ~15 行 |
| R5 | `usage_requests` 的 `pending` 无兜底清理 | 中 | 每个被中断/被打死的请求 | ~10 行 + 1 段 cron |
| R6 | 并发请求可小幅超额（无预占） | 低 | 同一用户 10 秒内并发 | 设计上接受，不改 |
| R7 | 402 额度不足在前端显示成「服务器繁忙」 | 低 | 所有额度耗尽用户 | ~10 行前端 |

---

## R1 文件上传是「三免」写入口

**证据**

- 前端限制只在浏览器侧：[attachments.ts](../web/src/services/attachments.ts#L13-L18) —— 单文件 64 MB（`user_data` 32 MB）、最多 50 个、并发 3。
- Worker 端**纯流转发、零校验、零记账**：[index.js:790-795](../worker/src/index.js#L790-L795) `body: request.body`；[index.js:865-866](../worker/src/index.js#L865-L866) Files API 直接 `passthrough`，既不经过 `preflight()`（限流/额度），也不写 `usage_requests`。
- `attachments` 表建了但没有任何写入路径。

**触发条件**：任何持有有效 Token 的人，用 `curl` 直接 `POST /anthropic/v1/files`。

**影响范围**

1. **成本**：单个用户可以往 DeepSeek Files API 塞 50 × 64 MB = 3.2 GB 文件，`quota_ledger` 里一条记录都没有。额度体系对上传完全失效。
2. **绕过速率限制**：`RATE_LIMIT_PER_MIN=10` 只作用于 `/anthropic/v1/messages`，files 路由不受限，可以无限刷上传。
3. **边缘 413 浪费**：前端 64 MB 是客户端校验，直接调接口可以传更大，一直传到 Cloudflare 100 MB 请求体上限才被拒——中间那 36 MB 白占出站带宽和上游额度。
4. 不影响 D1、不影响 Worker 内存（流式透传，不缓冲）。

**修复**

1. `passthrough` 前读 `content-length`：`/anthropic/v1/files` 超过 64 MB（可配 `MAX_UPLOAD_MB`）直接 `413`，避免把无效流量打到上游。
2. files 路由纳入计量：`startRequest({route:'/anthropic/v1/files'})` + 成功响应后写一条 `usage_requests`（`cost_micro = ceil(bytes / 1MB) × price_per_mb_micro`），并从 `quota_wallets` 扣。
3. `quota_plans` 增加 `price_per_mb_micro`（默认 1000，即 1 MB = 0.001 额度）与 `max_upload_mb`（默认 64）。
4. files 请求也走 `countRecentRequests` 的 60 秒窗口（把限流检查抽成两处共用）。

**修复后影响**：上传开始扣费，单个 64 MB PDF 约 64,000 micro（0.064 额度）。免费版 6 额度 ≈ 93 个满额 PDF。需要同步在 `docs/quota.md` / SOP 的价格表里加一行。

**验收**：`curl` 传一个 70 MB 文件 → 413；传 1 MB → `usage_requests` 出现 `route='/anthropic/v1/files'` 且 `cost_micro≈1000`，余额下降 1000。

**状态：已修复（A1a，2026-11-17 上线 Version `d1db38c6`）**。实现见 §16 of [quota.md](./quota.md)：`handleUpload()` 做 413 闸门 + `preflight` + `settleUsage(costMicro)`，`quota_plans` 增 `price_per_mb_micro` / `max_upload_mb`。实际差异：**限流没有"抽成两处共用"，而是复用 `preflight`**——上传和对话走同一个 `countRecentRequests` 60 秒窗口，效果等价。本地验收：2 MB→413、512 KB→200 扣 1000、chunked→按 `per_request` 扣、余额 0→402；线上：新用户上传 2 KB → 502（缺 key）+ `usage_requests` 记 `status=error, cost_micro=0`。线上 413 未跑（需 >64 MB 真实文件）。

---

## R2 `tapUsage` 逐帧解析 → CPU 1102

**证据**：[index.js:255-274](../worker/src/index.js#L255-L274) —— 每收到一个 chunk 就 `buffer.split('\n\n')`，再对每个 `data:` 行 `JSON.parse(raw)`。一次普通回答（2k token）会产生上千帧，全部解析。

**实测（Node 24 / V8，与 workerd 同引擎，单帧 140 字节）**

| 场景 | CPU |
|---|---|
| 5000 帧全量 `JSON.parse` | **2.29 ms** |
| 5000 帧只做 `includes('"usage"')` 筛选 | 0.21 ms |
| 筛后再解析（2 帧） | 0.74 ms（含数组拷贝开销） |
| 另外测：0.44 MB 会话 JSON `JSON.parse`（200 条消息） | 0.26 ms |

**先修正我上一条给的估算**：之前说「千 token 回答 5–15 ms」，实测是 **0.9 ms 左右**，差了约 10 倍。逐帧解析的成本约 **0.46 µs/帧**。

**影响范围（按预算倒推）**

- **Paid（默认 30 s CPU）**：要撞线需要约 **6500 万帧**（≈6500 万 token 的单轮输出）。现实里不存在，**这条风险在 Paid 下可以视为零**。
- **Free（10 ms CPU）**：扣掉鉴权、路由等基础开销，留给解析的大约 7–8 ms → 约 **1.5 万帧**，也就是单轮 1.5 万 token 以上的连续输出（超长深度思考、整本书续写）才可能撞。普通问答不会。
- 撞线后果：`1102`，客户端流截断，且这次请求结算丢失（见 R5）。
- 不影响其他用户（每请求独立 isolate）。

**所以「换套餐也只有 30s」这个担心是反的**：30 s 是 CPU 预算，不是流的时长；我们这条路 CPU 消耗是毫秒级，30 s 相当于 1 万多倍余量。真正的时长天花板只有一个——**上游 100 秒还不返回响应头**，那是 Cloudflare 的 524 规则；只要响应头回来了，SSE 就能一直流，10 分钟的回答也没问题。

**修复**：解析前先做字符串筛选，把「每帧解析」降为「每轮 2 帧」：

```js
for (const frame of frames) {
  if (!frame.includes('"usage"')) continue          // 99% 的正文帧直接跳过
  for (const line of frame.split('\n')) { ... }
}
```

**修复后影响**：只影响计量准确性（usage 仍从 `message_start`/`message_delta` 取，语义不变），不改变任何对外响应。实测从 2.29 ms 降到 0.21 ms，约 10 倍；配合 Paid 套餐，这条彻底归零。

**验收**：本地 mock 上游返回 2000 帧正文 + 2 帧 usage，对账 `cost_micro` 不变，`wrangler tail` 无 `exceededCpu`。

---

## R3 会话同步上限不一致

**证据**

- 客户端：[sync.ts:16](../web/src/services/chat/sync.ts#L16) `MAX_MESSAGES = 500`，[:137](../web/src/services/chat/sync.ts#L137) 超过才跳过推送。
- 服务端：[index.js:658](../worker/src/index.js#L658) `messages.length > 200` 直接 `413`。

**触发条件**：会话消息数在 201–500 之间时触发推送。

**影响范围**

- 该会话**永远同步不上去**，服务端返回 413，而 `sync.ts` 的 `warn` 只写 console——**用户完全无感**。
- 后果是「本地有、云端没有」，换设备/清缓存后这段历史永久丢失。已同步过的旧版本仍在服务端，不会回滚丢数据。
- 只影响长会话（>200 条消息，约 100 轮对话），不影响新会话。
- 不产生额外 CPU/D1 压力（请求被提前拒掉）。

**修复**：把两处统一到 200（服务端是 D1 单次 batch 与请求体大小的实际约束，改服务端风险更大），同时把 413 当「可重试但需裁剪」处理：客户端超过 200 条时只推**最近 200 条**，并在 console 明确打出「已截断」。被截掉的老消息不参与同步，服务端 `parent_id` 会出现悬空引用——`messages` 表没有外键约束，可以容忍，读出时按「找不到父节点就按线性列表渲染」处理。若确实要全量同步，就得改成分页 push（P2，见下）。

**修复后影响**：长会话的云端副本变成「最近 200 条」——比现在「一条都没有」好，但仍是部分同步。需在 `docs/sop.md` 已知缺陷里写明这个上限。

**验收**：造一个 250 条消息的会话 → 服务端 `session.messageCount = 200`，无 413 日志。

**状态：已修复，且比原方案更进一步（2026-11-17，Version `d1db38c6`）**。没有采用「截断到最近 200 条」，改成**分块推送**：`sync.ts` 的 `PUSH_CHUNK = 200`，把一次会话按 200 条切片，顺序发多个 `PUT /api/sessions/:id`。因为服务端是「按消息 id upsert + 更新会话行」，多块相加就是全量，不丢老消息、不出现悬空 `parent_id`。客户端 `MAX_MESSAGES` 提到 2000（总量护栏，超过放弃同步，避免几十个请求）。实测：150 + 50 两块推送，`{"saved":150}` / `{"saved":50}`，GET 回来 200 条。

---

## R4 `rollPeriods` 无分批、无逐用户容错

**证据**：[index.js:296-320](../worker/src/index.js#L296-L320) —— `SELECT ... FROM quota_wallets WHERE period_end <= ?` 全表取回，`for` 循环里 `await env.DB.batch(statements)`，**没有 LIMIT、没有 try/catch**。

**触发条件**：① 用户数 × 4 条 SQL 超过单次调用 1000 query 上限（约 250 人）；② 任意一个用户的 batch 抛错。

**影响范围**

- 用户数 >250：超出的用户**这一轮不发额度**，且没有任何报错提示（cron 日志里只有一条失败）。用户表现为「周期到了但余额还是 0」，全部请求 402。
- 单个坏数据（例如 `plan_id` 指向已删除的套餐——代码里 `continue` 已挡住）或其他 SQL 错误：**后续所有用户都不发**，中断点之后的用户静默欠额度。
- cron 只有每天 00:10 一次，失败要等 24 小时；没有重试、没有告警。
- 影响的是「发放」，不影响已扣费用和流水一致性。

**修复**

1. `... LIMIT 200`，外层 `while` 循环直到查不到为止（受单次 1000 query 限制，实际每次最多 200 人 × 4 = 800 条，安全）。
2. 每个用户单独 `try/catch`，失败记 `console.error({userId, error})` 后继续下一个。
3. 剩余到期的用户留给下一次 cron（10 分钟粒度的话要改 `crons = ["*/10 * * * *"]`，或用 `waitUntil` 递归，不推荐）。

**修复后影响**：发放变成「可续跑、单点失败不影响整体」。多跑几次不会重复发（`period_end` 推进后不再命中）。

**验收**：本地造 3 个到期钱包，第 2 个塞一条必错的 SQL → 第 1、3 个正常发放，日志有 1 条 error，`period_end` 都推进。

---

## R5 `pending` 请求无兜底

**证据**：[index.js:170-186](../worker/src/index.js#L170-L186) `startRequest` 先插 `status='pending'`；只有 [index.js:199-244](../worker/src/index.js#L199-L244) `settleUsage` 才会改成 `ok`。中途被打死（1102 / 客户端断开 / 上游半途断流）时，`settleUsage` 可能压根没执行。

**触发条件**：任何一次被中断的请求。

**影响范围**

- `usage_requests` 里留下永久 `pending` 行：`/api/usage` 会一直显示「进行中」，无法区分「卡死」和「正在跑」。
- **账目空洞**：这次上游的 token 已经消耗了，但一分钱没扣。频率与「被打死的请求数」成正比。
- `pending` 行还会占着 60 秒限流窗口（因为 `started_at` 已落库），影响很小但存在。
- 不影响已有余额的准确性（没扣就没扣，不会算错）。

**修复**

1. `scheduled()` 里加一步 `sweepStaleRequests(env)`：`UPDATE usage_requests SET status='aborted', ended_at=? WHERE status='pending' AND started_at < ?`（10 分钟前），并把对应 `cost_micro` 按 `per_request_micro` 补记（可选，建议只标记不补扣，避免误扣）。
2. `settleUsage` 外层再包一层 `try/catch`，失败时也把 `status` 改成 `error`，避免「静默 pending」。

**修复后影响**：只影响统计口径（多出 `aborted` 状态），前端 `/api/usage` 需要认这个状态（现在直接透传，无需改）。

**验收**：手工插一条 20 分钟前的 pending 行 → 触发 cron → 变成 `aborted`。

---

## R6 并发请求可小幅超额（接受，不改）

同一用户在 60 秒窗口内并发 10 个请求，`preflight` 都读同一个余额，都放行；结算时 `WHERE balance_micro >= ?` 只让余额够的那几个扣成功，其余的扣 0（等于免费）。

- 上界 = `RATE_LIMIT_PER_MIN`（10 次）× 单次成本，约几分钱。
- 真正的解法是 `quota_reservations` 预占（表已建好，代码未接），属于 P3。
- **本次不改**，只记录：若要防，先接预占，再谈并发。

---

## R7 402 在前端显示成「服务器繁忙」

**证据**：chat-demo 的错误分类里没有 402 分支，`apiErr` 返回的 `{error:{message}}` 会被当成普通服务端错误，落到「服务器繁忙，请稍后再试」文案。

**影响范围**：所有额度耗尽的用户。他们看到「稍后再试」，实际需要的是「等下月发放 / 找管理员加额度」。属于体验问题，不影响资金正确性。

**修复**：`web/src/i18n/*.ts` 加一条 `quotaInsufficient` 文案；在 `services/api/errors.ts` 的分类里，`status === 402` 归到新类别 `quota`，`ChatInput` 的报错展示走新文案。约 10 行。

**验收**：余额置 0 后发消息，界面显示「额度不足」，而不是「服务器繁忙」。

---

## 修复批次与顺序

| 批次 | 内容 | 为什么这个顺序 | 预估 |
|---|---|---|---|
| **B2（已上线）** | R1 上传校验与计费 + R3 上限统一 | 需要动 `quota_plans` 字段（D1 迁移）与前端同步逻辑；这是目前唯一有「成本无上界」的一条 | 已完成 2026-11-17 |
| **B1（待做）** | R5 兜底 + R4 分批容错 + R2 筛帧（顺手一行） | 全是纯后端、不改变外部语义、一次 deploy 生效。R2 实测后已降级，不再紧急，但改动只有一行，一并带上 | 40 分钟 |
| **B3（可选，待做）** | R7 文案 | 纯前端，要重新 build + deploy | 30 分钟 |
| P3（暂不做） | 预占 / 分页全量同步 | 复杂度高，等有真实长会话再说 | — |

**进展**：B2 已上线（Version `d1db38c6-bf15-4e30-97f1-8f8a0d7022cd`）——R1、R3 关闭，附带修了「新用户开户 0 额度」的阻断性缺陷（`ensureWallet` 改为开户即发当期额度）。B1、B3 仍待做，顺序不变（R4 > R5 > R2 > R7，按实际影响重排）。

**优先级重排（按实测证据）**：R1（成本无上界）> R3（数据静默丢失）> R4（发放中断）> R5（账目空洞）> R2（实测可忽略）> R7（体验）。

**部署影响范围（B1+B2 合计）**

- 一次 `wrangler deploy` 推送 Worker；静态资产不变（除 B3）。
- 对调用方**破坏性变化**：无。唯一行为变化是「上传开始扣费」和「超 64 MB 上传返回 413」。
- 需要一次 D1 迁移：`ALTER TABLE quota_plans ADD COLUMN price_per_mb_micro INTEGER NOT NULL DEFAULT 1000;` + `max_upload_mb`。可增量、可回滚（留默认值即等价于旧行为，只要再把上传计费开关关掉）。
- 回滚路径：`wrangler rollback <上一版本>`；若只是上传计费出问题，把 `quota_plans.price_per_mb_micro` 设为 0 即可止血，无需回滚代码。
- 建议顺序：先 B1 部署并观察一天 `wrangler tail`（重点看 `exceededCpu`、`aborted`），再上 B2。

---

## 需要你确认的两件事

1. **Workers 套餐**（Free / Paid）。这一步决定 R2 的真实严重度：Free 下它是「必现故障」，Paid 下只是「极端长文才可能」。查询：Cloudflare Dashboard → Workers & Pages → Plans。
2. **上传要不要计费**。如果上传只给内部人用，可以只做「大小预检 + 限流」，不做扣费（工作量减半）；如果对外开放，就必须计费，否则 R1 的成本敞口没有上界。
