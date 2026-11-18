import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/index.js';
import { issueSession, reserve, reserveContinuation, settle } from '../src/core.js';

const USER = 'tester-0000-4000-8000-000000000000';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['schema-v2.sql', 'quota.sql', 'hardening.sql', 'firecrawl.sql']) {
    const sql = readFileSync(new URL(`../../db/${name}`, import.meta.url), 'utf8');
    sqlite.exec(sql);
  }
  const DB = {
    prepare(sql) {
      const bind = (...params) => {
        if (/\?1\b/.test(sql)) {
          params = params.slice();
          const named = Object.fromEntries(params.map((arg, i) => [String(i + 1), arg]));
          params = [named];
        }
        const statement = sqlite.prepare(sql);
        const runSync = () => {
          const results = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
          return { success: true, results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
        };
        return {
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => runSync(),
          runSync,
        };
      };
      return { bind };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, DB };
}

function model(payload, tool = false, preamble = '') {
  const block = tool ? { type: 'tool_use', id: 'tool-search-1', name: 'firecrawl_search', input: {} }
    : { type: 'text', text: '参考 https://example.com/reference' };
  const index = preamble ? 1 : 0;
  const events = [
    { type: 'message_start', message: { id: 'msg-model', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    ...(preamble ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: preamble } },
      { type: 'content_block_stop', index: 0 },
    ] : []),
    { type: 'content_block_start', index, content_block: block },
    ...(tool ? ['{"query":', '"公开资料"}'].map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })) : []),
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { input_tokens: 20, output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('authenticated Worker search, Skill, and duplicate settlement', async (t) => {
  const { sqlite, DB } = database();
  t.after(() => sqlite.close());
  const env = {
    DB, DEEPSEEK_BASE_URL: 'https://model.example.com', DEEPSEEK_API_KEY: 'fixture-model-key',
    FIRECRAWL_API_KEY: 'fc-fixtureonlyvalue', MODEL: 'deepseek-flash',
    CHAT_FIRECRAWL_ENABLED: 'true', CHAT_INDUSTRY_ANALYST_ENABLED: 'true',
  };
  sqlite.prepare('INSERT INTO users(token_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(USER, 1, 1);
  const { token } = await issueSession(env, USER, 60_000);
  const models = [];
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    if (new URL(url).hostname === 'model.example.com') {
      assert.equal(options.redirect, 'manual');
      models.push(payload);
      assert.ok(!options.body.includes(env.FIRECRAWL_API_KEY));
      return model(payload, models.length === 1);
    }
    assert.equal(options.headers.get('authorization'), `Bearer ${env.FIRECRAWL_API_KEY}`);
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (payload.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26' } });
    }
    searches++;
    assert.equal(payload.params.name, 'firecrawl_search');
    assert.equal(payload.params.arguments.query, '公开资料');
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: { structuredContent: { data: { web: [
      { url: 'https://example.com/reference?signature=discard', title: '参考资料', description: `说明 ${env.FIRECRAWL_API_KEY}` },
    ] } } } });
  });
  const jobs = [];
  const ctx = { waitUntil: (job) => jobs.push(job) };
  const chat = (id, flags) => worker.fetch(new Request('https://app.example.com/anthropic/v1/messages', {
    method: 'POST', headers: { Cookie: `dsh_session=${token}`, 'x-request-id': id, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '查找公开资料' }], system: 'untrusted instructions', tools: [{ name: 'untrusted' }], ...flags }),
  }), env, ctx);
  const account = (bindings) => worker.fetch(new Request('https://app.example.com/api/me', {
    headers: { Cookie: `dsh_session=${token}` },
  }), bindings, ctx).then((response) => response.json());
  assert.deepEqual((await account(env)).chat_features, { industry_analyst: true, smart_search: true });
  assert.deepEqual((await account({ ...env, CHAT_FEATURE_PREVIEW_USERS: 'other-account' })).chat_features,
    { industry_analyst: false, smart_search: false });
  assert.equal((await chat('invalid-flag', { smart_search: 1 })).status, 400);
  const response = await chat('research-1', { smart_search: true, industry_analyst: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-skill-version'), 'industry-analyst@1');
  const stream = await response.text();
  await Promise.all(jobs);
  assert.equal(searches, 1);
  assert.equal(models.length, 2);
  assert.match(models[0].system, /行业分析师/);
  assert.deepEqual(models[0].tools.map((tool) => tool.name), ['firecrawl_search']);
  assert.deepEqual(models[1].messages.at(-1).content.filter((block) => block.type === 'tool_result').map((result) => result.tool_use_id), ['tool-search-1']);
  assert.match(stream, /web_search_tool_result/);
  assert.match(stream, /https:\/\/example.com\/reference/);
  assert.ok(!stream.includes(env.FIRECRAWL_API_KEY) && !stream.includes('signature=discard'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quota_ledger WHERE request_id = ?').get('research-1').n, 1);
  const usage = sqlite.prepare('SELECT input_tokens, output_tokens, status FROM usage_requests WHERE request_id = ?').get('research-1');
  assert.deepEqual({ ...usage }, { input_tokens: 40, output_tokens: 14, status: 'settled' });
  assert.equal((await chat('research-1', { smart_search: true })).status, 409);
  assert.equal(searches, 1);
  assert.equal(models.length, 2);
  const ordinary = await chat('ordinary-1', {});
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get('x-skill-version'), null);
  assert.match(await ordinary.text(), /message_stop/);
  await Promise.all(jobs);
  assert.doesNotMatch(models[2].system, /行业分析师|untrusted instructions/);
  assert.equal(searches, 1);
  const billing = { requestId: 'concurrent-settle', userId: USER, route: '/anthropic/v1/messages', amountMicro: 100 };
  assert.equal((await reserve(env, billing)).ok, true);
  assert.equal(await reserveContinuation(env, billing.requestId, billing.userId, 100), true);
  const settlements = await Promise.all([settle(env, billing), settle(env, billing)]);
  assert.equal(settlements.filter(({ settled }) => settled).length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quota_ledger WHERE request_id = ?').get(billing.requestId).n, 1);
});

function twoSearchModel(payload, tool) {
  const blocks = tool ? [0, 1].map((n) => ({ type: 'tool_use', id: `tool-search-${n + 1}`, name: 'firecrawl_search', input: {} }))
    : [{ type: 'text', text: '综合两次检索的结论' }];
  const events = [
    { type: 'message_start', message: { id: 'msg-two', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block },
      ...(tool ? [`{"query":"公开资料"}`, `{"query":"补充资料"}`].slice(index, index + 1).map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })) : []),
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('Worker answers from results after the per-turn search budget runs out', { timeout: 10_000 }, async (t) => {
  const { sqlite, DB } = database();
  t.after(() => sqlite.close());
  const env = {
    DB, DEEPSEEK_BASE_URL: 'https://model.example.com', DEEPSEEK_API_KEY: '{{SECRET_9ncmfwce}}',
    FIRECRAWL_API_KEY: '{{SECRET_kcfmntwt}}', MODEL: 'deepseek-flash', CHAT_FIRECRAWL_ENABLED: 'true',
  };
  sqlite.prepare('INSERT INTO users(token_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(USER, 1, 1);
  const { token } = await issueSession(env, USER, 60_000);
  const bodies = [];
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    if (new URL(url).hostname === 'model.example.com') {
      bodies.push(payload);
      return twoSearchModel(payload, bodies.length === 1);
    }
    if (payload.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26' } });
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
    queries.push(payload.params.arguments.query);
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: { structuredContent: { data: { web: [
      { url: `https://example.com/${payload.params.arguments.query}`, title: '参考资料', description: '摘要' },
    ] } } } });
  });
  const jobs = [];
  const response = await worker.fetch(new Request('https://app.example.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { Cookie: `dsh_session=${token}`, 'x-request-id': 'two-searches', 'Content-Type': 'application/json' },
    body: JSON.stringify({ smart_search: true, messages: [{ role: 'user', content: '查两个来源' }] }),
  }), env, { waitUntil: (job) => jobs.push(job) });
  const stream = await response.text();
  await Promise.all(jobs);
  assert.equal(response.status, 200);
  assert.deepEqual(queries, ['公开资料', '补充资料']);
  assert.equal(bodies.length, 2);
  const results = bodies[1].messages.at(-1).content;
  assert.equal(results.filter((block) => block.type === 'tool_result').length, 2);
  assert.match(results.at(-1).text, /检索次数已用完/);
  assert.deepEqual(bodies[1].tool_choice, { type: 'none' });
  assert.match(stream, /综合两次检索的结论/);
  assert.match(bodies[0].system, /没有抓取正文/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM firecrawl_search_attempts').get().n, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quota_ledger WHERE request_id = ?').get('two-searches').n, 1);
});

