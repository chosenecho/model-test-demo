# 架构说明

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 静态前端 | `web/dist`（Worker Static Assets） | deepseek-ai/chat-demo 改造版：多会话、流式输出、深度思考、智能搜索、附件、语音、邀请码登录 |
| Worker 代理 | `worker/`（Cloudflare Workers，`aivmz.dpdns.org`） | 唯一持有 API Key 的地方；鉴权、配额、model 覆盖、DeepSeek API 同源反代 |
| D1 | `db/schema-v2.sql` | users / invite_codes / sessions / messages / attachments / usage_daily / search_cache / search_log / tool_calls / provider_keys / skills 共 11 张表 |

## 请求流

1. 设置里输入邀请码 → `POST /api/login` → 校验邀请码、建用户、返回 30 天 HMAC Token（已用邀请码 + 持有旧 Token 可续签）
2. chat-demo 同源请求 `/anthropic/v1/messages`、`/anthropic/v1/files`、`/v1/tools/asr|tts`、`/models`，凭证为 Token（`x-api-key` 或 `Authorization`）
3. Worker：验 Token → （messages）限流 10 次/分 + 额度预检（余额不足 402）→ **强制覆盖 model 字段**（`wrangler.toml` 的 `MODEL`，当前 `deepseek-flash`）→ 注入 DeepSeek API Key 转发，SSE 原样透传 → 旁路解析 `usage` 按真实 token 结算扣费
4. chat-demo 前端解析 SSE：正文、深度思考、搜索引用（`deepseek_web_search` / `deepseek_read_url` 工具事件）逐块渲染

## 路由总览（Worker）

| 路径 | 处理 |
|---|---|
| `/`、`/static/*` | 静态资产（`web/dist`） |
| `POST /api/login` | 邀请码换 Token（支持过期续签） |
| `GET /api/me` | 我的额度（`plan` / `balance_micro` / `available_micro` / `period_end` / `status`） |
| `GET /api/usage`、`GET /api/ledger` | 最近请求记录、额度流水 |
| `GET /api/skills` | Skill 列表（保留，前端暂未用） |
| `POST /api/chat` | 旧版 OpenAI 风格聊天接口（保留兼容） |
| `GET /models` | 透传（鉴权） |
| `/anthropic/v1/messages` | 透传 + 限流 + 额度结算 + model 覆盖（SSE） |
| `/anthropic/v1/files` | 上传：`content-length` 闸门（超限 413）→ 限流/额度预检 → 流式透传 → 按 MB 计费 |
| `/v1/tools/*` | 透传（鉴权，语音） |

## 安全模型

- API Key 仅存于 Worker secret（`wrangler secret put DEEPSEEK_API_KEY`）
- 客户端传入或写死的 `model` 一律被服务端覆盖，模型选择不可伪造
- Token 无状态（HMAC-SHA256 签名 + 过期时间），签名校验不查库，用户存在性以 D1 为准（可随时封禁）
- 额度在转发前预检、上游成功后才结算扣费（失败请求只落 `usage_requests.status='error'`，不扣费）
- 深度思考 / 智能搜索等能力开关由用户在设置里控制，响应参数原样透传

## 额度

按套餐计费，金额单位 micro（1 额度 = 1,000,000 micro），默认 free 每月 6,000,000 micro。

- 单价在 `quota_plans` 表：`price_in_micro` / `price_out_micro`（每 1K token）+ `per_request_micro`（每请求底价）
- 结算：`cost = ceil(input/1000×price_in) + ceil(output/1000×price_out) + per_request`
- 限流：`RATE_LIMIT_PER_MIN`（默认 10）按 `usage_requests` 60 秒滑动窗口
- 周期：cron `10 0 * * *` 发放/过期；余额与流水同 batch 原子写入
- 开关：`QUOTA_MODE=credits|count|off`（count 为旧每日 20 次，回滚用）

详见 [quota.md](quota.md)。

## 后续扩展点

- **Skill 回归 UI**：chat-demo 的 system prompt 或 Worker 侧按 skill_id 注入 system 消息
- **阶段 4（MCP）**：Worker 内实现工具循环（tool_call → 调 MCP server → 回填），轮次多时迁移到 Cloudflare Workflows
- 云端会话历史：加 `sessions` 表，前端同步
