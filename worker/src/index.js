// model-test-demo Worker：会话凭证 / 额度预占结算 / 对话持久化 / 受控上游转发
//
// 安全边界（见 docs/security-hardening-sop.md）：
// 1. 上游只开放显式登记的操作，路径、方法、字段都按白名单转发，未登记一律 404/405
// 2. 浏览器只拿本地会话凭证（Cookie 或 x-api-key），真实的 DEEPSEEK_API_KEY 不出 Worker
// 3. 所有可能产生上游成本的请求先预占额度，再发上游，结算与释放都写流水
// 4. 会话与消息的每次写入都带用户归属条件，不依赖前端传入的 user 字段

import {
  apiErr, json, log, upstreamAllowed,
  issueSession, authenticate, touchSession, revokeSession,
  consumeAttempt, pruneAttempts, inviteHash, inviteUsable,
  ensureWallet, loadQuota, estimateCost, computeUploadCost, maxUploadMb,
  preflight, reserve, reserveContinuation, settle, releaseRequest, sweepReservations, rollPeriods,
} from './core.js';
import { chatConfig, chatFeatures, SEARCH_TOOL } from './chat-config.js';
import { CHAT_TIMEOUT_MS, startChatLoop } from './chat-loop.js';
import { searchFirecrawl } from './firecrawl.js';

/** 会话 Cookie：同源、HttpOnly、SameSite=Lax */
const SESSION_COOKIE = 'dsh_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 单请求体上限，SSE 请求超过直接 413 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES_PER_REQUEST = 400;
const MAX_MESSAGES_PER_SESSION = 2000;
const MAX_MESSAGES_PER_PUSH = 200;
const MAX_TITLE_LEN = 300;
/** 单请求输入侧估算上限（token），约 4 倍于常规上下文 */
const MAX_INPUT_TOKENS = 64000;
/** 单次会话推送的体积上限（字节），须明显低于 D1 2MB 单行上限 */
const MAX_SESSION_PUSH_BYTES = 1024 * 1024;

// ---------- 路由表 ----------

/** 上游操作登记表：只有这里列出的路径/方法才能到达 DeepSeek */
const UPSTREAM_ROUTES = [
  { match: (p) => p === '/models', methods: ['GET'], handler: (c) => proxyModels(c) },
  { match: (p) => p === '/anthropic/v1/messages', methods: ['POST'], handler: (c) => proxyMessages(c) },
  // 上传与删除都带归属校验：客户端只持本地 id，上游 file_id 不出库
  { match: (p) => p === '/anthropic/v1/files', methods: ['POST'], handler: (c) => uploadFile(c) },
  {
    match: (p) => p.startsWith('/anthropic/v1/files/'),
    methods: ['DELETE'],
    handler: (c) => deleteFile(c),
  },
  // 语音（/v1/tools/*）逐项验收后再加进来；未登记路径不会到达上游，直接 404。
];

const API_ROUTES = [
  { match: (p, m) => p === '/api/login' && m === 'POST', handler: (c) => login(c) },
  { match: (p, m) => p === '/api/logout' && m === 'POST', handler: (c) => logout(c) },
  { match: (p, m) => p === '/api/me' && m === 'GET', handler: (c) => me(c) },
  { match: (p, m) => p === '/api/usage' && m === 'GET', handler: (c) => usageList(c) },
  { match: (p, m) => p === '/api/ledger' && m === 'GET', handler: (c) => ledgerList(c) },
  { match: (p, m) => p === '/api/sessions' && m === 'GET', handler: (c) => listSessions(c) },
  { match: (p, m) => p.startsWith('/api/sessions/'), handler: (c) => sessionRoute(c) },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders(request, env), 'Access-Control-Max-Age': '600' },
        });
      }

      const api = API_ROUTES.find((r) => r.match(path, method));
      if (api) {
        const res = await api.handler({ request, env, ctx, url, path, method });
        return withCors(request, env, res);
      }

      const upstream = UPSTREAM_ROUTES.find((r) => r.match(path));
      if (upstream) {
        if (!upstream.methods.includes(method)) {
          return withCors(request, env, apiErr('method not allowed', 405));
        }
        const res = await upstream.handler({ request, env, ctx, url, path, method });
        return withCors(request, env, res);
      }

      // 其余路径交给静态资源；不在这里兜底成 404，否则前端路由会失效
      return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    } catch (e) {
      log('error', 'unhandled', { path, method, message: String(e?.message || e) });
      return withCors(request, env, apiErr('internal error', 500));
    }
  },

  // 每日 00:10 UTC：周期发放 / 预占回收 / 清理登录窗口
  async scheduled(event, env, ctx) {
    const run = (async () => {
      await rollPeriods(env).catch((e) => log('error', 'rollPeriods', { message: String(e?.message) }));
      await sweepReservations(env).catch((e) => log('error', 'sweep', { message: String(e?.message) }));
      await pruneAttempts(env);
    })();
    if (ctx?.waitUntil) ctx.waitUntil(run);
    else await run;
  },
};

