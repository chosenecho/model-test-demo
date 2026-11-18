import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { searchFirecrawl } from '../src/firecrawl.js';

const schema = readFileSync(new URL('../../db/firecrawl.sql', import.meta.url), 'utf8');
const hkToday = '2026-11-18';
const hkTomorrow = '2026-11-19';
const beforeMidnight = Date.parse('2026-11-18T15:59:59.999Z');
const key = 'fc-EXAMPLE_TEST_ONLY';
const url = 'https://example.org/reference';
const USER = '6f1f2c90-0000-4000-8000-000000000001';
const OTHER_USER = '6f1f2c90-0000-4000-8000-000000000002';

function fixture(t, { afterReserve, searchReply, initializeReply, onReady, now = beforeMidnight } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              const params = Object.fromEntries(args.map((value, i) => [`?${i + 1}`, value]));
              const { changes } = sqlite.prepare(sql).run(params);
              if (sql.startsWith('INSERT')) afterReserve?.(changes, args[0]);
              return { success: true, meta: { changes } };
            },
          };
        },
      };
    },
  };
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    const { headers, signal } = options;
    const rpc = JSON.parse(options.body);
    calls.push(rpc.method);
    assert.equal(endpoint, 'https://mcp.firecrawl.dev/v2/mcp');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'POST');
    assert.equal(headers.get('authorization'), `Bearer ${key}`);
    assert.equal(headers.get('accept'), 'application/json, text/event-stream');
    assert.equal(options.body.includes(key), false);
    if (rpc.method === 'initialize') {
      assert.equal(headers.has('mcp-session-id'), false);
      assert.equal(rpc.params.protocolVersion, '2025-03-26');
      return initializeReply ? initializeReply() : rpcJson(rpc.id, { protocolVersion: '2025-03-26' }, { 'Mcp-Session-Id': 'test-session-id' });
    }
    assert.equal(headers.get('mcp-session-id'), 'test-session-id');
    assert.equal(headers.get('mcp-protocol-version'), '2025-03-26');
    if (rpc.method === 'notifications/initialized') {
      onReady?.();
      assert.equal(rpc.id, undefined);
      return new Response(null, { status: 202 });
    }
    assert.equal(rpc.method, 'tools/call');
    assert.equal(rpc.params.name, 'firecrawl_search');
    assert.deepEqual(rpc.params.arguments, {
      query: 'documentation', objective: 'Find public reference pages relevant to the user’s research question.',
      limit: 5, sources: ['web'], domainTools: false, highlights: false,
    });
    return searchReply ? searchReply(rpc.id, signal) : rpcJson(rpc.id, structured([]));
  });
  return {
    calls,
    env: { DB: db, FIRECRAWL_API_KEY: key },
    setTime(value) { now = value; },
    seed(day, count, userId = USER) {
      const insert = sqlite.prepare('INSERT INTO firecrawl_search_attempts (user_id, hk_day, attempt_id) VALUES (?, ?, ?)');
      for (let i = 0; i < count; i++) insert.run(userId, day, `seed-${userId}-${i}`);
    },
    count(day, userId = USER) {
      return sqlite.prepare('SELECT COUNT(*) AS total FROM firecrawl_search_attempts WHERE user_id = ? AND hk_day = ?').get(userId, day).total;
    },
  };
}

function rpcJson(id, result, headers = {}) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers });
}

function structured(web) {
  return { structuredContent: { success: true, data: { web } } };
}

function search(env, signal, userId = USER) {
  return searchFirecrawl(env, userId, '  documentation  ', signal);
}

test('validates query, cancellation and Worker bindings before reserving or fetching', async t => {
  const f = fixture(t);
  const aborted = AbortSignal.abort('private abort reason');
  for (const query of [null, '', '   ', 'x'.repeat(513), `look up ${key}`]) {
    assert.deepEqual(await searchFirecrawl(f.env, USER, query), { status: 'error', code: 'invalid_query' });
  }
  assert.deepEqual(await search(f.env, aborted), { status: 'error', code: 'aborted' });
  assert.deepEqual(await search({ DB: f.env.DB }), { status: 'error', code: 'unavailable' });
  for (const userId of [undefined, '', 'short', 'x'.repeat(65), 'bad id\n']) {
    assert.deepEqual(await searchFirecrawl(f.env, userId, 'documentation'), { status: 'error', code: 'unavailable' });
  }
  assert.equal(f.count(hkToday), 0);
  assert.deepEqual(f.calls, []);
});

