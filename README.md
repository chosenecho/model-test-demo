# model-test-demo

轻量的多用户模型展示站：用户在网页工作台中与固定模型对话，支持 Skill（预设提示词 + 工具组合），为后续 MCP 工具接入预留接口。

## 架构

```
用户浏览器
   ▼
Cloudflare Pages ── web/ 静态前端（聊天工作台）
   │  fetch /api/*
   ▼
Cloudflare Worker ── worker/ 代理层
   ├─ 邀请码登录 → 签发 HMAC Token
   ├─ 每日配额（D1 计数）
   ├─ Skill 注入（system prompt + 工具白名单）
   └─ 注入 API Key，流式转发 DeepSeek API（SSE 透传）
   ▼
DeepSeek API
```

## 目录

```
├── web/                # 静态前端（Pages 部署）
│   └── index.html
├── worker/             # Cloudflare Worker 代理
│   ├── wrangler.toml
│   └── src/index.js
├── db/
│   └── schema.sql      # D1 建表
└── docs/
    └── architecture.md
```

## SOP（开发流程）

1. **阶段 0**：仓库骨架（本提交）
2. **阶段 1**：前端工作台（聊天、流式输出、Skill 下拉、登录）
3. **阶段 2**：Worker 代理（鉴权、配额、流式转发）
4. **阶段 3**：接入 DeepSeek 托管工具（web_search / read_url）
5. **阶段 4**：MCP 工具循环（可选，Workflows）

每阶段：`wrangler dev` 本地验证 → 部署 → 浏览器冒烟 → commit。

## 部署

### 1. 创建 D1 并初始化

```bash
cd worker
wrangler d1 create model-test-demo
# 把返回的 database_id 填入 wrangler.toml
wrangler d1 execute model-test-demo-db --file ../db/schema.sql --remote
```

### 2. 配置密钥

```bash
wrangler secret put DEEPSEEK_API_KEY   # DeepSeek API Key
wrangler secret put AUTH_SECRET        # Token 签名密钥（随机长字符串）
```

### 3. 生成邀请码

```bash
wrangler d1 execute model-test-demo-db --remote \
  --command "INSERT INTO invite_codes (code) VALUES ('demo-code');"
```

### 4. 部署 Worker

```bash
wrangler deploy
```

### 5. 部署前端

```bash
cd ../web
wrangler pages deploy . --project-name model-test-demo
```

在 Pages 项目设置里把 `API_BASE` 环境变量指向 Worker 域名（或直接改 `web/index.html` 顶部的 `API_BASE` 常量）。

## 本地开发

```bash
cd worker && wrangler dev      # 默认 http://localhost:8787
# 另开终端
cd web && python3 -m http.server 8080
# 打开 http://localhost:8080，API_BASE 填 http://localhost:8787
```

## 安全要点

- API Key 只存在于 Worker secret，前端永不接触
- 模型由 Worker 统一配置，请求中的 model 字段会被覆盖
- 每用户每日配额（默认 20 次/天），防刷
- Token 为 HMAC 签名、带过期时间，无状态校验

## License

MIT