// ---------- CORS：同源优先 ----------

/** 允许的来源：环境变量白名单或同源；返回 null 表示这是同源/无 Origin 请求 */
function allowedOrigin(env, request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return origin;
  try {
    if (new URL(origin).host === new URL(request.url).host) return origin;
  } catch (_) {
    return null;
  }
  return undefined; // 明确不属于白名单
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(env, request);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,anthropic-beta',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

function withCors(request, env, response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, headers });
}

// ---------- 会话凭证 ----------

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function tokenFrom(request) {
  return request.headers.get('x-api-key') || cookieValue(request, SESSION_COOKIE);
}

function sessionCookie(secret, maxAgeSec) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  const secure = String(maxAgeSec) !== '0';
  if (secure) flags.push('Secure');
  return `${SESSION_COOKIE}=${encodeURIComponent(secret)}; ${flags.join('; ')}`;
}

/**
 * 跨站写保护：会话在 Cookie 里，浏览器会自动带上，因此非 GET 必须来自同源。
 * SameSite=Lax 只挡住跨站探测器级别的请求，这里再按 Origin / Referer 明确拦一道。
 */
function sameOriginWrite(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  // 浏览器发的跨站请求一定带 Origin（且 Sec-Fetch-Site 不为 same-origin）；
  // 命令行/脚本两者都没有。因此：有 Origin 就必须同源，没有 Origin 就放行。
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch (_) {
      return false;
    }
  }
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).host === new URL(request.url).host;
    } catch (_) {
      return false;
    }
  }
  // 无 Origin 也无 Referer：非浏览器客户端，Cookie 不会被第三方页面带上，
  // 不存在 CSRF 面；放行以免把命令行和集成客户端一并挡死。
  return true;
}

/** 统一鉴权：返回 { userId, sessionId, expiresAt } 或 null */
async function identify(request, env) {
  return authenticate(env, request, tokenFrom(request));
}

// ---------- 登录 ----------

async function login({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const perIp = await consumeAttempt(env, 'login:ip', ip, 20, 10 * 60 * 1000);
  if (!perIp.ok) {
    return apiErr(`尝试过于频繁，${perIp.retryAfter} 秒后再试`, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return apiErr('invalid JSON body', 400);
  }
  const code = String(body?.code ?? '').trim();
  if (!code) return apiErr('missing code', 400);
  if (code.length > 200) return apiErr('invalid invite code', 401);

  const perCode = await consumeAttempt(env, 'login:code', await inviteHash(code), 10, 10 * 60 * 1000);
  if (!perCode.ok) {
    return apiErr(`尝试过于频繁，${perCode.retryAfter} 秒后再试`, 429);
  }

  const usable = await inviteUsable(env, code);
  if (!usable.ok) {
    // 不区分「码不存在」和「已过期」，避免枚举探测
    return apiErr('invalid invite code', 401);
  }

  const userId = crypto.randomUUID();
  const now = Date.now();
  const userAgent = request.headers.get('User-Agent');
  // 兑换与建号必须同批：邀请码的 UPDATE 带 used_by IS NULL 条件，抢不到就是 0 行
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE invite_codes SET used_by = ?, used_at = ?
                    WHERE code_hash = ? AND used_by IS NULL
                      AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(userId, now, usable.hash, now),
    env.DB.prepare(`INSERT INTO users (token_id, created_at, last_seen_at)
                    SELECT ?, ?, ? WHERE changes() > 0`)
      .bind(userId, now, now),
  ]);
  const claimed = results?.[0]?.meta?.changes ?? 0;
  if (!claimed) {
    // 码已被使用：只有持有该码兑换出的账号才能续期，否则和无效码同样处理
    const owner = await env.DB.prepare('SELECT used_by FROM invite_codes WHERE code_hash = ?')
      .bind(usable.hash).first();
    if (!owner?.used_by) return apiErr('invalid invite code', 401);
    // 续期沿用同一把码的限流（perCode 已在兑换前计数），避免拿已用码反复刷会话
    await ensureWallet(env, owner.used_by);
    const renewed = await issueSession(env, owner.used_by, SESSION_TTL_MS, { userAgent });
    return json(
      { ok: true, expiresAt: renewed.expiresAt, renewed: true },
      200,
      { 'Set-Cookie': sessionCookie(renewed.token, Math.floor(SESSION_TTL_MS / 1000)) },
    );
  }

  await ensureWallet(env, userId);
  const issued = await issueSession(env, userId, SESSION_TTL_MS, { userAgent });
  return json(
    { ok: true, expiresAt: issued.expiresAt, user: { id: userId } },
    200,
    { 'Set-Cookie': sessionCookie(issued.token, Math.floor(SESSION_TTL_MS / 1000)) },
  );
}

