// model-test-demo Worker：鉴权 / 配额 / Skill 注入 / 流式转发

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ---------- Token（HMAC 签名，无状态） ----------

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function issueToken(secret, tokenId, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${tokenId}.${exp}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(secret, token, ignoreExpiry = false) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tokenId, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!tokenId || Number.isNaN(exp)) return null;
  if (!ignoreExpiry && exp < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(secret, `${tokenId}.${expStr}`);
  if (expected !== sig) return null;
  return tokenId;
}

// ---------- 配额 ----------

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function checkQuota(env, tokenId) {
  const limit = parseInt(env.DAILY_QUOTA, 10);
  const row = await env.DB
    .prepare('SELECT count FROM quota WHERE token_id = ? AND day = ?')
    .bind(tokenId, today()).first();
  const used = row ? row.count : 0;
  return { ok: used < limit, used, limit };
}

async function incrQuota(env, tokenId) {
  await env.DB
    .prepare(`INSERT INTO quota (token_id, day, count) VALUES (?, ?, 1)
              ON CONFLICT(token_id, day) DO UPDATE SET count = count + 1`)
    .bind(tokenId, today()).run();
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/login' && request.method === 'POST') return login(request, env);
      if (path === '/api/skills' && request.method === 'GET') return listSkills(request, env);
      if (path === '/api/chat' && request.method === 'POST') return chat(request, env);
      if (path === '/api/me' && request.method === 'GET') return me(request, env);

      // DeepSeek API 同源透传（chat-demo 前端的聊天/附件/语音/模型列表）
      if (path === '/models' && request.method === 'GET') return proxyModels(request, env);
      if (path.startsWith('/anthropic/v1/')) return proxyAnthropic(request, env, path);
      if (path.startsWith('/v1/tools/')) return proxyTools(request, env, path);

      return err('not found', 404);
    } catch (e) {
      return err('internal: ' + e.message, 500);
    }
  },
};

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function currentUser(request, env) {
  const tokenId = await verifyToken(env.AUTH_SECRET, bearer(request));
  if (!tokenId) return null;
  const user = await env.DB
    .prepare('SELECT token_id FROM users WHERE token_id = ?')
    .bind(tokenId).first();
  return user || null;
}

// POST /api/login { code: "邀请码", token?: "旧 Token（续签用）" }
async function login(request, env) {
  const { code, token: oldToken } = await request.json();
  if (!code) return err('missing code');
  const invite = await env.DB
    .prepare('SELECT code, used_by FROM invite_codes WHERE code = ?')
    .bind(String(code).trim()).first();
  if (!invite) return err('invalid invite code', 401);
  if (invite.used_by) {
    // 续签：邀请码已用，但请求者持有该用户合法签名的旧 token（允许已过期）→ 换发新 token
    const tokenId = await verifyToken(env.AUTH_SECRET, oldToken, true);
    if (!tokenId || tokenId !== invite.used_by) return err('invite code already used', 401);
    const fresh = await issueToken(env.AUTH_SECRET, tokenId, 30 * 24 * 3600);
    return json({ token: fresh });
  }

  const tokenId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (token_id) VALUES (?)').bind(tokenId),
    env.DB.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
      .bind(tokenId, new Date().toISOString(), invite.code),
  ]);

  const token = await issueToken(env.AUTH_SECRET, tokenId, 30 * 24 * 3600);
  return json({ token });
}

// GET /api/me → 今日配额
async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return err('unauthorized', 401);
  const q = await checkQuota(env, user.token_id);
  return json({ quota: q });
}

// GET /api/skills → Skill 列表
async function listSkills(request, env) {
  const { results } = await env.DB
    .prepare('SELECT id, name, description FROM skills ORDER BY id').all();
  return json({ skills: results });
}

// POST /api/chat { messages: [...], skill_id?: number }
async function chat(request, env) {
  const user = await currentUser(request, env);
  if (!user) return err('unauthorized', 401);

  const body = await request.json();
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err('missing messages');
  }

  // 配额
  const q = await checkQuota(env, user.token_id);
  if (!q.ok) return err(`daily quota exceeded (${q.used}/${q.limit})`, 429);

  // 模型：服务端固定，忽略客户端传入的任何 model
  const model = env.MODEL;

  // Skill 注入
  let messages = body.messages;
  if (body.skill_id) {
    const skill = await env.DB
      .prepare('SELECT system_prompt FROM skills WHERE id = ?')
      .bind(body.skill_id).first();
    if (skill) {
      messages = [{ role: 'system', content: skill.system_prompt }, ...messages];
    }
  }

  await incrQuota(env, user.token_id);

  // 转发 DeepSeek，流式透传
  const upstream = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return err(`upstream ${upstream.status}: ${text.slice(0, 200)}`, 502);
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...CORS,
    },
  });
}

// ---------- DeepSeek API 同源透传 ----------
// chat-demo 前端直连 /models、/anthropic/v1/*、/v1/tools/*；
// Worker 校验访问 Token、注入真实 API Key 后转发，model 字段一律服务端覆盖。

function apiErr(message, status) {
  // Anthropic 风格错误体，前端 readErrorResponse 可直接取出 message
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function tokenFrom(request) {
  return request.headers.get('x-api-key') || bearer(request);
}

async function proxyUser(request, env) {
  const tokenId = await verifyToken(env.AUTH_SECRET, tokenFrom(request));
  if (!tokenId) return null;
  const user = await env.DB
    .prepare('SELECT token_id FROM users WHERE token_id = ?')
    .bind(tokenId).first();
  return user ? tokenId : null;
}

// 透传必要请求头（Content-Type 携带 multipart 边界），鉴权换成 Worker 持有的 key
function forwardHeaders(request, env) {
  const h = new Headers();
  for (const name of ['content-type', 'anthropic-beta']) {
    const v = request.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set('Authorization', `Bearer ${env.DEEPSEEK_API_KEY}`);
  return h;
}

async function passthrough(request, env, path) {
  const upstream = await fetch(`${env.DEEPSEEK_BASE_URL}${path}`, {
    method: request.method,
    headers: forwardHeaders(request, env),
    body: request.body,
  });
  const headers = new Headers(upstream.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function proxyModels(request, env) {
  if (!await proxyUser(request, env)) return apiErr('invalid or expired login', 401);
  return passthrough(request, env, '/models');
}

async function proxyAnthropic(request, env, path) {
  const tokenId = await proxyUser(request, env);
  if (!tokenId) return apiErr('invalid or expired login', 401);

  if (path === '/anthropic/v1/messages' && request.method === 'POST') {
    const q = await checkQuota(env, tokenId);
    if (!q.ok) return apiErr(`daily quota exceeded (${q.used}/${q.limit})`, 429);

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return apiErr('invalid JSON body', 400);
    }
    body.model = env.MODEL; // 服务端强制覆盖，客户端不可自选
    await incrQuota(env, tokenId);

    const upstream = await fetch(`${env.DEEPSEEK_BASE_URL}${path}`, {
      method: 'POST',
      headers: forwardHeaders(request, env),
      body: JSON.stringify(body),
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return apiErr(`upstream ${upstream.status}: ${text.slice(0, 200)}`, 502);
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...CORS,
      },
    });
  }

  // Files API（上传 / 删除附件）
  return passthrough(request, env, path);
}

async function proxyTools(request, env, path) {
  if (!await proxyUser(request, env)) return apiErr('invalid or expired login', 401);
  return passthrough(request, env, path); // /v1/tools/asr、/v1/tools/tts
}