for (const scenario of ['empty', 'auth-failure', 'stop']) {
  test(`Worker handles Firecrawl ${scenario} during a streamed reply`, { timeout: 10_000 }, async (t) => {
    const { sqlite, DB } = database();
    t.after(() => sqlite.close());
    const env = {
      DB,
      DEEPSEEK_BASE_URL: 'https://model.example.com',
      DEEPSEEK_API_KEY: 'model-fixture-credential',
      FIRECRAWL_API_KEY: 'firecrawl-fixture-credential',
      MODEL: 'deepseek-flash',
      CHAT_FIRECRAWL_ENABLED: 'true',
    };
    sqlite.prepare('INSERT INTO users(token_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(USER, 1, 1);
    const { token } = await issueSession(env, USER, 60_000);
    const requestId = `search-${scenario}`;
    const jobs = [];
    const modelBodies = [];
    const dispatched = Promise.withResolvers();
    let searchCount = 0;
    let searchSignal;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const payload = JSON.parse(options.body);
      if (new URL(url).hostname === 'model.example.com') {
        modelBodies.push(payload);
        return model(payload, modelBodies.length === 1, modelBodies.length === 1 ? '已生成的正文' : '');
      }
      if (payload.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26' } });
      }
      if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
      assert.equal(payload.method, 'tools/call');
      searchCount++;
      if (scenario === 'empty') {
        return Response.json({ jsonrpc: '2.0', id: payload.id, result: { structuredContent: { data: { web: [] } } } });
      }
      if (scenario === 'auth-failure') return new Response(env.FIRECRAWL_API_KEY, { status: 401 });
      searchSignal = options.signal;
      dispatched.resolve();
      return new Promise((_, reject) => {
        searchSignal.addEventListener('abort', () => reject(searchSignal.reason), { once: true });
      });
    });
    const response = await worker.fetch(new Request('https://app.example.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { Cookie: `dsh_session=${token}`, 'x-request-id': requestId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ smart_search: true, messages: [{ role: 'user', content: '查找公开资料' }] }),
    }), env, { waitUntil: (job) => jobs.push(job) });
    assert.equal(response.status, 200);
    if (scenario === 'stop') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (!received.includes('server_tool_use')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(received, /已生成的正文/);
      await dispatched.promise;
      await reader.cancel();
      assert.equal(searchSignal.aborted, true);
    } else {
      const expected = scenario === 'empty' ? 'no_results' : 'unavailable';
      const received = await response.text();
      assert.ok(received.includes(expected));
      assert.match(received, /event: message_stop/);
      assert.ok(!received.includes(env.FIRECRAWL_API_KEY));
      const continuation = modelBodies[1];
      assert.equal(continuation.messages.at(-1).content[0].is_error, true);
      assert.ok(!JSON.stringify(continuation).includes(env.FIRECRAWL_API_KEY));
      if (scenario === 'auth-failure') assert.deepEqual(continuation.tool_choice, { type: 'none' });
    }
    await Promise.all(jobs);
    const rounds = scenario === 'stop' ? 1 : 2;
    assert.equal(modelBodies.length, rounds);
    assert.equal(searchCount, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM firecrawl_search_attempts').get().n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM quota_ledger WHERE request_id = ?').get(requestId).n, 1);
    const usage = sqlite.prepare('SELECT input_tokens, output_tokens, status, http_status FROM usage_requests WHERE request_id = ?').get(requestId);
    assert.deepEqual({ ...usage }, {
      input_tokens: 20 * rounds, output_tokens: 7 * rounds, status: 'settled', http_status: scenario === 'stop' ? 499 : 200,
    });
  });
}