async function logout({ request, env }) {
  const who = await identify(request, env);
  if (who) await revokeSession(env, who.sessionId);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

// ---------- 额度与账户 ----------

async function me({ request, env, ctx }) {
  const who = await identify(request, env);
  if (!who) return apiErr('unauthorized', 401);
  touchSession(env, ctx, who.sessionId);
  // 前端只缓存到期时间（Cookie 是 HttpOnly，读不到凭证）；会话被撤销时由 401 兜底
  await ensureWallet(env, who.userId);
  const q = await loadQuota(env, who.userId);
  if (!q) return apiErr('quota not initialized', 500);
  return json({
    quota: {
      plan: q.plan_id,
      plan_name: q.plan_name,
      balance_micro: q.balance_micro,
      reserved_micro: q.reserved_micro,
      available_micro: q.available_micro,
      outstanding_micro: Math.max(0, q.reserved_micro),
      period_end: q.period_end,
      status: q.status,
      soft_limit_pct: q.soft_limit_pct,
    },
    upstream_enabled: await upstreamAllowed(env),
    chat_features: chatFeatures(env, who.userId),
    expiresAt: who.expiresAt,
  });
}

function limitParam(url, def = 50) {
  const n = parseInt(url.searchParams.get('limit') || String(def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, 200);
}

async function usageList({ request, env, url }) {
  const who = await identify(request, env);
  if (!who) return apiErr('unauthorized', 401);
  const { results } = await env.DB.prepare(
    `SELECT request_id, session_id, message_id, route, model, input_tokens, output_tokens,
            cached_tokens, cost_micro, reserved_micro, status, reconcile_reason,
            http_status, error_code, latency_ms, started_at, ended_at
       FROM usage_requests WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`
  ).bind(who.userId, limitParam(url)).all();
  return json({ requests: results });
}

async function ledgerList({ request, env, url }) {
  const who = await identify(request, env);
  if (!who) return apiErr('unauthorized', 401);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, amount_micro, balance_after, request_id, note, created_at
       FROM quota_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(who.userId, limitParam(url)).all();
  return json({ ledger: results });
}

// ---------- 对话持久化 ----------

function sessionIdFrom(path) {
  const id = path.split('/')[0];
  return id ? decodeURIComponent(id) : '';
}

/** 搜索结果里的 encrypted_content 客户端解不开、体积又大，入库前剥掉 */
function stripEncrypted(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) return block;
    return {
      ...block,
      content: block.content.map((item) =>
        item && typeof item === 'object' && 'encrypted_content' in item
          ? { ...item, encrypted_content: undefined }
          : item),
    };
  });
}

async function listSessions({ request, env, url }) {
  const who = await identify(request, env);
  if (!who) return apiErr('unauthorized', 401);
  const limit = limitParam(url, 100);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.created_at, s.updated_at, s.archived, s.pinned,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s
      WHERE s.user_id = ? AND s.deleted_at IS NULL
      ORDER BY s.updated_at DESC LIMIT ?`
  ).bind(who.userId, limit).all();
  return json({
    sessions: (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archived: !!r.archived,
      pinned: !!r.pinned,
      messageCount: r.message_count,
    })),
  });
}

async function getSession(env, userId, id) {
  const session = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at, root_message_id, selected_leaf_id, model, settings_json
       FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(id, userId).first();
  if (!session) return null;
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.parent_id, m.role, m.content_json, m.status, m.model, m.thinking, m.search,
            m.prefix, m.stop_reason, m.error_json, m.usage_json, m.created_at, m.updated_at
       FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = ? AND s.user_id = ?
      ORDER BY m.created_at ASC LIMIT ?`
  ).bind(id, userId, MAX_MESSAGES_PER_SESSION).all();
  return {
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      rootMessageId: session.root_message_id,
      selectedLeafId: session.selected_leaf_id,
      model: session.model,
      settings: safeJson(session.settings_json, {}),
    },
    messages: (results || []).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      content: safeJson(row.content_json, null),
      status: row.status,
      model: row.model,
      thinking: row.thinking === null ? null : !!row.thinking,
      search: row.search === null ? null : !!row.search,
      prefix: !!row.prefix,
      stopReason: row.stop_reason,
      error: safeJson(row.error_json, null),
      usage: safeJson(row.usage_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

/** 粗量一次推送里消息正文的体积，超限前先拒，避免写库阶段静默失败 */
function totalContentBytes(body) {
  const list = Array.isArray(body?.messages) ? body.messages : [];
  let total = 0;
  for (const message of list) {
    try {
      total += JSON.stringify(message ?? null).length;
    } catch (_) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (total > MAX_SESSION_PUSH_BYTES) return total;
  }
  return total;
}

function safeJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

async function sessionRoute({ request, env, path, method }) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const who = await identify(request, env);
  if (!who) return apiErr('unauthorized', 401);
  const id = sessionIdFrom(path.slice('/api/sessions/'.length));
  if (!id || id.length > 64) return apiErr('invalid session id', 400);

  if (method === 'GET') {
    if (sessionIdFrom(path.slice('/api/sessions/'.length)) !== id) return apiErr('invalid session id', 400);
    const data = await getSession(env, who.userId, id);
    if (!data) return apiErr('session not found', 404);
    return json(data);
  }
  if (method === 'PUT') return putSession(request, env, who.userId, id);
  if (method === 'PATCH') return patchSession(request, env, who.userId, id);
  if (method === 'DELETE') return deleteSession(request, env, who.userId, id);
  return apiErr('method not allowed', 405);
}

