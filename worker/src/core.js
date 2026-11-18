/**
 * Worker 的安全边界、会话凭证、额度预占与结算。
 *
 * 依赖的 D1 结构由 db/hardening.sql 提供：
 *   auth_sessions          可撤销登录会话（存 Token 摘要）
 *   login_attempts         登录尝试计数（来源 + 时间窗）
 *   usage_requests.reserved_micro / reconcile_reason   预占与待对账原因
 *   file_objects           本地文件标识 → 上游 file_id（归属校验）
 *   app_settings           运行期配置行（全局停流等）
 *
 * 金额一律 micro 整数；流水只 INSERT，冲正写反向 refund 行。
 */

export const MICRO = 1000000;
/** 预占超过这个时间仍未结算的请求，由定时任务回收或转待对账 */
export const RESERVATION_TTL_MS = 3 * 60 * 1000;
/** 定时任务每轮处理的批大小，避免单次调用 D1 查询数超限 */
const SWEEP_BATCH = 20;

// ---------- 基础工具 ----------

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** 统一错误体：只回本地生成的文案和请求标识，不转发上游正文 */
export function apiErr(message, status, requestId) {
  const headers = requestId ? { 'x-request-id': requestId } : {};
  return json({ error: { message, type: 'invalid_request_error' } }, status, headers);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 当前计费周期（UTC 自然月），毫秒 */
export function periodOf(now) {
  const d = new Date(now);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** 取第一个结果行；D1 的 first() 在没有结果时返回 null */
export async function first(stmt) {
  return (await stmt.first()) ?? null;
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** 客户端凭证：32 字节随机数，base64url */
export function newSecret() {
  return b64url(randomBytes(32));
}

/** 服务端只存摘要；加 pepper 防止库外泄露后直接当凭证用 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hashSecret(secret) {
  return sha256Hex(`dsh-session-v1:${secret}`);
}

// ---------- 日志：不落正文、凭证和附件 ----------

export function log(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ---------- 运行期配置 ----------

/** 读 app_settings 里的开关行；表不可用时按「开启」处理，保持服务可用 */
export async function setting(env, key, fallback) {
  try {
    const row = await first(env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key));
    return row ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * 全局停流：new_upstream_calls = 'deny' 时不再发起任何上游付费调用。
 * 读不到配置（表缺失/DB 异常）按「停」处理：宁可短时不可用，也不在配置失效时继续花钱。
 */
export async function upstreamAllowed(env) {
  return (await setting(env, 'new_upstream_calls', 'deny')) !== 'deny';
}

// ---------- 会话凭证 ----------

/**
 * 签发登录会话。返回 { token, sessionId, expiresAt }。
 * token = uuid.sessionId（客户端看到的是不透明字符串），库里只存 sessionId 与摘要。
 */
export async function issueSession(env, userId, ttlMs, meta = {}) {
  const secret = newSecret();
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await first(
    env.DB.prepare(`INSERT INTO auth_sessions
        (id, user_id, secret_hash, created_at, expires_at, last_used_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, userId, await hashSecret(secret), now, expiresAt, now,
        String(meta.userAgent ?? '').slice(0, 200)),
  );
  return { token: `${sessionId}.${secret}`, sessionId, expiresAt };
}

function splitToken(token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const sessionId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(sessionId) || secret.length < 16) return null;
  return { sessionId, secret };
}

/**
 * 校验凭证并返回用户。命中后异步更新 last_used_at，不阻塞请求。
 * 封禁、过期、撤销的会话一律视为未登录。
 */
export async function authenticate(env, request, token) {
  const parts = splitToken(token);
  if (!parts) return null;
  const row = await first(env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.secret_hash, s.expires_at, s.revoked_at,
            u.status AS user_status
       FROM auth_sessions s JOIN users u ON u.token_id = s.user_id
      WHERE s.id = ?`
  ).bind(parts.sessionId));
  if (!row || row.revoked_at || row.expires_at <= Date.now()) return null;
  if (row.user_status !== 'active') return null;
  if (await hashSecret(parts.secret) !== row.secret_hash) return null;
  return { userId: row.user_id, sessionId: row.session_id, expiresAt: row.expires_at };
}

/** 轻量滚动：更新活跃时间，失败不影响请求 */
export function touchSession(env, ctx, sessionId) {
  if (!sessionId) return;
  const run = env.DB.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), sessionId).run().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(run);
}

export async function revokeSession(env, sessionId) {
  await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(Date.now(), sessionId).run();
}

export async function revokeUserSessions(env, userId) {
  await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), userId).run();
}

