# 智能搜索与行业分析师开发及上线 SOP

版本 v0.1 · 依据 [产品开发计划 v0.1](PDP.md) 和 [产品需求 v0.4](PDR.md)。

本规程按兼容性验证、开发、联调验收、灰度、回滚的顺序执行。真实 MCP 协议、应用开关及 D1 迁移以开发阶段的记录为准。首次部署、邀请码和通用运维沿用 [运维手册](sop.md)。

## 1. 准备环境

1. 使用已初始化的[测试站](https://model-test-demo-test.jiqimao123456.workers.dev)及独立 D1 `model-test-demo-test-db`。测试命令显式指定[测试配置](../worker/wrangler.test.toml)，执行远端命令前核对 Worker 名和 D1 绑定。用两个测试用户覆盖并发，用一份旧会话样本验证升级兼容。生产发布沿用[生产配置](../worker/wrangler.toml)。
2. 部署人员为测试 Worker 配置 `DEEPSEEK_API_KEY` 和 `FIRECRAWL_API_KEY`。通过 Wrangler 的交互输入录入对应环境的密钥，再用 `secret list` 核对名称。Worker 仅将 Firecrawl 密钥用于 MCP 鉴权。测试样例和验收记录只留脱敏数据。

   ```powershell
   # 在 worker/ 目录运行。已有的凭据只核对名称，缺失或轮换时才执行对应的 put。
   npx wrangler secret list --config wrangler.test.toml
   npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.test.toml
   npx wrangler secret put FIRECRAWL_API_KEY --config wrangler.test.toml
   npx wrangler secret list --config wrangler.test.toml
   ```

   录入前可先用同一个密钥直连 MCP 确认可用，脚本只读入环境变量、不落盘，输出只有条数和主机名：

   ```powershell
   # 在仓库根目录运行，FC_KEY 为待验证的 Firecrawl 密钥。
   $env:FC_KEY = Read-Host 'FIRECRAWL_API_KEY'
   node worker/.smoke/firecrawl-live.mjs
   Remove-Item Env:\FC_KEY
   ```

3. 部署人员按 [变更记录模板](change-sop.md#9-变更记录模板) 建立记录，填写代码版本、测试目标和负责角色。开发后补齐迁移文件、两个功能开关的读写指令及默认值、已验证的回滚版本、验收请求 ID。

## 2. 验证模型与 MCP 兼容性

1. 后端用当前固定的 `deepseek-flash` 和 `/anthropic/v1/messages` 声明自定义搜索工具。让模型产生 `tool_use`，重组 SSE 参数片段，按工具调用 ID 回填 `tool_result`，直到收到最终回复。保存脱敏的请求、事件样例和各轮用量字段。[现有对话入口](../worker/src/index.js#L655)
2. 从测试 Worker 连接真实 Firecrawl MCP，核实传输方式、鉴权位置、工具名和入参、输出结构。再用真实搜索结果完成一次模型续轮，确认工具输出可转成标题、链接和摘要，且回答能引用其中的来源。
3. 固定模型或 MCP 连通性验证失败时，记录阶段、请求 ID 和可复现条件，先解决该依赖。Skill 可并行开发，搜索界面可用模拟事件联调。验证通过后，在变更记录中定下最大工具轮次、单次及整轮超时、结果大小上限、模型续轮预占策略。

## 3. 开发并本地验证

1. **Skill 与提示词。** 前端把唯一预设「行业分析师」放在输入框附近，默认关闭。旧会话缺字段也按关闭处理，刷新恢复已有设置，生成中的请求沿用发起时的开关快照。Worker 校验开关，由服务端组装 `system`、`tools` 和需要的 `tool_choice`，剔除客户端同名字段。启用 Skill 时追加带版本的分析指令，随回复返回实际版本并保存、同步。模型设置和附件归属检查沿用现有链路。[对话状态](../web/src/services/chat/store.ts) · [会话同步](../web/src/services/chat/sync.ts) · [请求校验](../worker/src/index.js#L771)
2. **搜索与界面。** 智能搜索与 Skill 独立。Worker 仅向已启用智能搜索且有权限的请求声明 Firecrawl 工具，校验模型返回的工具名与参数，按调用 ID 回填结果，接续模型输出。页面通过 SSE 显示「执行中」「完成」「失败」和来源。日志记录请求 ID、阶段、状态与耗时，外发错误使用脱敏后的错误类别和描述。模型只接收工具定义与筛选后的结果，浏览器、模型和日志均排除鉴权信息。用户停止后保留已生成正文，尽力取消当前请求，并停止发起后续模型和工具调用。
3. **每日搜索额度。** 每位用户每天 200 次搜索工具调用，按香港时间（`Asia/Hong_Kong`）分日。Worker 在出站前按 `user_id` 做原子条件写入预占，同一用户当日只放行前 200 次；其他用户的调用不占用该额度。出站前若日期已变，释放尚未使用的旧日期名额，改占新日期。失败、超时及重试以实际发出的搜索请求为单位，每次都单独记账。将传输层重试纳入同一预占环节。确认请求未发出才释放名额，状态不确定时保留计数。额度用完显示「今日搜索额度已用完」，模型可继续普通对话。D1 预占失败时本次跳过搜索。
4. **模型用量。** 模型额度与搜索分开记。沿用对话请求 ID，每一轮发出前落实预占策略，汇总各轮实际用量后结算一次。重复提交同一请求 ID 不触发新增出站或扣费，上游用量缺失时沿用待对账流程。[现有模型额度实现](../worker/src/core.js#L310) · [模型额度验收](quota-sop.md#14-上线验收5-步)

从仓库根目录执行 Worker 语法检查和集成测试。另运行 [Workers 运行时测试](../worker/.smoke/chat-runtime.cjs)，使用模拟模型、模拟 MCP 和本地 D1，覆盖搜索续轮、汇总结算和上游重定向。以下示例使用 Windows 全局安装的 Wrangler 4.156.0，各项通过后再部署测试 Worker。

```powershell
node --check worker/src/index.js
node --test worker/.smoke/*.test.mjs
$wranglerPackage = Join-Path (Split-Path (Get-Command wrangler).Source) 'node_modules/wrangler/package.json'
node worker/.smoke/chat-runtime.cjs "$wranglerPackage"
```

进入 `worker/`，在本地 D1 执行迁移并复跑，确认旧会话可读、已有额度和流水保留。以下命令使用变更记录里已确定的迁移文件，测试环境远端迁移使用同一文件并显式指定测试配置和测试 D1。[数据库变更规程](sop.md#4-数据库变更)

```powershell
# CHAT_MIGRATION_SQL 填迁移文件的绝对路径。
if (-not $env:CHAT_MIGRATION_SQL -or -not (Test-Path -LiteralPath $env:CHAT_MIGRATION_SQL -PathType Leaf)) {
  throw '请先指定本次 D1 迁移文件'
}
npx wrangler d1 execute model-test-demo-db --local --file "$env:CHAT_MIGRATION_SQL"
```

在 `web/` 目录运行以下命令，构建结果供 Worker Static Assets 部署使用。[前端脚本](../web/package.json#L8) · [部署配置](../worker/wrangler.toml)

```powershell
pnpm run type --noEmit
pnpm run lint
pnpm run build
```

## 4. 在测试环境验收

先用模拟模型和 MCP 覆盖失败、停止、并发和跨日，再在测试 Worker 用真实 DeepSeek 与 Firecrawl 验证成功链路。每项保存请求 ID、预期及实际结果。测试侧出站记录与页面状态、D1 计数和模型账单逐项对应。

- [ ] **对话回归。** 用邀请码登录，完成多轮流式聊天，刷新恢复历史，验证附件、停止和网络错误后的重试。
- [ ] **Skill 与提示词。** 新会话和没有开关记录的旧会话默认关闭，启用后刷新仍开启，下次发送追加指令并在回复中保存实际版本。关闭后下次恢复基础提示词。在测试请求中传非法开关值应得到明确错误，传客户端自定义 `system` 或 `tools` 应由 Worker 按服务端配置重新组装。
- [ ] **智能搜索。** 关闭 Skill 后开启智能搜索，确认 Worker 经 MCP 调用 Firecrawl，按调用 ID 回填，页面展示状态，引用可追溯。仅开启 Skill 时无 Firecrawl 调用，两项同时开启时均生效。检查新版链路的模型请求没有声明旧托管搜索工具。
- [ ] **密钥保护。** 覆盖成功、超时与鉴权失败，检查浏览器响应、模型请求和 Worker 日志，确认均未出现密钥、含鉴权信息的 URL 或请求头。归档脱敏结果。
- [ ] **每日额度。** 测试 D1 把用户 A 当日计数预置为 200，用户 B 为 0。A 触发搜索只看到额度提示并仍可普通聊天，B 同时搜索则实际出站一次，说明额度按用户隔离。另测已发出的失败、超时及重试各计一次，确认未发出时释放预占。用测试时钟跨香港零点，验证新日期可继续调用，跨日未发出的旧预占按新日期处理。
- [ ] **失败与停止。** 模拟零结果、MCP 失败、超时和触及工具轮次或耗时上限。页面显示对应状态，模型基于已有信息回答。工具执行时点击停止，确认正文保留并进入已停止状态，后续没有新出站。
- [ ] **用量与重复提交。** 一条消息触发多个模型轮次，按请求 ID 核对各轮用量及汇总账单。重复提交同一 ID，模型扣费和 Firecrawl 出站记录均维持首次提交后的值。取消及部分失败也要核对预占和结算记录。

各项通过后，用测试环境演练两个开关和整包回滚。确认关搜索后普通聊天可用，且新版不会回退到 DeepSeek 托管搜索。旧运维手册中的 DeepSeek 搜索属于上线前路径，生产切换后同步更新该说明。[现行运维手册](sop.md)

## 5. 发布与观察

1. **上线前。** 在 `worker/` 下核对生产账户、Worker、域名与 D1，记录当前部署版本。导出备份后使用第 3 节已验证的迁移文件，核对新增结构和旧数据。项目方通过交互命令配置生产 Secret 并核对名称。逐条执行，上一条成功后再继续。[数据库变更规程](sop.md#4-数据库变更)

   ```powershell
   npx wrangler whoami
   npx wrangler deployments list

   $chatBackup = Join-Path $env:TEMP ("model-test-demo-db-{0}.sql" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
   npx wrangler d1 export model-test-demo-db --remote --output "$chatBackup"
   npx wrangler d1 execute model-test-demo-db --remote --file "$env:CHAT_MIGRATION_SQL"

   npx wrangler secret put FIRECRAWL_API_KEY
   npx wrangler secret list
   ```

2. **先部署兼容版本。** 使用与 Worker 对应的静态资产，搜索和 Skill 的功能开关默认关闭。部署后验证旧会话、普通聊天与附件。将该版本验证为可回滚基线，确认其搜索边界与本次发布一致。

   ```powershell
   npx wrangler deploy
   ```

3. **向试用用户启用。** 按变更记录分别开启 Skill 和搜索，在真实页面验证各自行为及组合。检查 Firecrawl 出站数、模型账单及来源。记录启用时间、版本、迁移版本和验收请求 ID。[变更记录模板](change-sop.md#9-变更记录模板)

   先用 `CHAT_FEATURE_PREVIEW_USERS` 收窄到验收账号，通过后再对全部用户启用（留空该变量）：

   ```powershell
   npx wrangler deploy --var 'CHAT_INDUSTRY_ANALYST_ENABLED:true' --var 'CHAT_FIRECRAWL_ENABLED:true' --var 'CHAT_FEATURE_PREVIEW_USERS:'
   ```
4. **观察 15–30 分钟。** 在 `worker/` 运行 `npx wrangler tail`，看 Worker 5xx、模型与 MCP 错误、搜索日计数、模型重复扣费和日志脱敏。经过一个香港零点后，核对新旧日期的计数。强制错误与满额预置留在测试环境。[发布观察规程](change-sop.md#10-观测指标每次发布后看这四个)

## 6. 故障处置与恢复

- **搜索鉴权异常、超额或发现密钥暴露。** 关闭智能搜索开关，确认新请求进入普通聊天且 Firecrawl 无新出站。密钥暴露时撤销旧密钥、写入新 Secret，按密钥保护用例复验后再恢复。[密钥轮换](sop.md#9-密钥轮换)
- **Skill 指令、版本或同步异常。** 关闭 Skill 开关，发一条新消息，验证 Worker 使用基础提示词。涉及模型扣费异常时，按请求 ID 对账，保留会话、搜索计数及用量流水，按既有额度规程修正。[额度排障](quota-sop.md#7-排障) · [额度对账](quota-sop.md#6-对账)
- **普通聊天受影响。** 回滚 Worker 和静态资产到已验证版本，沿用当前 D1 数据与迁移。回滚后验证登录、流式聊天、会话、附件及搜索关闭时无新出站。数据库恢复单独依照现有规程处理。[回滚规程](sop.md#8-回滚)

  ```powershell
  # 在 worker/ 下执行，ROLLBACK_VERSION 填变更记录中的已验证版本 ID。
  npx wrangler versions list
  if (-not $env:ROLLBACK_VERSION) { throw '请先指定已验证的回滚版本' }
  npx wrangler rollback "$env:ROLLBACK_VERSION"
  ```

恢复启用前重跑故障用例和普通聊天冒烟测试，将处置、复验结果及部署版本追加到变更记录。[变更记录模板](change-sop.md#9-变更记录模板)