async function putSession(request, env, userId, id) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > MAX_SESSION_PUSH_BYTES) {
    return apiErr(`请求体过大（上限 ${MAX_SESSION_PUSH_BYTES / 1024 / 1024} MB），请分块推送`, 413);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return apiErr('invalid JSON body', 400);
  }
  // D1 单行上限 2MB：整份快照必须先量体积再写，否则会在写库里静默失败
  if (totalContentBytes(body) > MAX_SESSION_PUSH_BYTES) {
    return apiErr(`会话快照过大（上限 ${MAX_SESSION_PUSH_BYTES / 1024 / 1024} MB），请分块推送`, 413);
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // 单次推送超过上限会超 D1 查询预算；要求客户端按块推送，而不是静默截断
  if (messages.length > MAX_MESSAGES_PER_PUSH) {
    return apiErr(`too many messages in one request (max ${MAX_MESSAGES_PER_PUSH})`, 413);
  }

  // 归属：会话已存在且不属于当前用户 → 403；不存在 → 由 INSERT 建立归属
  const owner = await env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?').bind(id).first();
  if (owner && owner.user_id !== userId) return apiErr('forbidden', 403);

  const now = Date.now();
  const createdAt = Number(body.createdAt) || now;
  const updatedAt = Number(body.updatedAt) || now;
  const title = String(body.title ?? '').slice(0, MAX_TITLE_LEN);

  const statements = [
    env.DB.prepare(`INSERT INTO sessions
        (id, user_id, title, created_at, updated_at, archived, pinned,
         root_message_id, selected_leaf_id, model, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at,
        archived = excluded.archived,
        pinned = excluded.pinned,
        root_message_id = excluded.root_message_id,
        selected_leaf_id = excluded.selected_leaf_id,
        model = excluded.model,
        settings_json = excluded.settings_json
      WHERE sessions.user_id = excluded.user_id AND sessions.deleted_at IS NULL`)
      .bind(
        id, userId, title, createdAt, updatedAt,
        body.archived ? 1 : 0, body.pinned ? 1 : 0,
        body.rootMessageId ?? null, body.selectedLeafId ?? null,
        body.model ?? null, JSON.stringify(body.settings ?? {}),
      ),
  ];

  for (const message of messages) {
    if (!message?.id || !message.role) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = message.role === 'assistant'
      ? { ...message, blocks: stripEncrypted(message.blocks ?? []) }
      : message;
    // 消息归属：INSERT 时校验会话属于当前用户，UPDATE 时同时锁定会话与用户
    statements.push(
      env.DB.prepare(`INSERT INTO messages
          (id, session_id, parent_id, role, content_json, status, model, thinking,
           search, prefix, stop_reason, error_json, usage_json, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM sessions s WHERE s.id = ? AND s.user_id = ? AND s.deleted_at IS NULL
        ON CONFLICT(id) DO UPDATE SET
          content_json = excluded.content_json,
          status = excluded.status,
          stop_reason = excluded.stop_reason,
          error_json = excluded.error_json,
          usage_json = excluded.usage_json,
          updated_at = excluded.updated_at
        WHERE messages.session_id = excluded.session_id
          AND EXISTS (SELECT 1 FROM sessions s
                       WHERE s.id = messages.session_id AND s.user_id = ? AND s.deleted_at IS NULL)`)
        .bind(
          message.id, id, message.parentId ?? null, message.role,
          JSON.stringify(content), message.status ?? 'done',
          message.model ?? null,
          message.thinking === undefined ? null : (message.thinking ? 1 : 0),
          message.search === undefined ? null : (message.search ? 1 : 0),
          message.prefix ? 1 : 0,
          message.stopReason ?? null,
          message.error ? JSON.stringify(message.error) : null,
          message.usage ? JSON.stringify(message.usage) : null,
          Number(message.createdAt) || now,
          Number(message.updatedAt) || Number(message.createdAt) || now,
          id, userId, userId,
        ),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (e) {
    log('error', 'putSession', { userId: who(userId), sessionId: id, message: String(e?.message || e) });
    return apiErr('保存失败，稍后重试', 500);
  }
  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE token_id = ?')
    .bind(now, userId).run().catch(() => {});
  return json({ ok: true, saved: messages.length });
}

/** 日志里不写完整用户标识 */
function who(userId) {
  return String(userId || '').slice(0, 8);
}

async function patchSession(request, env, userId, id) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.title !== 'string') return apiErr('missing title', 400);
  const now = Date.now();
  const result = await env.DB
    .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(body.title.slice(0, MAX_TITLE_LEN), now, id, userId).run();
  if (!result.meta?.changes) return apiErr('session not found', 404);
  return json({ ok: true });
}