// ---------- 登录限流 ----------

/** 固定窗口计数（来源 + 窗口起点 作为主键），超限返回剩余等待秒数 */
export async function consumeAttempt(env, bucket, key, limit, windowMs) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await env.DB.prepare(`INSERT INTO login_attempts (bucket, key, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(bucket, key, window_start) DO UPDATE SET count = count + 1`)
    .bind(bucket, key, windowStart).run();
  const row = await first(env.DB.prepare(
    'SELECT count FROM login_attempts WHERE bucket = ? AND key = ? AND window_start = ?'
  ).bind(bucket, key, windowStart));
  const used = row?.count ?? 1;
  return { ok: used <= limit, used, limit, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000) };
}

export async function pruneAttempts(env) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE window_start < ?')
    .bind(Date.now() - 24 * 3600 * 1000).run().catch(() => {});
}

// ---------- 邀请码 ----------

/** 邀请码摘要的前缀：与 db/hardening.sql 里写的一致，改动即等于让旧码全部失效 */
const INVITE_HASH_PREFIX = ['dsh', 'invite', 'v1'].join('-') + ':';

/** 新码只有这一次能看到明文；库里存 SHA-256 摘要 */
export function inviteHash(code) {
  return sha256Hex(`${INVITE_HASH_PREFIX}${String(code).trim()}`);
}

export async function inviteUsable(env, code, now = Date.now()) {
  const hash = await inviteHash(code);
  const row = await first(env.DB.prepare(
    'SELECT code_hash, used_by, expires_at FROM invite_codes WHERE code_hash = ?'
  ).bind(hash));
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_by) return { ok: false, reason: 'used' };
  if (row.expires_at && row.expires_at <= now) return { ok: false, reason: 'expired' };
  return { ok: true, hash };
}

// ---------- 额度 ----------

