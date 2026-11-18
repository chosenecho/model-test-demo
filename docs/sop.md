# SOP：model-test-demo 运维手册

适用：本仓库的部署、发布、数据变更、排障与回滚。按顺序照做即可，不需要额外判断。

- Worker：`model-test-demo`
- 域名：`aivmz.dpdns.org`（自定义域，静态前端与 API 同域）
- D1：`model-test-demo-db` / `af16a4fb-ed3d-42e3-8a3c-c0f26b84187d`
- Cloudflare 账号：`d04b802998edb84eaa3d83a2feac85a3`（chosenecho@163.com）
- 线上版本与回滚目标见[运维变更记录](CHANGELOG-ops.md)。

当前生产基线已部署 Firecrawl MCP 智能搜索与「行业分析师」，两个开关对新用户默认关闭，用户可在页面自行开启。搜索不走 `deepseek_web_search`；普通对话保留 DeepSeek 的链接阅读工具 `deepseek_read_url`。搜索计数存在 `firecrawl_search_attempts`，额度按用户每天 200 次，建表见 [Firecrawl 迁移](../db/firecrawl.sql)，已建库升级见[按用户额度迁移](../db/firecrawl-peruser.sql)。配置凭据、验收和开关操作按[智能搜索与行业分析师开发及上线 SOP](chat-feature-sop.md)执行。

---

## 0. 前置

| 项 | 要求 |
|---|---|
| Node | ≥ 20（当前 24.16.0） |
| pnpm | ≥ 9（当前 11.21.0） |
| wrangler | 项目内 `npx wrangler`，当前 4.156.0 |
| 登录态 | `cd worker && npx wrangler whoami` 能看到账号 |

`wrangler whoami` 偶发 `The request to Cloudflare's API timed out`，是网络抖动，重跑一次即可，不要改配置。

**Shell 约定**：本文命令按 bash 写（Git Bash / WSL / macOS）。Windows PowerShell 下有两处差异：

- `curl` 是 `Invoke-WebRequest` 的别名，要用 `curl.exe`
- 没有 `grep` / `openssl` / `$(date ...)`，对应换 `Select-String`、下面的 node 单行、`$(Get-Date -Format yyyyMMdd-HHmm)`

---

## 1. 凭据清单

| Secret | 用途 | 缺失后果 |
|---|---|---|
| `AUTH_SECRET` | 邀请码换 Token 的 HMAC 签名 | 登录必失败 |
| `DEEPSEEK_API_KEY` | 上游模型调用 | 聊天报 `upstream 401 ... api key: ****ined is invalid` |

配置：

```bash
cd worker
npx wrangler secret put AUTH_SECRET          # 随机长字符串，生成：node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put DEEPSEEK_API_KEY     # sk- 开头
npx wrangler secret list                     # 核对，只显示名字不显示值
```

改 secret 立即生效，**不需要重新 deploy**。

---

## 2. 首次部署（从零到能聊）

```bash
# 1) 建库（只需一次；已存在会报错，忽略即可）
cd worker
npx wrangler d1 create model-test-demo-db
# 把返回的 database_id 填进 wrangler.toml 的 [[d1_databases]]

# 2) 建表（v2，11 张表）
npx wrangler d1 execute model-test-demo-db --remote --file ../db/schema-v2.sql

# 3) 配密钥
npx wrangler secret put AUTH_SECRET
npx wrangler secret put DEEPSEEK_API_KEY

# 4) 发第一个邀请码
npx wrangler d1 execute model-test-demo-db --remote \
  --command "INSERT INTO invite_codes (code) VALUES ('demo-2026');"

# 5) 构建前端
cd ../web && pnpm install && pnpm build

# 6) 部署（静态站 + Worker 一起）
cd ../worker && npx wrangler deploy
```

`wrangler.toml` 的 `[assets] directory = "../web/dist"` 决定静态站来源，`run_worker_first` 保证 `/api/*`、`/anthropic/*`、`/v1/tools/*`、`/models` 先过 Worker 再谈静态。

---

## 3. 日常发布

先判断改了什么，只跑对应那条。