// DELETE：软删，30 天后由定时任务物理清理
async function deleteSession(request, env, userId, id) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const result = await env.DB
    .prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(Date.now(), id, userId).run();
  if (!result.meta?.changes) return apiErr('session not found', 404);
  return json({ ok: true });
}

// ---------- 上游转发 ----------

/** 出站只用固定基址 + 固定路径，不接受客户端拼路径 */
function upstreamUrl(env, path) {
  const base = String(env.DEEPSEEK_BASE_URL || '').replace(/\/+$/, '');
  return `${base}${path}`;
}

/** 只透传白名单头，鉴权换成 Worker 持有的 key */
function upstreamHeaders(env, request, { json: isJson = true, beta = false } = {}) {
  const h = new Headers();
  if (isJson) h.set('Content-Type', 'application/json');
  else {
    const ct = request.headers.get('Content-Type');
    if (ct) h.set('Content-Type', ct);
  }
  if (beta) h.set('anthropic-beta', 'files-api-2025-04-14');
  h.set('Authorization', `Bearer ${env.DEEPSEEK_API_KEY}`);
  return h;
}

/** 上游错误只记录，不把正文透给浏览器 */
async function upstreamFailure(env, requestId, upstream, route) {
  const text = await upstream.text().catch(() => '');
  log('error', 'upstream', { requestId, route, status: upstream.status, body: text.slice(0, 300) });
  return apiErr(`上游返回 ${upstream.status}`, 502, requestId);
}