/** 开钱包：幂等；开户即发当期额度 */
export async function ensureWallet(env, userId) {
  const now = Date.now();
  const { start, end } = periodOf(now);
  const plan = await first(env.DB.prepare('SELECT grant_micro FROM quota_plans WHERE id = ?')
    .bind('free'));
  const grant = plan?.grant_micro || 0;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO quota_wallets
        (user_id, plan_id, balance_micro, reserved_micro, period_start, period_end, status, updated_at)
      VALUES (?, 'free', ?, 0, ?, ?, 'active', ?)`).bind(userId, grant, start, end, now),
    env.DB.prepare(`INSERT INTO quota_ledger
        (id, user_id, kind, amount_micro, balance_after, note, created_at)
      SELECT ?, ?, 'grant', ?, balance_micro, '开户首期发放', ? FROM quota_wallets
        WHERE user_id = ? AND changes() = 1`)
      .bind(crypto.randomUUID(), userId, grant, now, userId),
  ]);
}

export async function loadQuota(env, userId) {
  return (await env.DB.prepare(`SELECT q.user_id, q.plan_id, q.plan_name, q.balance_micro,
                                  q.reserved_micro, q.available_micro, q.period_end, q.status,
                                  q.soft_limit_pct, q.grant_micro,
                                  p.price_in_micro, p.price_out_micro, p.per_request_micro, p.overage,
                                  p.price_per_mb_micro, p.max_upload_mb
                           FROM v_quota q JOIN quota_plans p ON p.id = q.plan_id
                           WHERE q.user_id = ?`).bind(userId).first()) ?? null;
}

/** 按 token 计价，单位 micro */
export function computeCost(plan, usage) {
  const input = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
  const output = (usage?.output_tokens || 0) + (usage?.cache_read_input_tokens || 0) * 0;
  return Math.ceil((input / 1000) * (plan?.price_in_micro ?? 0))
    + Math.ceil((output / 1000) * (plan?.price_out_micro ?? 0))
    + (plan?.per_request_micro ?? 0);
}

/** 按输入 token 与最大输出 token 估上界，用于预占 */
export function estimateCost(plan, { inputTokens, maxTokens }) {
  return Math.ceil((Math.max(0, inputTokens) / 1000) * (plan?.price_in_micro ?? 0))
    + Math.ceil((Math.max(0, maxTokens) / 1000) * (plan?.price_out_micro ?? 0))
    + (plan?.per_request_micro ?? 0);
}

/** 按字节计价（上传）：1 MB 起算，向上取整 */
export function computeUploadCost(plan, bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return Math.ceil(mb) * (plan?.price_per_mb_micro ?? 0);
}

export function maxUploadMb(env, plan) {
  return Number(plan?.max_upload_mb || env.MAX_UPLOAD_MB || 64);
}

export async function countRecentRequests(env, userId, windowMs) {
  const row = await first(env.DB.prepare(
    'SELECT COUNT(*) AS n FROM usage_requests WHERE user_id = ? AND started_at > ?'
  ).bind(userId, Date.now() - windowMs));
  return row?.n || 0;
}

/**
 * 预检：限流 → 停流 → 额度。只读，不改账。
 * 返回 { ok, plan?, status?, message? }
 */
export async function preflight(env, userId, options = {}) {
  const { estimateMicro = 0, rateLimit = 10 } = options;
  const recent = await countRecentRequests(env, userId, 60000);
  if (recent >= rateLimit) {
    return { ok: false, status: 429, message: `rate limit exceeded (${recent}/min)` };
  }
  if (!(await upstreamAllowed(env))) {
    return { ok: false, status: 503, message: '服务暂停中，稍后重试' };
  }
  let q = await loadQuota(env, userId);
  if (!q) {
    await ensureWallet(env, userId);
    q = await loadQuota(env, userId);
  }
  if (!q) return { ok: false, status: 402, message: 'quota not initialized' };
  if (q.status === 'suspended') return { ok: false, status: 403, message: 'quota suspended' };
  if (q.overage !== 1 && q.available_micro < Math.max(0, estimateMicro)) {
    return {
      ok: false, status: 402,
      message: `额度不足，剩 ${(q.available_micro / MICRO).toFixed(4)} 额度`,
    };
  }
  return { ok: true, plan: q };
}

/**
 * 在同一事务性批次里：校验额度 → 扣预占 → 写 pending 请求。
 * 任何一步不成立（重复键、余额变化）都不会留下半条记录。
 * 返回 { ok, duplicate?, insufficient?, plan? }
 */
export async function reserve(env, { requestId, userId, route, model, sessionId, messageId, amountMicro, plan }) {
  const now = Date.now();
  const amount = Math.max(0, Math.ceil(amountMicro || 0));
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO usage_requests
        (request_id, user_id, session_id, message_id, route, model, status, started_at, reserved_micro)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      ON CONFLICT(request_id) DO NOTHING`)
      .bind(requestId, userId, sessionId ?? null, messageId ?? null, route, model ?? null, now, amount),
    env.DB.prepare(`UPDATE quota_wallets
        SET reserved_micro = reserved_micro + ?, updated_at = ?
        WHERE user_id = ? AND balance_micro - reserved_micro >= ? AND status != 'suspended'
          AND changes() > 0`)
      .bind(amount, now, userId, amount),
  ]);
  const inserted = results?.[0]?.meta?.changes ?? 0;
  if (!inserted) return { ok: false, duplicate: true };
  const reserved = results?.[1]?.meta?.changes ?? 0;
  if (!reserved) {
    // 预占失败：把刚插入的请求标记为已释放，不占用额度
    await env.DB.prepare(`UPDATE usage_requests SET status = 'released', ended_at = ?, error_code = 'insufficient'
                          WHERE request_id = ?`).bind(Date.now(), requestId).run().catch(() => {});
    return { ok: false, insufficient: true, plan };
  }
  return { ok: true, plan, reservedMicro: amount };
}

export async function reserveContinuation(env, requestId, userId, amountMicro) {
  const amount = Math.max(0, Math.ceil(amountMicro));
  const now = Date.now();
  const [wallet] = await env.DB.batch([
    env.DB.prepare(`UPDATE quota_wallets
        SET reserved_micro = reserved_micro + ?, updated_at = ?
        WHERE user_id = ? AND balance_micro - reserved_micro >= ? AND status != 'suspended'
          AND EXISTS (SELECT 1 FROM usage_requests WHERE request_id = ? AND user_id = ? AND status = 'reserved')`)
      .bind(amount, now, userId, amount, requestId, userId),
    env.DB.prepare(`UPDATE usage_requests SET reserved_micro = reserved_micro + ?
        WHERE request_id = ? AND user_id = ? AND status = 'reserved' AND changes() = 1`)
      .bind(amount, requestId, userId),
  ]);
  return wallet.meta.changes === 1;
}

