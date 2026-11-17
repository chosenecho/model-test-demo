# 架构说明

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 静态前端 | `web/dist`（Worker Static Assets） | deepseek-ai/chat-demo 改造版：多会话、流式输出、深度思考、智能搜索、附件、语音、邀请码登录 |
| Worker 代理 | `worker/`（Cloudflare Workers，`aivmz.dpdns.org`） | 唯一持有 API Key 的地方；鉴权、配额、model 覆盖、DeepSeek API 同源反代 |
| D1 | `db/schema.sql` | users / invite_codes / quota / skills 四张表 |

## 请求流

1. 设置里输入邀请码 → `POST /api/login` → 校验邀请码、建用户、返回 30 天 HMAC Token（已用邀请码 + 持有旧 Token 可续签）
2. chat-demo 同源请求 `/anthropic/v1/messages`、`/anthropic/v1/files`、`/v1/tools/asr|tts`、`/models`，凭证为 Token（`x-api-key` 或 `Authorization`）
3. Worker：验 Token → （messages）检查每日配额 → **强制覆盖 model 字段**（`wrangler.toml` 的 `MODEL`，当前 `deepseek-flash`）→ 注入 DeepSeek API Key 转发，SSE 原样透传
4. chat-demo 前端解析 SSE：正文、深度思考、搜索引用（`deepseek_web_search` / `deepseek_read_url` 工具事件）逐块渲染

## 路由总览（Worker）

| 路径 | 处理 |
|---|---|
| `/`、`/static/*` | 静态资产（`web/dist`） |
| `POST /api/login` | 邀请码换 Token（支持过期续签） |
| `GET /api/me`、`GET /api/skills` | 配额查询、Skill 列表（保留，前端暂未用） |
| `POST /api/chat` | 旧版 OpenAI 风格聊天接口（保留兼容） |
| `GET /models` | 透传（鉴权） |
| `/anthropic/v1/messages` | 透传 + 配额 + model 覆盖（SSE） |
| `/anthropic/v1/files*`、`/v1/tools/*` | 透传（鉴权，附件 / 语音） |

## 安全模型

- API Key 仅存于 Worker secret（`wrangler secret put DEEPSEEK_API_KEY`）
- 客户端传入或写死的 `model` 一律被服务端覆盖，模型选择不可伪造
- Token 无状态（HMAC-SHA256 签名 + 过期时间），签名校验不查库，用户存在性以 D1 为准（可随时封禁）
- 配额在转发前检查、转发后计数（先计数后转发，失败请求不扣额度的问题已知）
- 深度思考 / 智能搜索等能力开关由用户在设置里控制，响应参数原样透传

## 配额

所有用户统一：每日 20 次（`wrangler.toml` 的 `DAILY_QUOTA` 可调），按 `POST /anthropic/v1/messages` 调用计数（重新生成、切换分支各计 1 次）。

## 后续扩展点

- **Skill 回归 UI**：chat-demo 的 system prompt 或 Worker 侧按 skill_id 注入 system 消息
- **阶段 4（MCP）**：Worker 内实现工具循环（tool_call → 调 MCP server → 回填），轮次多时迁移到 Cloudflare Workflows
- 云端会话历史：加 `sessions` 表，前端同步