test('accepts JSON structured content and filters credentials and unsafe links', async t => {
  const f = fixture(t, {
    searchReply: id => rpcJson(id, structured([
      { url: `${url}?unrecognizable_credential=hidden#hidden`, title: `Guide ${key}`, description: 'See https://name:private@example.org/ or Bearer abc123' },
      { url: `${url}#duplicate`, title: 'Duplicate' },
      { url: 'file:///tmp/private' },
      { url: 'https://name:private@example.org/' },
      { url: 'https://docs.localhost/' },
      { url: 'http://127.0.0.1/' },
      { url: 'http://[::1]/' },
      { url: 'https://example.org/access_token/private' },
      { url: `https://example.org/%66${key.slice(1)}` },
      { url: `${url}/b`, title: '字'.repeat(180), description: '🚀'.repeat(425) },
      ...Array.from({ length: 5 }, (_, i) => ({ url: `${url}/${i}` })),
    ])),
  });
  const result = await search(f.env);
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 5);
  assert.deepEqual(result.results[0], { url, title: 'Guide [redacted]', snippet: 'See [link removed] or [redacted]' });
  assert.deepEqual(result.results[1], { url: `${url}/b`, title: '字'.repeat(160), snippet: '🚀'.repeat(400) });
  assert.deepEqual(result.results.slice(2).map(entry => entry.url), [0, 1, 2].map(i => `${url}/${i}`));
  assert.equal(f.count(hkToday), 1);
  assert.deepEqual(f.calls, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('reads split SSE frames and UTF-8, using MCP text fallback without waiting for EOF', async t => {
  let cancelled = false;
  const f = fixture(t, {
    searchReply: id => {
      const payload = JSON.stringify({ success: true, data: { web: [{ url, title: '中文', description: 'summary' }] } });
      const result = JSON.stringify({ id, result: { content: [{ type: 'text', text: payload }] } });
      const sse = `: heartbeat\r\n\r\ndata:\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: {"jsonrpc":"2.0","id":99,"result":{}}\r\rdata: {"jsonrpc":"2.0",\r\ndata: ${result.slice(1)}\r\n\r\n`;
      const bytes = new TextEncoder().encode(sse);
      return new Response(new ReadableStream({
        start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    },
  });
  assert.deepEqual(await search(f.env), { status: 'ok', results: [{ url, title: '中文', snippet: 'summary' }] });
  assert.equal(cancelled, true);
  assert.equal(f.count(hkToday), 1);
});

test('an atomic D1 statement allows only one of two requests at 199', async t => {
  const f = fixture(t);
  f.seed(hkToday, 199);
  const results = await Promise.all([search(f.env), search(f.env)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['ok', 'quota']);
  assert.equal(f.count(hkToday), 200);
  assert.deepEqual(f.calls, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('the daily cap applies per user, not to the whole project', async t => {
  const f = fixture(t);
  f.seed(hkToday, 199);
  assert.deepEqual(await search(f.env), { status: 'ok', results: [] });
  assert.deepEqual(await search(f.env), { status: 'quota' });
  assert.equal(f.count(hkToday), 200);
  assert.equal(f.count(hkToday, OTHER_USER), 0);
  assert.deepEqual(await search(f.env, undefined, OTHER_USER), { status: 'ok', results: [] });
  assert.equal(f.count(hkToday, OTHER_USER), 1);
  assert.equal(f.count(hkToday), 200);
});

test('releases an unsent reservation after MCP initialization fails', async t => {
  const f = fixture(t, { initializeReply: () => new Response(key, { status: 401 }) });
  assert.deepEqual(await search(f.env), { status: 'error', code: 'upstream' });
  assert.equal(f.count(hkToday), 0);
  assert.deepEqual(f.calls, ['initialize']);
});

test('releases an unsent reservation when D1 commits but loses the response', async t => {
  const f = fixture(t, { afterReserve: () => { throw new Error(key); } });
  assert.deepEqual(await search(f.env), { status: 'error', code: 'quota_unavailable' });
  assert.equal(f.count(hkToday), 0);
  assert.deepEqual(f.calls, []);
});

test('releases an unsent reservation when aborted during D1 allocation', async t => {
  const controller = new AbortController();
  const f = fixture(t, { afterReserve: () => controller.abort(key) });
  assert.deepEqual(await search(f.env, controller.signal), { status: 'error', code: 'aborted' });
  assert.equal(f.count(hkToday), 0);
  assert.deepEqual(f.calls, []);
});

test('uses the new Hong Kong date when initialization completes across midnight', async t => {
  const f = fixture(t, { onReady: () => f.setTime(beforeMidnight + 1) });
  f.seed(hkToday, 199);
  assert.deepEqual(await search(f.env), { status: 'ok', results: [] });
  assert.equal(f.count(hkToday), 199);
  assert.equal(f.count(hkTomorrow), 1);
  assert.deepEqual(f.calls, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('rechecks the date after receiving a quota rejection around midnight', async t => {
  const f = fixture(t, { afterReserve: (_, day) => { if (day === hkToday) f.setTime(beforeMidnight + 1); } });
  f.seed(hkToday, 200);
  assert.deepEqual(await search(f.env), { status: 'ok', results: [] });
  assert.equal(f.count(hkToday), 200);
  assert.equal(f.count(hkTomorrow), 1);
});

test('releases an old-day reservation when the new day is already full', async t => {
  const f = fixture(t, { onReady: () => f.setTime(beforeMidnight + 1) });
  f.seed(hkTomorrow, 200);
  assert.deepEqual(await search(f.env), { status: 'quota' });
  assert.equal(f.count(hkToday), 0);
  assert.equal(f.count(hkTomorrow), 200);
  assert.deepEqual(f.calls, ['initialize', 'notifications/initialized']);
});

test('keeps the charge after HTTP, network, tool and response-size failures', async t => {
  const fixtures = [
    () => new Response(key, { status: 429 }),
    () => { throw new Error(key); },
    id => rpcJson(id, { isError: true, content: [{ type: 'text', text: key }] }),
    id => rpcJson(id, structured([{ url, title: 'x'.repeat(256 * 1024) }])),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '262145' } }),
    id => Response.json({ jsonrpc: '2.0', id, error: { code: -32602, message: key } }),
  ];
  let reply;
  const f = fixture(t, { searchReply: id => reply(id) });
  for (reply of fixtures) assert.deepEqual(await search(f.env), { status: 'error', code: 'upstream' });
  assert.equal(f.count(hkToday), fixtures.length);
  assert.equal(f.calls.filter(method => method === 'tools/call').length, fixtures.length);
});

test('cancels an ongoing stream and keeps the charge after dispatch', async t => {
  const controller = new AbortController();
  let cancelled = false;
  const f = fixture(t, {
    searchReply: () => new Response(new ReadableStream({
      pull() { controller.abort(key); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  assert.deepEqual(await search(f.env, controller.signal), { status: 'error', code: 'aborted' });
  assert.equal(cancelled, true);
  assert.equal(f.count(hkToday), 1);
});

test('times out and keeps the charge after dispatch', async t => {
  let timeout;
  const setTimeoutReal = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 15_000) timeout = callback;
    return setTimeoutReal(callback, ms, ...args);
  });
  const f = fixture(t, {
    searchReply: () => new Response(new ReadableStream({ pull() { timeout(); } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assert.deepEqual(await search(f.env), { status: 'error', code: 'timeout' });
  assert.equal(f.count(hkToday), 1);
});

test('logs fixed fields only, with no key, query text or result URL', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'error', line => lines.push(line));
  t.mock.method(console, 'warn', line => lines.push(line));
  const f = fixture(t, {
    searchReply: id => rpcJson(id, structured([{ url, title: 'Documentation', description: 'reference page' }])),
  });
  f.seed(hkToday, 199);
  assert.equal((await search(f.env)).status, 'ok');
  assert.equal((await search(f.env)).status, 'quota');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.includes(key), false);
    assert.equal(line.includes('example.org'), false);
    assert.equal(line.includes('documentation'), false);
    const event = JSON.parse(line);
    assert.equal(event.event, 'firecrawl-search');
    const allowed = ['at', 'code', 'count', 'event', 'level', 'ms', 'status'];
    for (const field of Object.keys(event)) assert.ok(allowed.includes(field), field);
  }
});

test('fails closed on D1 errors and does not expose diagnostics', async t => {
  const f = fixture(t);
  f.env.DB.prepare = () => { throw new Error(key); };
  assert.deepEqual(await search(f.env), { status: 'error', code: 'quota_unavailable' });
  assert.deepEqual(f.calls, []);
});