/**
 * 结算：按实际用量原子扣费并释放剩余预占。
 * - 只有 status='reserved' 的行能被结算，重复调用直接返回 settled:false，不会二次扣账
 * - 没有 usage 的请求进入待对账（按预占金额入账，release 剩余为 0），不按零费用处理
 * - overage=1 的套餐允许扣成负数；否则最多扣到 0
 */
export async function settle(env, { requestId, userId, plan, usage, httpStatus, latencyMs, costMicro, releaseOnly, reason }) {
  const now = Date.now();
  const req = await first(env.DB.prepare(
    `SELECT reserved_micro, status FROM usage_requests WHERE request_id = ? AND user_id = ?`
  ).bind(requestId, userId));
  if (!req || req.status !== 'reserved') return { settled: false };
  const reservedMicro = req.reserved_micro || 0;

  if (releaseOnly) {
    const [released] = await env.DB.batch([
      env.DB.prepare(`UPDATE usage_requests SET status = 'released', error_code = ?, ended_at = ?, reserved_micro = 0
                      WHERE request_id = ? AND user_id = ? AND status = 'reserved' AND reserved_micro = ?`)
        .bind(reason ?? 'released', now, requestId, userId, reservedMicro),
      env.DB.prepare(`UPDATE quota_wallets SET reserved_micro = MAX(0, reserved_micro - ?), updated_at = ?
                      WHERE user_id = ? AND changes() = 1`).bind(reservedMicro, now, userId),
    ]);
    return { settled: released.meta.changes === 1, cost: 0, charge: 0 };
  }

  const measured = Number.isFinite(usage?.output_tokens) || Number.isFinite(usage?.input_tokens);
  const wanted = Number.isFinite(costMicro) && costMicro !== null && costMicro !== undefined
    ? costMicro
    : (measured ? computeCost(plan, usage) : reservedMicro);
  const needsReconcile = !measured && !(Number.isFinite(costMicro) && costMicro !== null && costMicro !== undefined);
  const allowNegative = plan?.overage === 1;
  const cost = Math.max(0, wanted);
  const ledgerId = crypto.randomUUID();

  const [ledger, , updated] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO quota_ledger
        (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)
      SELECT ?, user_id, 'consume', -charge, balance_micro - charge, ?,
             CASE WHEN charge < ? THEN '余额不足，按可用额度扣减' END, ?
        FROM (SELECT user_id, balance_micro, CASE WHEN ? THEN ? ELSE MIN(?, MAX(0, balance_micro)) END AS charge
              FROM quota_wallets WHERE user_id = ?)
        WHERE EXISTS (SELECT 1 FROM usage_requests
                      WHERE request_id = ? AND user_id = ? AND status = 'reserved' AND reserved_micro = ?)
      RETURNING amount_micro`)
      .bind(ledgerId, requestId, cost, now, allowNegative ? 1 : 0, cost, cost, userId, requestId, userId, reservedMicro),
    env.DB.prepare(`UPDATE quota_wallets
        SET balance_micro = balance_micro + (SELECT amount_micro FROM quota_ledger WHERE id = ?),
            reserved_micro = MAX(0, reserved_micro - ?), updated_at = ?
        WHERE user_id = ? AND changes() = 1`).bind(ledgerId, reservedMicro, now, userId),
    env.DB.prepare(`UPDATE usage_requests
        SET input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_micro = ?,
            status = ?, http_status = ?, latency_ms = ?, ended_at = ?,
            reserved_micro = 0, reconcile_reason = ?
        WHERE request_id = ? AND user_id = ? AND status = 'reserved' AND changes() = 1`)
      .bind(
        usage?.input_tokens || 0,
        usage?.output_tokens || 0,
        (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0),
        cost,
        needsReconcile ? 'reconcile_required' : 'settled',
        httpStatus ?? 200, latencyMs ?? null, now,
        needsReconcile ? (reason ?? 'usage missing') : null,
        requestId, userId,
      ),
    env.DB.prepare(`UPDATE quota_wallets SET status = 'exhausted'
                    WHERE user_id = ? AND status = 'active' AND balance_micro <= 0`).bind(userId),
  ]);

  if (updated.meta.changes !== 1) return { settled: false };
  const charge = -(ledger.results[0]?.amount_micro ?? 0);

  // 旧计数表照写一份，迁移期对照用
  await env.DB.prepare(`INSERT INTO usage_daily (user_id, day, requests, input_tokens, output_tokens, cached_tokens)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET
        requests = requests + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cached_tokens = cached_tokens + excluded.cached_tokens`)
    .bind(userId, today(), usage?.input_tokens || 0, usage?.output_tokens || 0,
      (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0)).run()
    .catch(() => {});

  return { settled: true, cost, charge, reconcile: needsReconcile };
}

/** 上游明确失败（未产生用量）：释放预占，记 error */
export async function releaseRequest(env, requestId, userId, { httpStatus, errorCode } = {}) {
  const out = await settle(env, { requestId, userId, releaseOnly: true, reason: errorCode });
  if (out.settled) {
    await env.DB.prepare(`UPDATE usage_requests SET status = 'released', http_status = ?, error_code = ?
                          WHERE request_id = ? AND user_id = ?`)
      .bind(httpStatus ?? null, errorCode ?? null, requestId, userId).run().catch(() => {});
  }
  return out;
}

/**
 * 定时回收：预占超时仍未结算的请求。
 * 有 usage 的按实际结算，没有的转待对账（按预占金额入账），绝不静默清零。
 */
export async function sweepReservations(env) {
  const cutoff = Date.now() - RESERVATION_TTL_MS;
  const { results } = await env.DB.prepare(
    `SELECT request_id, user_id, reserved_micro, route FROM usage_requests
      WHERE status = 'reserved' AND started_at < ? ORDER BY started_at LIMIT ?`
  ).bind(cutoff, SWEEP_BATCH).all();
  let settledCount = 0;
  let reconcileCount = 0;
  for (const row of results || []) {
    const plan = await loadQuota(env, row.user_id).catch(() => null);
    const out = await settle(env, {
      requestId: row.request_id, userId: row.user_id, plan,
      usage: null, reason: 'swept: usage unknown',
      latencyMs: null,
    }).catch(() => ({ settled: false }));
    if (out.settled) {
      settledCount += 1;
      if (out.reconcile) reconcileCount += 1;
    }
  }
  return { scanned: results?.length || 0, settledCount, reconcileCount };
}

// ---------- 周期发放 ----------

/**
 * 每日 cron：到期钱包进下一周期。
 * rollover=1 → 余额结转；否则先记 expire 流水再清零。发放同样记 grant 流水。
 * period_end 作为幂等条件，重复运行不会重复发放。
 */
export async function rollPeriods(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id, plan_id, balance_micro, period_end FROM quota_wallets
      WHERE period_end <= ? ORDER BY period_end LIMIT ?`
  ).bind(now, SWEEP_BATCH).all();

  for (const w of results || []) {
    const plan = await first(env.DB.prepare('SELECT grant_micro, rollover FROM quota_plans WHERE id = ?')
      .bind(w.plan_id));
    if (!plan) continue;

    const { start, end } = periodOf(now);
    const keep = plan.rollover === 1 ? Math.max(0, w.balance_micro) : 0;
    const grant = plan.grant_micro || 0;
    const statements = [];

    if (plan.rollover !== 1 && w.balance_micro !== 0) {
      statements.push(
        env.DB.prepare(`INSERT INTO quota_ledger
            (id, user_id, kind, amount_micro, balance_after, note, created_at)
          SELECT ?, ?, 'expire', ?, 0, '周期结束清零', ? FROM quota_wallets
            WHERE user_id = ? AND period_end = ?`)
          .bind(crypto.randomUUID(), w.user_id, -w.balance_micro, now, w.user_id, w.period_end),
      );
    }

    statements.push(
      env.DB.prepare(`UPDATE quota_wallets
          SET balance_micro = CASE WHEN ? = 1 THEN MAX(0, balance_micro) ELSE 0 END + ?,
              period_start = ?, period_end = ?, status = 'active', updated_at = ?
          WHERE user_id = ? AND period_end = ?`)
        .bind(plan.rollover === 1 ? 1 : 0, grant, start, end, now, w.user_id, w.period_end),
      env.DB.prepare(`INSERT INTO quota_ledger
          (id, user_id, kind, amount_micro, balance_after, note, created_at)
        SELECT ?, ?, 'grant', ?, balance_micro, '周期发放', ? FROM quota_wallets
          WHERE user_id = ? AND period_end = ? AND changes() > 0`)
        .bind(crypto.randomUUID(), w.user_id, keep + grant, now, w.user_id, end),
    );

    await env.DB.batch(statements);
  }
  return { rolled: results?.length || 0 };
}