| 改动 | 命令 | 耗时 |
|---|---|---|
| 只改前端（`web/src/**`） | `cd web && pnpm build` → `cd ../worker && npx wrangler deploy` | ~1 分钟 |
| 只改 Worker（`worker/src/**`、`wrangler.toml`） | `cd worker && npx wrangler deploy` | ~10 秒 |
| 改表结构 | 见第 4 节 | — |
| 改 secret | `wrangler secret put NAME`，无需 deploy | 即时 |

**不要**在 `web/` 里跑 `pnpm build` 之后忘了 deploy——构建产物只是落盘，不 deploy 线上不变。

Windows 注意：`pnpm build` 会走 `node scripts/build.mjs`（已修掉 `rm -rf` / `NODE_ENV=` 前缀的 Unix 写法）。如果看到 `'rm' is not recognized`，说明 `package.json` 的 build 脚本被改回旧版了。

---

## 4. 数据库变更

### 4.1 铁律

1. **先导出再改**，任何远端 DDL 之前都要有备份
2. **先本地跑通**，再上远端
3. 迁移脚本用 `IF NOT EXISTS`，保证可重复执行
4. 有真实用户后禁止 `DROP TABLE`，改成 建新表 → `INSERT INTO ... SELECT` → 校验行数 → `RENAME`

### 4.2 流程

```bash
cd worker

# 1) 备份（文件名自己带日期，bash 用 $(date +%Y%m%d-%H%M)，PowerShell 用 $(Get-Date -Format yyyyMMdd-HHmm)）
npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-20261117-1730.sql
# 偶发 "network connectivity issues" 超时，重试一次即可；成功后文件约 2 KB（空库）

# 2) 本地验证（在 .wrangler/state 里建影子库，不碰线上）
npx wrangler d1 execute model-test-demo-db --local --file ../db/schema-v2.sql

# 3) 远端执行
npx wrangler d1 execute model-test-demo-db --remote --file ../db/schema-v2.sql

# 4) 核对
npx wrangler d1 execute model-test-demo-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### 4.3 v1 → v2 迁移（已执行，留档）

2026-11 已完成线上迁移：`users` 主键改 `token_id`、`quota` 表换成 `usage_daily`、新增 sessions/messages 等表，共 11 张。迁移前备份在 `db/` 下（`backup-before-v2.sql`，空库约 2 KB），一次性迁移脚本用完即删，只剩 `db/schema-v2.sql` 作为唯一真相。

**若要在全新环境重放**，直接跑 4.2 的 `schema-v2.sql` 即可，不需要迁移脚本。只有从 v1 库升级时才需要「先 `ALTER TABLE users RENAME TO users_v1` 再跑 schema-v2」的顺序——因为 `CREATE TABLE IF NOT EXISTS users` 会跳过，新结构建不出来。

**v2 与旧代码的绑定坑**：v2 删了 `quota` 表，`checkQuota`/`incrQuota` 必须已改成读写 `usage_daily`（`requests` 字段），且记账要放在上游返回成功之后，否则 `/api/me` 和每次聊天都会 500。当前代码已是 v2 版本。

---

## 5. 邀请码发放

```bash
cd worker
# 发一个
npx wrangler d1 execute model-test-demo-db --remote \
  --command "INSERT INTO invite_codes (code, note) VALUES ('vip-0001', '给张三');"

# 看还有多少没用
npx wrangler d1 execute model-test-demo-db --remote \
  --command "SELECT code, used_by FROM invite_codes WHERE used_by IS NULL;"

# 作废一个（已发出的 token 仍有效，要立刻断掉得删 users 行）
npx wrangler d1 execute model-test-demo-db --remote \
  --command "DELETE FROM invite_codes WHERE code = 'vip-0001';"
```

规则：一个邀请码只能激活一个用户；Token 30 天，过期后用户拿原邀请码 + 旧 Token 可自助续签（`/api/login` 的 `used_by` 分支）。封人：`UPDATE users SET status='banned'`（v2 表结构下；v1 直接 `DELETE FROM users`）。

---

## 6. 发布后验收

按顺序跑，任何一步不符合就停，别继续发。

```bash
# 1) 首页 200，且引用的 js hash 与本地 dist 一致
curl -s https://aivmz.dpdns.org/ | grep -o 'main\.[a-z0-9]*\.js'
ls web/dist/static/js/main.*.js

