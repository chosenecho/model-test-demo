# 架构说明

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 静态前端 | `web/` (Cloudflare Pages) | 聊天工作台：流式打字机输出、Skill 下拉、邀请码登录 |
| Worker 代理 | `worker/` (Cloudflare Workers) | 唯一持有 API Key 的地方；鉴权、配额、Skill 注入、SSE 透传 |
| D1 | `db/schema.sql` | users / invite_codes / quota / skills 四张表 |

## 请求流

1. 用户输入邀请码 → `POST /api/login` → 校验邀请码、建用户、返回 30 天 HMAC Token
2. 前端带 Token 请求 → `POST /api/chat {messages, skill_id}`
3. Worker：验 Token → 检查每日配额 → **强制覆盖 model 字段**（统一配置，见 wrangler.toml 的 `MODEL`）→ 注入 Skill system prompt → 转发 DeepSeek（stream: true）
4. DeepSeek 返回 SSE → Worker 原样透传 → 前端逐 token 渲染

## 安全模型

- API Key 仅存于 Worker secret（`wrangler secret put DEEPSEEK_API_KEY`）
- 客户端传入的 `model` 一律被服务端覆盖，模型选择不可伪造
- Token 无状态（HMAC-SHA256 签名 + 过期时间），不需要查库即可校验签名，用户存在性以 D1 为准（可随时封禁）
- 配额在转发前检查、转发后计数，失败请求不扣额度的问题已知（简单起见先计数后转发；如需精确可改为成功回调）

## 配额

所有用户统一：每日 20 次（`wrangler.toml` 的 `DAILY_QUOTA` 可调）。邀请码不再区分等级，仅作为准入控制。

## 后续扩展点

- **阶段 3（托管工具）**：chat 转发的请求体里直接加 `tools`（DeepSeek 服务端工具 web_search / read_url），前端解析 SSE 中的工具调用事件并可视化
- **阶段 4（MCP）**：Worker 内实现工具循环（tool_call → 调 MCP server → 回填），轮次多时迁移到 Cloudflare Workflows
- 云端会话历史：加 `sessions` 表，前端同步
