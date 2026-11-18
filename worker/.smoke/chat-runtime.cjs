const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const root = resolve(__dirname, '../..');
const requireWrangler = createRequire(resolve(process.argv[2] ?? 'worker/node_modules/wrangler/package.json'));
const { Miniflare, Response, convertV4MiniflareOptions } = requireWrangler('miniflare');
const modelOrigin = 'https://model.example.test';
const mcpOrigin = 'https://mcp.firecrawl.dev';
const reference = 'https://example.org/reference';
const modelCredential = 'runtime-smoke-model-fixture';
const mcpCredential = 'runtime-smoke-mcp-fixture';

function modelStream(block, stopReason) {
  const usage = { input_tokens: 12, output_tokens: 4 };
  const events = [
    { type: 'message_start', message: { id: 'fixture-msg', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('workerd handles chat, MCP continuations, quota exhaustion and redirects', { timeout: 30_000 }, async (t) => {
  let modelCalls = 0;
  let searchCalls = 0;
  const unexpectedRequests = [];
  const modulesRoot = resolve(root, 'worker/src');
  const options = convertV4MiniflareOptions({
    modules: ['index', 'core', 'chat-config', 'chat-loop', 'firecrawl'].map((name) => ({
      type: 'ESModule', path: resolve(modulesRoot, `${name}.js`),
    })),
    modulesRoot,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'chat-runtime-smoke' },
    bindings: {
      DEEPSEEK_BASE_URL: modelOrigin, DEEPSEEK_API_KEY: modelCredential, FIRECRAWL_API_KEY: mcpCredential,
      MODEL: 'deepseek-flash', CHAT_INDUSTRY_ANALYST_ENABLED: 'true', CHAT_FIRECRAWL_ENABLED: 'true',
    },
  });
  options.workers[0].dev.outboundService = {
    type: 'fetcher',
    async handler(request) {
      if (request.url === `${mcpOrigin}/v2/mcp`) {
        assert.equal(request.headers.get('Authorization'), `Bearer ${mcpCredential}`);
        const rpc = await request.json();
        const reply = (result) => Response.json({ jsonrpc: '2.0', id: rpc.id, result });
        if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-03-26' });
        if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
        assert.equal(rpc.method, 'tools/call');
        assert.equal(rpc.params.name, 'firecrawl_search');
        searchCalls++;
        return reply({ structuredContent: { data: { web: [{ title: 'Reference', url: reference }] } } });
      }
      if (request.url !== `${modelOrigin}/anthropic/v1/messages`) {
        unexpectedRequests.push(request.url);
        return new Response(null, { status: 500 });
      }
      assert.equal(request.headers.get('Authorization'), `Bearer ${modelCredential}`);
      modelCalls++;
      const body = await request.json();
      assert.equal(body.model, 'deepseek-flash');
      assert.doesNotMatch(body.system, /client-owned/);
      if (body.messages[0].content === 'redirect') {
        return Response.redirect('https://redirect.example.test/', 307);
      }
      if (body.tools.some((tool) => tool.name === 'firecrawl_search')) {
        assert.match(body.system, /行业分析师/);
        if (body.messages.length === 1) {
          const block = { type: 'tool_use', id: 'fixture-call', name: 'firecrawl_search', input: { query: 'Cloudflare Workers' } };
          return modelStream(block, 'tool_use');
        }
        const result = body.messages.at(-1).content[0];
        assert.equal(result.tool_use_id, 'fixture-call');
        if (result.is_error) {
          assert.equal(result.content, '今日搜索额度已用完');
          assert.deepEqual(body.tool_choice, { type: 'none' });
        } else {
          assert.equal(JSON.parse(result.content)[0].url, reference);
        }
      }
      return modelStream({ type: 'text', text: 'Fixture reply' }, 'end_turn');
    },
  };
  const mf = new Miniflare(options);
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const migration of ['schema-v2', 'quota', 'hardening', 'firecrawl']) {
    const sql = readFileSync(resolve(root, `db/${migration}.sql`), 'utf8').replace(/^\s*--.*$/gm, '');
    for (const stmt of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
  const origin = 'https://runtime.example.test';
  const request = (path, init) => mf.dispatchFetch(origin + path, init);
  assert.equal((await request('/api/me')).status, 401);
  const jsonHeaders = { 'Content-Type': 'application/json', Origin: origin };
  const loginWithInvite = async (code) => {
    const hash = createHash('sha256').update(`dsh-invite-v1:${code}`).digest('hex');
    await db.prepare('INSERT INTO invite_codes (code, code_hash) VALUES (?, ?)').bind(code, hash).run();
    const login = await request('/api/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ code }) });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('Set-Cookie');
    assert.match(cookieHeader, /HttpOnly/i);
    return cookieHeader.split(';')[0];
  };
  const cookie = await loginWithInvite('runtime-smoke-invite');
  const account = await request('/api/me', { headers: { Cookie: cookie } });
  assert.equal(account.status, 200);
  assert.deepEqual((await account.json()).chat_features, { industry_analyst: true, smart_search: true });

  const chat = (id, content, flags = {}, sessionCookie = cookie) => request('/anthropic/v1/messages', {
    method: 'POST',
    headers: { ...jsonHeaders, Cookie: sessionCookie, 'x-request-id': id },
    body: JSON.stringify({ messages: [{ role: 'user', content }], system: 'client-owned', ...flags }),
  });
  const ordinary = await chat('runtime-ordinary', 'hello');
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get('x-skill-version'), null);
  assert.match(await ordinary.text(), /event: message_stop/);
  const searchFlags = { industry_analyst: true, smart_search: true };
  const search = await chat('runtime-search', 'search', searchFlags);
  assert.equal(search.status, 200);
  assert.equal(search.headers.get('x-skill-version'), 'industry-analyst@1');
  const stream = await search.text();
  assert.match(stream, /web_search_tool_result/);
  assert.ok(stream.includes(reference));
  assert.ok(!stream.includes(mcpCredential));
  assert.match(stream, /event: message_stop/);
  assert.equal((await chat('runtime-search', 'search', searchFlags)).status, 409);
  assert.equal((await chat('runtime-redirect', 'redirect')).status, 502);
  assert.deepEqual(unexpectedRequests, []);
  assert.equal(modelCalls, 4);
  assert.equal(searchCalls, 1);

  const deadline = Date.now() + 5000;
  let usage;
  do {
    usage = await db.prepare('SELECT status, input_tokens, output_tokens FROM usage_requests WHERE request_id = ?').bind('runtime-search').first();
    if (usage.status === 'settled') break;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  } while (Date.now() < deadline);
  assert.deepEqual(usage, { status: 'settled', input_tokens: 24, output_tokens: 8 });
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM firecrawl_search_attempts').first('n'), 1);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM quota_ledger WHERE request_id = ?').bind('runtime-search').first('n'), 1);

  const peerCookie = await loginWithInvite('runtime-smoke-peer');
  const day = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const seedAttempts = db.prepare(`WITH RECURSIVE attempts(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM attempts WHERE n < 199
  ) INSERT INTO firecrawl_search_attempts (hk_day, attempt_id)
    SELECT ?, 'seed-' || n FROM attempts
    WHERE n <= 199 - (SELECT COUNT(*) FROM firecrawl_search_attempts WHERE hk_day = ?)`);
  await seedAttempts.bind(day, day).run();
  const countForDay = () => db.prepare('SELECT COUNT(*) AS n FROM firecrawl_search_attempts WHERE hk_day = ?').bind(day).first('n');
  assert.equal(await countForDay(), 199);
  const competing = await Promise.all([
    chat('runtime-quota-a', 'search', searchFlags),
    chat('runtime-quota-b', 'search', searchFlags, peerCookie),
  ]);
  assert.deepEqual(competing.map((response) => response.status), [200, 200]);
  const streams = await Promise.all(competing.map((response) => response.text()));
  for (const result of streams) {
    assert.match(result, /Fixture reply/);
    assert.match(result, /event: message_stop/);
  }
  assert.equal(streams.filter((result) => result.includes('quota_exhausted')).length, 1);
  assert.equal(streams.filter((result) => result.includes(reference)).length, 1);
  assert.equal(searchCalls, 2);
  assert.equal(await countForDay(), 200);
  const fallback = await chat('runtime-after-quota', 'hello', {}, peerCookie);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /event: message_stop/);
  assert.equal(searchCalls, 2);
  assert.deepEqual(unexpectedRequests, []);

  for (const sessionCookie of [cookie, peerCookie]) {
    assert.equal((await request('/api/logout', { method: 'POST', headers: { Origin: origin, Cookie: sessionCookie } })).status, 200);
    assert.equal((await request('/api/me', { headers: { Cookie: sessionCookie } })).status, 401);
  }
});