async function proxyModels({ request, env, ctx }) {
  const whoIdent = await identify(request, env);
  if (!whoIdent) return apiErr('unauthorized', 401);
  touchSession(env, ctx, whoIdent.sessionId);
  const upstream = await fetch(upstreamUrl(env, '/models'), {
    headers: upstreamHeaders(env, request, { json: false }),
  });
  if (!upstream.ok) {
    const rid = crypto.randomUUID();
    return upstreamFailure(env, rid, upstream, '/models');
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 取套餐；老用户没有钱包时先开户，保证返回非空 */
async function planFor(env, userId) {
  const existing = await loadQuota(env, userId);
  if (existing) return existing;
  await ensureWallet(env, userId);
  return loadQuota(env, userId);
}

/** 估算请求的输入 token 与输出上界；超过单请求上限直接拒 */
function boundRequest(body) {
  const raw = JSON.stringify(body.messages ?? '') + JSON.stringify(body.system ?? '');
  const inputTokens = Math.ceil(raw.length / 3); // 粗估：中英混排约 3 字节/token
  const maxTokens = Math.min(Number(body.max_tokens) || 4096, 8192);
  return { inputTokens, maxTokens };
}

async function proxyMessages({ request, env, ctx }) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const whoIdent = await identify(request, env);
  if (!whoIdent) return apiErr('unauthorized', 401);
  touchSession(env, ctx, whoIdent.sessionId);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > MAX_BODY_BYTES) {
    return apiErr(`请求体过大（上限 ${MAX_BODY_BYTES / 1024 / 1024} MB）`, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return apiErr('invalid JSON body', 400);
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return apiErr('missing messages', 400);
  }
  if (body.messages.length > MAX_MESSAGES_PER_REQUEST) {
    return apiErr(`too many messages (max ${MAX_MESSAGES_PER_REQUEST})`, 413);
  }

  const config = chatConfig(env, whoIdent.userId, body);
  if (config.error) return apiErr(config.error, 400);
  const sanitized = sanitizeMessageBody(env, body, config, MAX_INPUT_TOKENS);
  if (!sanitized) return apiErr(`输入过长（上限约 ${MAX_INPUT_TOKENS} tokens）`, 413);

  // 文件引用必须属于当前用户：客户端传的是本地 id，转发前换成上游 id，
  // 免得任何人拿别人的 file_id 直接读我们账号下的文件
  const refs = await resolveFileRefs(env, whoIdent.userId, sanitized);
  if (!refs.ok) return apiErr('引用的附件不存在或不属于当前账号', 400);

  const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
  if (!/^[\w.:-]{8,64}$/.test(requestId)) return apiErr('invalid request id', 400);

  const plan = await planFor(env, whoIdent.userId);
  const { inputTokens, maxTokens } = boundRequest(sanitized);
  const estimated = estimateCost(plan, { inputTokens, maxTokens });

  const pre = await preflight(env, whoIdent.userId, {
    estimateMicro: estimated,
    rateLimit: parseInt(env.RATE_LIMIT_PER_MIN || '10', 10),
  });
  if (!pre.ok) return apiErr(pre.message || 'quota exceeded', pre.status || 429, requestId);

  // 先预占，再发上游：预占失败就没有出站调用
  const rsv = await reserve(env, {
    requestId,
    userId: whoIdent.userId,
    route: '/anthropic/v1/messages',
    model: env.MODEL,
    sessionId: clip(request.headers.get('x-session-id'), 64),
    messageId: clip(request.headers.get('x-message-id'), 64),
    amountMicro: estimated,
    plan: pre.plan || plan,
  });
  if (!rsv.ok) {
    if (rsv.duplicate) return apiErr('duplicate request_id', 409, requestId);
    return apiErr('额度不足', 402, requestId);
  }

  const startedAt = Date.now();
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (request.signal.aborted) stop();
  else request.signal.addEventListener('abort', stop, { once: true });
  const timer = config.search ? setTimeout(stop, CHAT_TIMEOUT_MS) : null;
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', stop);
  };
  const fetchModel = (payload, signal) => fetch(upstreamUrl(env, '/anthropic/v1/messages'), {
    method: 'POST',
    headers: upstreamHeaders(env, request, { json: true, beta: isFileRequest(payload) }),
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal,
  });
  let upstream;
  try {
    abort.signal.throwIfAborted();
    upstream = await fetchModel(sanitized, abort.signal);
  } catch (_) {
    cleanup();
    log('error', 'upstream-network', { requestId });
    await releaseRequest(env, requestId, whoIdent.userId, { errorCode: 'network' });
    return apiErr('上游连接失败', 502, requestId);
  }

  if (!upstream.ok || !upstream.body) {
    cleanup();
    log('warn', 'chat-upstream', { requestId, status: upstream.status });
    await upstream.body?.cancel().catch(() => {});
    const res = apiErr(`上游返回 ${upstream.status}`, 502, requestId);
    await releaseRequest(env, requestId, whoIdent.userId, {
      httpStatus: upstream.status, errorCode: 'upstream',
    });
    return res;
  }

  const responseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'x-request-id': requestId,
    ...(config.skillVersion && { 'x-skill-version': config.skillVersion }),
  };
  if (config.search) {
    const billingPlan = pre.plan || plan;
    const { stream, completion } = startChatLoop({
      firstResponse: upstream,
      initialBody: sanitized,
      abort,
      fetchModel,
      async search(query, signal) {
        const result = await searchFirecrawl(env, whoIdent.userId, query, signal);
        log('info', 'chat-search-outcome', { requestId, status: result.status, code: result.code });
        return result;
      },
      async allowContinuation(payload) {
        const bounds = boundRequest(payload);
        if (bounds.inputTokens > MAX_INPUT_TOKENS) return '当前对话过长，搜索后无法继续生成。';
        if (!(await reserveContinuation(env, requestId, whoIdent.userId, estimateCost(billingPlan, bounds)))) {
          return '模型额度不足，无法继续生成。';
        }
        return null;
      },
      onRound(round, usage, complete) {
        log('info', 'chat-model-round', { requestId, round, usage, complete });
      },
      async finish(usage, httpStatus, reason) {
        cleanup();
        try {
          await settle(env, {
            requestId, userId: whoIdent.userId, plan: billingPlan,
            usage, httpStatus, reason, latencyMs: Date.now() - startedAt,
          });
        } catch (_) {
          log('error', 'chat-settlement', { requestId });
        }
      },
    });
    ctx?.waitUntil?.(completion);
    return new Response(stream, { headers: responseHeaders });
  }

  // 普通对话沿用上游 SSE，旁路解析用量。
  const [clientBody, tapBody] = upstream.body.tee();
  const job = (async () => {
    try {
      const usage = await readUsage(tapBody);
      await settle(env, {
        requestId, userId: whoIdent.userId, plan: pre.plan || plan,
        usage, httpStatus: 200, latencyMs: Date.now() - startedAt,
      });
    } catch (_) {
      // 解析失败保留预占，交给定时任务转待对账。
      log('error', 'tap', { requestId });
    } finally {
      cleanup();
    }
  })();
  ctx?.waitUntil?.(job);

  return new Response(clientBody, { headers: responseHeaders });
}

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s ? s.slice(0, max) : null;
}

const ALLOWED_BODY_FIELDS = new Set([
  'max_tokens', 'messages', 'temperature', 'top_p', 'stop_sequences', 'thinking', 'metadata',
]);

function sanitizeMessageBody(env, body, config, maxInputTokens) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_BODY_FIELDS.has(key)) out[key] = value;
  }
  out.model = env.MODEL;
  out.stream = true;
  out.system = config.system;
  out.max_tokens = Math.max(1, Math.floor(boundRequest(out).maxTokens));
  // 只有 Worker 声明工具，普通对话保留现有的链接阅读。
  out.tools = config.search
    ? [SEARCH_TOOL]
    : [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }];
  // 输入侧总量上界：估算超过预算直接拒，避免一次请求把上下文撑爆
  const { inputTokens } = boundRequest(out);
  if (inputTokens > maxInputTokens) return null;
  return out;
}

/**
 * 收集消息体里的文件引用（image / document 的 source.file_id），
 * 按当前用户查归属，把本地 id 改写为上游 file_id。任何一个查不到就整体拒绝。
 */
const FILE_BLOCK_TYPES = new Set(['image', 'document']);