# 2) 未鉴权接口应当 401
curl -s -o /dev/null -w '%{http_code}\n' https://aivmz.dpdns.org/api/me      # 401
curl -s -o /dev/null -w '%{http_code}\n' https://aivmz.dpdns.org/models      # 401

# 3) 公开接口 200
curl -s https://aivmz.dpdns.org/api/skills

# 4) 邀请码登录（拿真码换 token）
curl -s -X POST https://aivmz.dpdns.org/api/login \
  -H 'Content-Type: application/json' -d '{"code":"vip-0001"}'

# 5) 用 token 发一条消息，确认是 SSE 流
curl -N -X POST https://aivmz.dpdns.org/anthropic/v1/messages \
  -H "x-api-key: <token>" -H 'Content-Type: application/json' \
  -d '{"model":"x","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"只回复两个字：收到"}]}'

# 6) 额度三条路径：200 时余额下降；余额 0 → 402；1 分钟内 >10 次 → 429
curl -s https://aivmz.dpdns.org/api/me -H "x-api-key: <token>"          # balance_micro
curl -s https://aivmz.dpdns.org/api/usage -H "x-api-key: <token>"       # cost_micro 有值
curl -s https://aivmz.dpdns.org/api/ledger -H "x-api-key: <token>"      # 一条 consume
```

浏览器侧：打开站点 → 设置 → 输邀请码 → 发一句话 → 看流式输出、深度思考开关、智能搜索引用。

冒烟用的临时邀请码用完要删，别留在库里：

```bash
npx wrangler d1 execute model-test-demo-db --remote --command \
  "DELETE FROM usage_requests WHERE user_id='<tid>'; DELETE FROM quota_ledger WHERE user_id='<tid>'; DELETE FROM quota_wallets WHERE user_id='<tid>'; DELETE FROM users WHERE token_id='<tid>'; DELETE FROM invite_codes WHERE code='smoke-xxxxxx';"
