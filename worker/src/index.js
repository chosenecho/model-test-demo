// model-test-demo Worker：鉴权 / VIP 模型映射 / 配额 / Skill 注入 / 流式转发

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

async function verifyToken(secret, token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tokenId, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!tokenId || Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(secret, `${tokenId}.${expStr}`);
  if (expected !== sig) return null;
  return tokenId;
}

// ---------- 配额 ----------

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function checkQuota(env, tokenId, tier) {
  const limit = parseInt(tier === 1 ? env.DAILY_QUOTA_TIER1 : env.DAILY_QUOTA_TIER0, 10);
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
    .prepare('SELECT token_id, tier FROM users WHERE token_id = ?')
    .bind(tokenId).first();
  return user || null;
}

// POST /api/login { code: "邀请码" }
async function login(request, env) {
  const { code } = await request.json();
  if (!code) return err('missing code');
  const invite = await env.DB
    .prepare('SELECT code, tier, used_by FROM invite_codes WHERE code = ?')
    .bind(String(code).trim()).first();
  if (!invite) return err('invalid invite code', 401);
  if (invite.used_by) return err('invite code already used', 401);

  const tokenId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (token_id, tier) VALUES (?, ?)').bind(tokenId, invite.tier),
    env.DB.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
      .bind(tokenId, new Date().toISOString(), invite.code),
  ]);

  const token = await issueToken(env.AUTH_SECRET, tokenId, 30 * 24 * 3600);
  return json({ token, tier: invite.tier });
}

// GET /api/me → 用户等级 + 今日配额
async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return err('unauthorized', 401);
  const q = await checkQuota(env, user.token_id, user.tier);
  return json({ tier: user.tier, quota: q });
}

// GET /api/skills → 可见 Skill 列表（按等级过滤）
async function listSkills(request, env) {
  const user = await currentUser(request, env);
  const tier = user ? user.tier : 0;
  const { results } = await env.DB
    .prepare('SELECT id, name, description, min_tier FROM skills WHERE min_tier <= ? ORDER BY id')
    .bind(tier).all();
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
  const q = await checkQuota(env, user.token_id, user.tier);
  if (!q.ok) return err(`daily quota exceeded (${q.used}/${q.limit})`, 429);

  // 模型：按等级强制映射，忽略客户端传入的任何 model
  const model = user.tier === 1 ? env.MODEL_TIER1 : env.MODEL_TIER0;

  // Skill 注入
  let messages = body.messages;
  if (body.skill_id) {
    const skill = await env.DB
      .prepare('SELECT system_prompt, min_tier FROM skills WHERE id = ?')
      .bind(body.skill_id).first();
    if (skill && user.tier >= skill.min_tier) {
      messages = [{ role: 'system', content: skill.system_prompt }, ...messages];
    } else if (skill) {
      return err('skill requires higher tier', 403);
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