async function resolveFileRefs(env, userId, body) {
  const wanted = new Set();
  for (const message of body.messages ?? []) {
    if (typeof message?.content === 'string' || !Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (!FILE_BLOCK_TYPES.has(block?.type)) continue;
      const id = block?.source?.type === 'file' ? block.source.file_id : null;
      if (typeof id === 'string' && id) wanted.add(id);
    }
  }
  if (wanted.size === 0) return { ok: true };

  const ids = [...wanted];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, upstream_id FROM file_objects
      WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
  ).bind(userId, ...ids).all();

  const map = new Map((results || []).map((row) => [row.id, row.upstream_id]));
  if (map.size !== ids.length) return { ok: false };

  for (const message of body.messages) {
    if (typeof message?.content === 'string' || !Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (!FILE_BLOCK_TYPES.has(block?.type)) continue;
      if (block?.source?.type !== 'file') continue;
      const upstream = map.get(block.source.file_id);
      if (!upstream) return { ok: false };
      block.source.file_id = upstream;
    }
  }
  return { ok: true };
}

function isFileRequest(body) {
  return (body.messages || []).some(
    (m) => typeof m.content !== 'string'
      && Array.isArray(m.content)
      && m.content.some((b) => b?.type === 'image' || b?.type === 'document'),
  );
}

/** 逐帧读 SSE，取 message_start 的输入侧与 message_delta 的累计输出 */
async function readUsage(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  const absorb = (payload) => {
    const u = payload?.message?.usage ?? payload?.usage;
    if (u && typeof u === 'object') usage = { ...(usage || {}), ...u };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            absorb(JSON.parse(raw));
          } catch (_) {
            // 保活注释等非 JSON 帧
          }
        }
      }
    }
  } catch (e) {
    // 客户端断开或上游断流：已解析到的 usage 仍然有效，没有就交给回收
    if (usage) return usage;
    throw e;
  }
  return usage;
}

/**
 * 上传：按字节计量。
 * 先用 content-length 拦超大请求，再预占，最后由上游结果决定结算或释放。
 * 缺 content-length 时按套餐的 per_request 计价，不再放行白嫖路径。
 *
 * 客户端拿到的永远是本地 id；上游 file_id 只存在 file_objects 里，按用户归属查询。
 */
async function uploadFile({ request, env, ctx }) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const whoIdent = await identify(request, env);
  if (!whoIdent) return apiErr('unauthorized', 401);
  touchSession(env, ctx, whoIdent.sessionId);

  const plan = await planFor(env, whoIdent.userId);
  const limitMb = maxUploadMb(env, plan);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > limitMb * 1024 * 1024) {
    return apiErr(`file too large (max ${limitMb} MB)`, 413);
  }

  const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
  if (!/^[\w.:-]{8,64}$/.test(requestId)) return apiErr('invalid request id', 400);

  const perRequest = plan?.per_request_micro ?? 0;
  const estimate = declared > 0 ? computeUploadCost(plan, declared) : perRequest;
  const pre = await preflight(env, whoIdent.userId, {
    estimateMicro: estimate,
    rateLimit: parseInt(env.UPLOAD_RATE_LIMIT_PER_MIN || '20', 10),
  });
  if (!pre.ok) return apiErr(pre.message || 'quota exceeded', pre.status || 429, requestId);

  const rsv = await reserve(env, {
    requestId, userId: whoIdent.userId, route: '/anthropic/v1/files',
    model: null, amountMicro: Math.max(estimate, perRequest), plan: pre.plan || plan,
  });
  if (!rsv.ok) {
    if (rsv.duplicate) return apiErr('duplicate request_id', 409, requestId);
    return apiErr('额度不足', 402, requestId);
  }

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(upstreamUrl(env, '/anthropic/v1/files'), {
      method: 'POST',
      headers: upstreamHeaders(env, request, { json: false, beta: true }),
      body: request.body,
    });
  } catch (e) {
    log('error', 'upload-network', { requestId, message: String(e?.message || e) });
    await releaseRequest(env, requestId, whoIdent.userId, { errorCode: 'network' });
    return apiErr('上游连接失败', 502, requestId);
  }

  if (!upstream.ok) {
    const res = await upstreamFailure(env, requestId, upstream, '/anthropic/v1/files');
    await releaseRequest(env, requestId, whoIdent.userId, {
      httpStatus: upstream.status, errorCode: 'upstream',
    });
    return res;
  }

  const payload = await upstream.json().catch(() => null);
  const upstreamFileId = typeof payload?.id === 'string' ? payload.id : null;
  const bytes = declared > 0 ? declared : Number(payload?.size_bytes || 0);
  const costMicro = bytes > 0 ? computeUploadCost(pre.plan || plan, bytes) : perRequest;

  // 归属先落库，再对外发布本地 id：登记失败就不给客户端任何可用标识
  let localFileId = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO file_objects (id, user_id, upstream_id, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(localFileId, whoIdent.userId, upstreamFileId || '', bytes || 0, Date.now()).run();
  } catch (e) {
    log('error', 'file-ownership', { requestId, message: String(e?.message || e) });
    await settle(env, {
      requestId, userId: whoIdent.userId, plan: pre.plan || plan,
      usage: null, costMicro, httpStatus: 200, latencyMs: Date.now() - t0,
    }).catch(() => {});
    return apiErr('上传登记失败，请重试', 503, requestId);
  }

  await settle(env, {
    requestId, userId: whoIdent.userId, plan: pre.plan || plan,
    usage: null, costMicro, httpStatus: 200, latencyMs: Date.now() - t0,
  });

  return json({
    id: localFileId,
    type: 'file',
    size_bytes: bytes || 0,
    created_at: payload?.created_at ?? null,
    filename: typeof payload?.filename === 'string' ? payload.filename : null,
  }, 200, { 'x-request-id': requestId });
}
/**
 * 删除附件：先校验归属，再删上游，最后软删本地登记。
 * 上游失败不阻断本地清理，避免本地记录永久卡住。
 */