```

---

## 7. 排障

| 症状 | 原因 | 处置 |
|---|---|---|
| 首页 200 但白屏 | `web/dist` 没构建，或 index.html 引用的 hash 与静态文件不匹配 | `cd web && pnpm build` 后重新 deploy |
| 静态资源 404，页面骨架在 | 部署时 assets 目录不对 | 检查 `wrangler.toml` 的 `[assets] directory`，确认 `web/dist` 有文件 |
| 输邀请码报 `invalid invite code` | 码不存在，或已被用且没带旧 Token | 查 `SELECT * FROM invite_codes`；续签要带 `token` 字段 |
| 聊天报 `upstream 401 ... api key: ****ined is invalid` | `DEEPSEEK_API_KEY` 没配，转发头是 `Bearer undefined` | `wrangler secret put DEEPSEEK_API_KEY` |
| 聊天报 `upstream 401 ... invalid` 但 key 已配 | key 失效/欠费 | DeepSeek 控制台核对 |
| 402 `额度不足，剩 x 额度` | 钱包余额不够本次预估 | 给该用户补额度（见 `quota-sop.md` §5，必须同时写 `quota_ledger`） |
| 429 `rate limit exceeded (n/min)` | 超过 `RATE_LIMIT_PER_MIN`（默认 10/分） | 等 60 秒；确有需要调 `wrangler.toml` 后 deploy |
| 429 `daily quota exceeded (20/20)` | 只有 `QUOTA_MODE=count` 回滚态才会出现 | 切回 `credits` |
| 403 `quota suspended` | 该用户钱包 `status='suspended'` | 加额度或改 `status='active'` |
| 附件/语音 401 | Token 过期 | 重新输邀请码（带旧 Token 自动续签） |
| `wrangler deploy` 卡住/超时 | CF API 网络抖动 | 重试；连续失败换网络 |
| `pnpm build` 报 `'rm' is not recognized` | build 脚本被改回 Unix 写法 | 恢复成 `node scripts/build.mjs` |
| `wrangler d1 execute` 报 `no such table` | 迁移没跑，或跑到了 local 而非 remote | 加 `--remote` 重跑 schema |

看实时日志：

```bash
cd worker && npx wrangler tail
```

---

## 8. 回滚

```bash
cd worker
npx wrangler deployments list          # 最近 10 次部署
npx wrangler versions list             # 最近 10 个版本
npx wrangler rollback <version-id>     # 回滚到指定版本
```

注意：

- 回滚只回 Worker 代码 + 静态资产，**不回 D1 结构和数据**
- 回滚后如果前端是新版、Worker 是旧版，接口可能对不上——优先整包回滚（代码和 dist 一起）
- 数据要回滚只能靠第 4 节的 `d1 export` 备份，`wrangler d1 import` 恢复
- 只想退回「每日 20 次」的旧逻辑，不必回滚代码：把 `wrangler.toml` 的 `QUOTA_MODE` 改成 `count` 再 deploy（quota 表留着不动）

---

## 9. 密钥轮换

```bash
cd worker
npx wrangler secret put DEEPSEEK_API_KEY   # 覆盖即生效，无需 deploy
```

`AUTH_SECRET` 轮换会让**所有已发出的 Token 立即失效**，用户需要重新输邀请码。轮换前先确认能接受这个影响，或者改代码支持双密钥并行校验（未实现）。

---

## 10. 已知缺陷与待办

| 项 | 说明 |
|---|---|
| **`DEEPSEEK_API_KEY` 未配置** | 唯一阻塞项。不配则聊天必 502，前端只显示「服务器繁忙，请稍后再试」。`wrangler secret put DEEPSEEK_API_KEY` 即可，无需 deploy |
| 同步是分块整包覆盖 | `PUT /api/sessions/:id` 每次推整条会话，由前端按 200 条切块（`PUSH_CHUNK`），2500 ms 防抖；服务端按消息 id upsert，多块相加即全量。单会话上限 2000 条，超过放弃同步 |
| 上传计费依赖 `content-length` | 有则按 `ceil(bytes/1MB) × price_per_mb_micro` 精确扣；chunked 上传没有该头，只能按 `per_request_micro` 兜底计费。单文件上限 free 64 MB / vip 128 MB，超限 413 |
| 多端并发无冲突检测 | 两端同时改同一会话，后推的整包覆盖先推的。没有版本号/乐观锁 |
| 附件只在本地 | 原件在 IndexedDB，`server_file_id` 未持久化，跨设备看不到原图 |
| Skill 无 UI | `skills` 表和 `/api/skills` 保留，chat-demo 前端没有入口；深度思考/智能搜索走服务端工具参数 |
| 无监控 | 只有 `wrangler tail`，没有错误率/延迟告警 |
| 会话标题可能为空 | 前端自动命名未触发时 `title` 是空串，列表里显示「新对话」 |
| 额度没做预占 | `quota_reservations` 表建了但没用；并发请求可能小幅超额，靠结算时 `balance >= ?` 兜底 |
| 额度无前端页面 | `/api/usage`、`/api/ledger` 已就绪，chat-demo 前端还没有「用量/账单」入口 |
| 额度 402 前端文案 | 前端把 402 当普通错误显示「服务器繁忙」，没有「额度不足」提示 |

已修（v2 落地时一并解决，留档）：
- 配额先扣后转 → 两条路径（`/api/chat`、`/anthropic/v1/messages`）都改成上游返回成功后才 `incrQuota`。
- 会话不落库 → v2 同步已上线，`sessions`/`messages` 落 D1。
- `currentUser` 只认 `Authorization: Bearer` → 前端发的是 `x-api-key`，导致 `/api/sessions` 全部 401；改为 `tokenFrom()` 同时认两种头。
- 会话/消息跨用户覆盖 → `putSession` 加 owner 校验（403），消息 upsert 加 `WHERE messages.session_id = excluded.session_id`。
- `thinking`/`search` 的 `null` 被当成 `false` → 改为 `null → undefined`，JSON 里字段消失而不是变「关」。
