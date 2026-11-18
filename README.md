# model-test-demo

轻量的多用户模型展示站：用户在网页工作台中与固定模型对话，前端基于 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo) 改造（邀请码登录、API Key 服务端注入），为后续 MCP 工具接入预留接口。

## 架构

```
用户浏览器
   ▼
Cloudflare Worker（https://aivmz.dpdns.org，单域名同源部署）
   ├─ Workers Static Assets ── web/dist 静态前端（deepseek-ai/chat-demo 构建产物）
   │    fetch 同源 /anthropic/v1/*、/v1/tools/*、/models、/api/*
   ├─ /anthropic/v1/* 等透传：校验 HMAC Token → 注入 API Key → 强制覆盖 model
   ├─ 邀请码登录 → 签发 30 天 HMAC Token（支持过期续签）
   └─ 额度（D1 钱包 + 流水，按 token 结算；限流 10 次/分）
   ▼
DeepSeek API（Anthropic 兼容 Messages / Files / Tools 接口）
```

## 目录

```
├── web/                # 前端（deepseek-ai/chat-demo 改造版源码）
│   ├── src/            #   demo 源码（改动见下）
│   └── dist/           #   构建产物（随 Worker Static Assets 部署）
├── worker/             # Cloudflare Worker 代理
│   ├── wrangler.toml
│   └── src/index.js
├── db/
│   └── schema-v2.sql   # D1 建表（v2，11 张表）
└── docs/
    ├── architecture.md  # 组件与请求流
    ├── database.md      # v2 表设计与取舍
    ├── quota.md         # 额度系统设计（替代每日 20 次）
    ├── quota-sop.md     # 额度系统运维 SOP
    ├── risk-fixes.md    # 风险确认与修复计划
    ├── change-sop.md    # 架构改动 SOP（A1–A4 的执行/回滚）
    └── sop.md           # 部署 / 迁移 / 排障 SOP
```

### 对 chat-demo 的改动

- `rspack.config.ts`：`apiOrigin` 默认改为空串（同源请求，由本站 Worker 反代 DeepSeek API）
- `src/services/api/client.ts`：`verifyApiKey` 改为 POST `/api/login`，用邀请码换取服务器签发的访问 Token（浏览器不接触 DeepSeek API Key）
- `src/components/settings/useApiKeyForm.ts`：保存返回的 Token 而非原样保存输入
- `src/i18n/{zh,en}.ts`：设置界面「API Key」文案改为「邀请码」

### Skill 说明

旧版手写前端的 Skill（预设提示词下拉）暂无入口；`skills` 表和 `/api/skills` 接口保留，chat-demo 的「深度思考 / 智能搜索」开关直接透传 DeepSeek 服务端工具参数。

## SOP

**运维操作看 [`docs/sop.md`](docs/sop.md)**：部署、发布、数据库变更、邀请码、验收、排障、回滚、密钥轮换，全部是可复制执行的命令。

开发阶段规划：

1. **阶段 0**：仓库骨架
2. **阶段 1**：前端工作台（现为 chat-demo 集成）
3. **阶段 2**：Worker 代理（鉴权、配额、流式转发）
4. **阶段 3**：接入 DeepSeek 托管工具（web_search / read_url，chat-demo 已带前端解析）
5. **阶段 4**：MCP 工具循环（可选，Workflows）

每阶段：`wrangler dev` 本地验证 → 部署 → 浏览器冒烟 → commit。

## 部署

### 1. 创建 D1 并初始化

```bash
cd worker
wrangler d1 create model-test-demo-db
# 把返回的 database_id 填入 wrangler.toml
wrangler d1 execute model-test-demo-db --file ../db/schema-v2.sql --remote
```

### 2. 配置密钥

```bash
wrangler secret put DEEPSEEK_API_KEY   # DeepSeek API Key
wrangler secret put AUTH_SECRET        # Token 签名密钥（随机长字符串）
```

### 3. 生成邀请码

```bash
wrangler d1 execute model-test-demo-db --remote \
  --command "INSERT INTO invite_codes (code) VALUES ('your-code');"
```

### 4. 构建前端并部署（静态资产 + API 同域）

```bash
cd ../web && pnpm install && pnpm build
cd ../worker && wrangler deploy
```

模型由 `wrangler.toml` 的 `MODEL` 统一配置（当前 `deepseek-flash`），请求中的 model 字段一律被服务端覆盖。

## 本地开发

```bash
cd web && pnpm install && pnpm build   # 前端构建到 web/dist
cd ../worker && wrangler dev           # http://localhost:8787，静态页面 + API 同源
```

## 安全要点

- API Key 只存在于 Worker secret，前端永不接触
- 模型由 Worker 统一配置，请求中的 model 字段会被覆盖
- 按套餐额度计费（free 每月 6 额度 = 6,000,000 micro），余额与流水同事务写入，可对账
- 限流 10 次/分（`RATE_LIMIT_PER_MIN`），额度不足 402、超频 429，两者前端提示分开
- Token 为 HMAC 签名、带过期时间，无状态校验；过期后可凭原邀请码 + 旧 Token 续签

## License

MIT