async function deleteFile({ request, env, path }) {
  if (!sameOriginWrite(request)) return apiErr('cross-site request rejected', 403);
  const whoIdent = await identify(request, env);
  if (!whoIdent) return apiErr('unauthorized', 401);

  const localId = decodeURIComponent(path.slice('/anthropic/v1/files/'.length));
  if (!localId || localId.length > 64) return apiErr('invalid file id', 400);

  const row = await env.DB.prepare(
    `SELECT upstream_id FROM file_objects
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(localId, whoIdent.userId).first();
  if (!row) return apiErr('file not found', 404);

  if (row.upstream_id) {
    const res = await fetch(upstreamUrl(env, `/anthropic/v1/files/${encodeURIComponent(row.upstream_id)}`), {
      method: 'DELETE',
      headers: upstreamHeaders(env, request, { json: false, beta: true }),
    }).catch(() => null);
    if (res && !res.ok && res.status !== 404) {
      log('warn', 'file-delete-upstream', { localId, status: res.status });
    }
  }

  await env.DB.prepare('UPDATE file_objects SET deleted_at = ? WHERE id = ? AND user_id = ?')
    .bind(Date.now(), localId, whoIdent.userId).run();
  return json({ ok: true }, 200);
}

/** 语音工具：预占按字节/字符估，结算按预占（工具不返回 usage） */
async function proxyTool({ request, env, ctx, path }) {
  const whoIdent = await identify(request, env);
  if (!whoIdent) return apiErr('unauthorized', 401);
  touchSession(env, ctx, whoIdent.sessionId);

  const plan = await planFor(env, whoIdent.userId);
  const declared = Number(request.headers.get('content-length') || 0);
  const isAsr = path === '/v1/tools/asr';
  if (isAsr && declared && declared > 12 * 1024 * 1024) {
    return apiErr('音频过大（上限 12 MB）', 413);
  }
  const perRequest = plan?.per_request_micro ?? 0;
  const estimate = perRequest + (declared > 0 ? computeUploadCost(plan, declared) : 0);

  const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
  if (!/^[\w.:-]{8,64}$/.test(requestId)) return apiErr('invalid request id', 400);

  const pre = await preflight(env, whoIdent.userId, {
    estimateMicro: estimate,
    rateLimit: parseInt(env.UPLOAD_RATE_LIMIT_PER_MIN || '20', 10),
  });
  if (!pre.ok) return apiErr(pre.message || 'quota exceeded', pre.status || 429, requestId);

  const rsv = await reserve(env, {
    requestId, userId: whoIdent.userId, route: path, model: null,
    amountMicro: estimate, plan: pre.plan || plan,
  });
  if (!rsv.ok) {
    if (rsv.duplicate) return apiErr('duplicate request_id', 409, requestId);
    return apiErr('额度不足', 402, requestId);
  }

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(upstreamUrl(env, path), {
      method: 'POST',
      headers: upstreamHeaders(env, request, {
        json: !isAsr,
      }),
      body: request.body,
    });
  } catch (e) {
    log('error', 'tool-network', { requestId, route: path, message: String(e?.message || e) });
    await releaseRequest(env, requestId, whoIdent.userId, { errorCode: 'network' });
    return apiErr('上游连接失败', 502, requestId);
  }

  if (!upstream.ok) {
    const res = await upstreamFailure(env, requestId, upstream, path);
    await releaseRequest(env, requestId, whoIdent.userId, {
      httpStatus: upstream.status, errorCode: 'upstream',
    });
    return res;
  }

  // 工具接口没有 usage：按预占金额结算（不产生待对账）
  await settle(env, {
    requestId, userId: whoIdent.userId, plan: pre.plan || plan,
    usage: null, costMicro: estimate, httpStatus: 200, latencyMs: Date.now() - t0,
  });

  const headers = new Headers();
  const ct = upstream.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'no-store');
  headers.set('x-request-id', requestId);
  return new Response(upstream.body, { status: 200, headers });
}
