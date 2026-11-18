# 运维变更记录

格式见 [change-sop.md](./change-sop.md) §9。只记会影响线上行为的改动。

---

## 2026-11-18 14:34 · 真实 Firecrawl 验收与试用发布

- 测试站写入真实的 `FIRECRAWL_API_KEY`。用[真实 MCP 探测脚本](../worker/.smoke/firecrawl-live.mjs)确认 MCP 握手、鉴权和 `firecrawl_search` 返回，一次查询返回 5 条公开结果。
- 修一处工具循环缺陷：首轮用完本轮两次检索后，模型会尝试调用未声明的抓取工具，并把工具调用文本写进正文。现在系统提示词声明只有 `firecrawl_search`、没有抓取正文的工具；次数用满时在工具结果后附加「基于已有结果作答」的提示并禁用工具。改动见 [chat-config.js](../worker/src/chat-config.js) 与 [chat-loop.js](../worker/src/chat-loop.js#L214)，集成测试新增「一轮两次检索」用例。
- 测试站真实链路 `live-search-efb089a405ab`：两次检索、10 条结果，正文按摘要作答并逐条标注来源，响应中无密钥；用量 `settled|1232|789|200`，额度流水 1 行。验收版本 `656d6bea-690b-4213-b2cc-6aff077f9972`，随后部署关闭开关的 `88fab523-6923-4ebc-b4d2-46494a7fdfd2`。
- 生产站写入 `FIRECRAWL_API_KEY`，部署 `b9cf8bf1-20c4-43bf-8041-327fdc6165c1`（两个开关关闭）作为回滚基线。对验收账号启用后 `prod-live-4a8fbc759eec`：两次检索、来源可追溯、无密钥，用量 `settled|1279|798|200`，额度流水 1 行，版本 `4cdb79f9-8129-4793-82d8-8f9e144d113c`。
- 试用发布：`8deadad0-2e69-4dfe-9f06-b8dfd9c24fe8` 对全部用户开放两个功能，开关仍在页面上默认关闭。新账号复核 `chat_features {industry_analyst:true, smart_search:true}`，普通对话仍返回 200 且不触发搜索。临时邀请码已过期，验收会话已注销。
- 搜索额度维持全站共享每日 200 次、按香港日期切分。该密钥在本会话出现过明文，建议在 Firecrawl 控制台轮换后重写 Secret。

---

## 2026-11-18 14:08 · 搜索失败与停止验收

- [Worker 集成测试](../worker/.smoke/chat-feature.test.mjs)用模拟 MCP 覆盖空结果、鉴权失败和用户停止。前两种情况均正常结束回复，鉴权失败响应中的凭据未进入浏览器事件或模型续轮。停止时已发送的正文可读，进行中的搜索收到取消信号，Worker 未发起模型续轮。
- 三种情况均保留一次已发出的搜索计数，模型用量只结算一次。复核时测试 Worker 仅配置了 DeepSeek Secret，真实 Firecrawl 验收待配置 `FIRECRAWL_API_KEY`。操作见[开发及上线 SOP](chat-feature-sop.md#1-准备环境)。

---

## 2026-11-18 13:54 · 独立测试环境与 Skill 验收

- [测试站](https://model-test-demo-test.jiqimao123456.workers.dev)使用独立 Worker 和 D1。已初始化会话、用量与搜索计数表，并配置 `DEEPSEEK_API_KEY`。远端操作使用[测试配置](../worker/wrangler.test.toml)。
- 仅向测试账号启用「行业分析师」。普通对话与启用 Skill 的对话都从真实 DeepSeek 收到完整 SSE，启用时返回 `industry-analyst@1`。两个请求 `stage-skill-a46bdfba-19cd-4fe7-aff8-c497db2830fe` 和 `stage-skill-8d5403a6-b8bc-4bf0-9179-2bf3b701158b` 各结算一次，搜索计数为 0。
- 测试 Worker 从 `f540f8f2-5e96-4c7c-a6dd-02cb33e0ec35` 回滚到 `e564b96f-6b49-481b-bdf6-24a4f28f94b5`。已核对两个功能均关闭，并注销验收会话、过期临时邀请码。
- 对测试站前端使用模拟 API 做浏览器验收。Skill 默认关闭，开启后随回复保存版本。刷新页面后恢复原会话设置，全新的浏览器环境也能通过会话同步恢复。
- [Workers 运行时测试](../worker/.smoke/chat-runtime.cjs)用模拟上游验证搜索续轮、结算和重定向。将本地 D1 当日计数预置为 199 后，两名测试用户并发只发出一次搜索调用，计数停在 200。另一名用户收到额度提示，仍能获得完整回复。
- 真实搜索仍待测试 Worker 配置 `FIRECRAWL_API_KEY`。操作见[开发及上线 SOP](chat-feature-sop.md#1-准备环境)。

---

## 2026-11-18 13:38 · 修复 Worker 对话出站请求

- 线上普通对话返回 502。Workers 运行时只支持 `redirect: 'follow'` 和 `redirect: 'manual'`。DeepSeek 对话和 Firecrawl MCP 请求改用 `manual`，由 Worker 按 HTTP 状态处理上游响应，避免携带鉴权头跟随重定向。
- 生产版本 `67fd9f7d-e828-4f1c-aac8-3032f53634ef` 已上线。智能搜索和行业分析师均关闭。基线版本 `75f8c996-5adf-4732-bfe8-22516b9c0f1b` 和诊断版本 `003ca8f1-6bbb-40dc-81e8-fa99ef6334c0` 均存在本次 502 问题。
- 已配置生产 `DEEPSEEK_API_KEY`。验收账号登录后，真实 DeepSeek 对话返回 200 并收到完整 SSE 结束事件。D1 中请求 `accept-fixed-56079ac363d5` 已结算，只有一条扣费流水，预占余额归零。验收会话已注销，临时邀请码已过期。
- 16 项本地 Worker 测试通过。隔离的本地 Workers 运行时和 D1 使用模拟模型和 MCP，通过登录、搜索续轮和汇总结算验证。真实 DeepSeek 在开启和关闭深度思考时均完成工具调用、模拟搜索结果回填和两轮用量采集。
- Firecrawl 测试占位值已从生产 Secret 删除。真实 MCP 搜索验收待测试环境配置有效凭据后继续，按[开发及上线 SOP](chat-feature-sop.md)执行。

---

## 2026-11-18 13:10 · 智能搜索和行业分析师基线发布

- 级别为 L3。Worker 已部署服务端提示词组装、Firecrawl MCP 工具循环及多轮结算。前端通过 `/api/me` 获取当前会话可用的功能。发布流程见[开发及上线 SOP](chat-feature-sop.md)。
- 生产 D1 已应用[搜索计数迁移](../db/firecrawl.sql)。迁移前导出了 `model-test-demo-db-chat-20261118-130420.sql`，备份大小为 32,426 字节。
- 基线 Worker 发布版本为 `75f8c996-5adf-4732-bfe8-22516b9c0f1b`。智能搜索和行业分析师均关闭。发布前版本为 `5bd458e4-35be-4bad-adbc-396d5316f026`。新增计数表与该版本兼容。
- 发布前 16 项 Worker 本地测试通过，前端类型检查、Lint 和构建通过。发布后首页引用新版脚本，脚本返回 200，未登录的 `/api/me` 和 `/models` 均返回 401。用浏览器加载线上构建，并模拟功能状态接口，验证开关的四种组合及旧接口兼容行为。初检时搜索计数及发布后的待对账请求均为 0。
- 真实模型与 MCP 搜索仍待验收。生产当前只配置了 `AUTH_SECRET`，后续需通过 Worker Secret 配置 `DEEPSEEK_API_KEY` 和 `FIRECRAWL_API_KEY`，在测试环境跑通真实链路后再按试用名单启用。

---

## 2026-11-18 11:15 · S1 安全边界闭合 + S2/S3 迁移上线

- 级别：L3（含库结构变更与凭证模型变更）
- 改了：
  - `worker/src/core.js`（新）：会话签发/校验、邀请码摘要、登录限流、预占→结算→回收→对账
  - `worker/src/index.js`：白名单上游路由（`/models`、`/anthropic/v1/messages`、`/anthropic/v1/files`）；Cookie 会话；每用户文件归属；同源写保护；`QUOTA` 预占后调用上游
  - `worker/wrangler.toml`：`UPLOAD_RATE_LIMIT_PER_MIN = "20"`、`run_worker_first` 增加 `/anthropic/*`
  - `db/hardening.sql`（新）：A 新表 / B 增量列 / C 邀请码重建 / D 对账查询 / E 运行期开关
- 迁移（远端 D1，已执行）：
  - 备份 `db/backup-pre-hardening.sql`（14,297 B，执行前）
  - A+B 段：`auth_sessions`、`login_attempts`、`file_objects`、`app_settings`；`usage_requests.reserved_micro` / `reconcile_reason`；`invite_codes.code_hash`
  - C 段：新表 `invite_codes_new` 灌入 10 个新码 → `DROP TABLE invite_codes; ALTER TABLE invite_codes_new RENAME TO invite_codes;`
  - **旧邀请码全部作废**，明文新码在 `db/invite-codes-1794970566171.txt`（1 个已用，9 个未用；该文件不入库）
- 开关：`app_settings.new_upstream_calls`（deny = 停流 503）、`app_settings.upstream_daily_budget_micro`（0 = 不限）；两者改一行即生效，不需 deploy
- 部署版本：`5bd458e4-35be-4bad-adbc-396d5316f026`
- 验收（`worker/.smoke/live_smoke.py`，线上 16/16）：
  - 无 Cookie `/api/me` → 401；登录下发 `HttpOnly; SameSite=Lax; Secure` Cookie，响应体无 token
  - 带 Cookie `/api/me` → 200；`PUT/GET/DELETE /api/sessions/*` 往返正常；跨站 `Origin` 写 → 403
  - 未登记路径 `/v1/tools/asr` → 404（不到上游）；上传 `/anthropic/v1/files` → 502 上游 401（`DEEPSEEK_API_KEY` 未配置，属预期）
  - 错码登录 → 401 后转 429（`login_attempts` 生效）；`/api/logout` → 200，随后 `/api/me` → 401
  - 本地回归：`worker/.smoke/ledger_case.py` 8/8、`file_case.py` 7/7、`login_case.py` 6/6
- 回滚：`npx wrangler rollback 0035a40b-b860-4aaa-8f46-df24251c42c5`（旧 Worker 读不到 `code_hash`，需同时恢复 `db/backup-pre-hardening.sql` 的 `invite_codes`）；止血可先 `new_upstream_calls='deny'`
- 观察：`usage_requests` 里 `status='reconcile_required'` 数量应为 0；`reserved` 滞留超过 3 分钟说明 sweep 未跑
- 遗留：`DEEPSEEK_API_KEY` 仍未配置，上传与对话的成功计费链路只在假上游验证过；`/v1/tools/*`（ASR/TTS）仍未登记路由

---

## 2026-11-17 20:10 · A1a 上传计费 + R3 分块同步

- 级别：L2
- 改了：
  - `worker/src/index.js`：新增 `handleUpload()` / `computeUploadCost()` / `maxUploadMb()`；`settleUsage()` 新增 `costMicro` 可选参数；`ensureWallet()` 改为开户即发当期额度
  - `worker/wrangler.toml`：新增 `MAX_UPLOAD_MB = "64"`（兜底）
  - `web/src/services/chat/sync.ts`：`PUSH_CHUNK = 200` 分块推送，`MAX_MESSAGES` 500 → 2000
  - `db/quota-a1a.sql`（新）、`db/quota.sql`（建表语句同步加两列）
- 迁移：`ALTER TABLE quota_plans ADD COLUMN price_per_mb_micro INTEGER NOT NULL DEFAULT 1000;` + `max_upload_mb INTEGER NOT NULL DEFAULT 64;`（执行前备份 `db/backup-a1a.sql`，14071 B）
- 开关：`quota_plans.price_per_mb_micro`（置 0 = 关闭上传计费，不用回滚代码）；`max_upload_mb` / `MAX_UPLOAD_MB`
- 部署版本：`0035a40b-b860-4aaa-8f46-df24251c42c5`（A1a + R3）→ `d1db38c6-bf15-4e30-97f1-8f8a0d7022cd`（补「开户发额度」修复）
- 验收：本地 2 MB→413、512 KB→200 且 `cost_micro=1000`、chunked→按 `per_request` 扣、余额 0→402、150+50 分块推送共 200 条；线上新用户 `/api/me` = 6,000,000、上传 2 KB→502（缺 key）且 `usage_requests` 记 `status=error, cost_micro=0`
- 回滚：`quota_plans.price_per_mb_micro = 0` 止血；或 `npx wrangler rollback 6287f163-d93f-475d-b426-98e887bb7c7e`
- 观察：`wrangler tail` 15 分钟，看 5xx 增量与 `error_code=upstream`
- 遗留：线上 413 未实测（需 >64 MB 真实文件）；`DEEPSEEK_API_KEY` 仍未配置，成功上传扣费链路只在假上游验证过
