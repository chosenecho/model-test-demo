import { log } from './core.js';

const ENDPOINT = 'https://mcp.firecrawl.dev/v2/mcp';const PROTOCOL = '2025-03-26';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL, '2025-06-18', '2025-11-25']);
const DAILY_CAP = 200;
const SEARCH_LIMIT = 5;
const MAX_QUERY_CHARS = 512;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_URL_CHARS = 2048;
const TIMEOUT_MS = 15_000;
const HK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
});

// The count and write execute as one SQLite statement against the D1 primary.
// 额度按用户计算：只统计同一 user_id 当天的行。
const RESERVE = `INSERT INTO firecrawl_search_attempts (user_id, hk_day, attempt_id)
  SELECT ?4, ?1, ?2
  WHERE (SELECT COUNT(*) FROM firecrawl_search_attempts WHERE user_id = ?4 AND hk_day = ?1) < ?3`;
const RELEASE = `DELETE FROM firecrawl_search_attempts
  WHERE user_id = ?3 AND hk_day = ?1 AND attempt_id = ?2`;

function hkDay() {
  const parts = HK_DATE.formatToParts(Date.now());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function failure(code) {
  return { status: 'error', code };
}

async function reserve(db, day, id, userId) {
  const { success, meta } = await db.prepare(RESERVE).bind(day, id, DAILY_CAP, userId).run();
  if (!success || (meta?.changes !== 0 && meta?.changes !== 1)) throw new Error();
  return meta.changes === 1;
}

async function release(db, day, id, userId) {
  const { success } = await db.prepare(RELEASE).bind(day, id, userId).run();
  if (!success) throw new Error();
}

function discardBody(body) {
  // Some stream cancellation promises do not resolve until the peer disconnects.
  if (body) void body.cancel().catch(() => {});
}

function rpcResponse(message, id) {
  const messages = Array.isArray(message) ? message : [message];
  return messages.find(item => item?.jsonrpc === '2.0' && item.id === id &&
    !Object.hasOwn(item, 'method') && (Object.hasOwn(item, 'result') || Object.hasOwn(item, 'error')));
}

function sseResponse(id) {
  let pending = '';
  let data = [];
  let skipLf = false;
  return text => {
    if (!text) return;
    if (skipLf && text.startsWith('\n')) text = text.slice(1);
    skipLf = text.endsWith('\r');
    if (!/[\r\n]/.test(text)) {
      pending += text;
      return;
    }
    const lines = text.split(/\r\n|\r|\n/);
    lines[0] = pending + lines[0];
    pending = lines.pop();
    for (const line of lines) {
      if (line === '') {
        if (!data.length) continue;
        const event = data.join('\n');
        data = [];
        if (event === '') continue;
        const message = rpcResponse(JSON.parse(event), id);
        if (message) return message;
      } else if (line === 'data' || line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };
}

async function readRpc(response, id, signal) {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES ||
      (type !== 'application/json' && type !== 'text/event-stream')) {
    discardBody(response.body);
    throw new Error();
  }
  const collectSse = type === 'text/event-stream' ? sseResponse(id) : null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => discardBody(reader);
  let bytes = 0;
  let json = '';
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (!done && (bytes += value.byteLength) > MAX_RESPONSE_BYTES) throw new Error();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (collectSse) {
        const result = collectSse(text);
        if (result) return result;
      } else {
        json += text;
        if (done) {
          const result = rpcResponse(JSON.parse(json), id);
          if (result) return result;
        }
      }
      if (done) throw new Error();
    }
  } finally {
    signal.removeEventListener('abort', abort);
    discardBody(reader);
    reader.releaseLock();
  }
}

function rpcBody(method, id, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, id, params });
}

function post(headers, body, signal) {
  return fetch(ENDPOINT, { method: 'POST', headers, body, signal, redirect: 'manual' });
}

async function initialize(headers, signal) {
  const init = await post(headers, rpcBody('initialize', 1, {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'model-test-demo-search', version: '1.0.0' },
  }), signal);
  const message = await readRpc(init, 1, signal);
  const version = message.result?.protocolVersion;
  if (Object.hasOwn(message, 'error') || !SUPPORTED_PROTOCOLS.has(version)) throw new Error();
  headers.set('MCP-Protocol-Version', version);
  const session = init.headers.get('Mcp-Session-Id');
  if (session !== null) {
    if (!/^[\x21-\x7e]{1,512}$/.test(session)) throw new Error();
    headers.set('Mcp-Session-Id', session);
  }
  const ready = await post(headers, rpcBody('notifications/initialized'), signal);
  discardBody(ready.body);
  if (ready.status !== 202) throw new Error();
}

const FIRECRAWL_KEY = /fc-[a-z\d_-]{8,}/i;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|home|onion|alt|test|invalid)$/i;
const CREDENTIAL_PATH = /(?:\/|;)(?:access[-_]?token|api[-_]?key|auth[-_]?token|secret|password|signature)(?:\/|=|;)/i;

function resultUrl(raw, key) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS || CONTROL.test(raw)) return null;
  let url;
  let decoded;
  try {
    url = new URL(raw);
    decoded = decodeURIComponent(url.hostname + url.pathname);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, '');
  // Return public-looking DNS links only. The Worker never follows these URLs.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/^[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z][a-z\d-]*$/i.test(host) || PRIVATE_SUFFIX.test(host) ||
      CONTROL.test(decoded) || CREDENTIAL_PATH.test(decoded) || FIRECRAWL_KEY.test(decoded) ||
      decoded.toLowerCase().includes(key.toLowerCase())) return null;
  // Signed links and arbitrary credential parameter names are indistinguishable here.
  url.search = '';
  url.hash = '';
  return url.href;
}

function resultText(value, key, limit) {
  if (typeof value !== 'string') return '';
  const output = value.split(key).join('[redacted]')
    .replace(/fc-[a-z\d_-]{8,}/gi, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+|\b[\w.%+-]+:[^\s@]+@[^\s<>"']+/gi, '[link removed]')
    .replace(/\b(?:bearer|basic)\s+[a-z\d._~+/=-]+/gi, '[redacted]')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return Array.from(output).slice(0, limit).join('');
}

function webResults(message, key) {
  const result = message.result;
  if (Object.hasOwn(message, 'error') || !result || result.isError) throw new Error();
  // MCP supports structured output plus a JSON-serialized text block for older clients.
  const text = result.content?.find?.(item => item?.type === 'text')?.text;
  const payload = result.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null);
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || payload.success === false || payload.error) throw new Error();
  const web = data.web ?? [];
  if (!Array.isArray(web)) throw new Error();
  const results = [];
  const seen = new Set();
  for (const item of web) {
    const url = resultUrl(item?.url, key);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: resultText(item.title, key, 160), snippet: resultText(item.description ?? item.snippet, key, 400) });
    if (results.length === SEARCH_LIMIT) break;
  }
  return results;
}

/** Search through the hosted Firecrawl MCP endpoint using the caller's own daily D1 allocation. */
export async function searchFirecrawl(env, userId, query, signal) {
  const startedAt = Date.now();
  // Telemetry carries fixed fields only: never the query, a URL, a header or an upstream body.
  const done = outcome => {
    const count = outcome.results?.length;
    const level = outcome.status === 'ok' ? 'info'
      : outcome.status === 'quota' || outcome.code === 'invalid_query' || outcome.code === 'aborted' ? 'warn' : 'error';
    log(level, 'firecrawl-search', { status: outcome.status, code: outcome.code, count, ms: Date.now() - startedAt });
    return outcome;
  };
  if (typeof query !== 'string' || query.length > MAX_QUERY_CHARS || !query.trim()) return done(failure('invalid_query'));
  if (typeof userId !== 'string' || !/^[\w.:-]{8,64}$/.test(userId)) return done(failure('unavailable'));
  if (signal?.aborted) return done(failure('aborted'));
  const key = env?.FIRECRAWL_API_KEY;
  const db = env?.DB;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(key) || !db) return done(failure('unavailable'));
  if (query.includes(key) || FIRECRAWL_KEY.test(query)) return done(failure('invalid_query'));

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
  let reservationDay;
  let dispatched = false;
  let errorCode = 'quota_unavailable';
  const id = crypto.randomUUID();
  const headers = new Headers({
    Authorization: `Bearer ${key}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  });
  const body = rpcBody('tools/call', 2, { name: 'firecrawl_search', arguments: {
    query: query.trim(),
    objective: 'Find public reference pages relevant to the user’s research question.',
    limit: SEARCH_LIMIT,
    sources: ['web'],
    domainTools: false,
    highlights: false,
  } });
  try {
    let initialized = false;
    while (!controller.signal.aborted) {
      const day = hkDay();
      errorCode = 'quota_unavailable';
      // Keep the ID available for cleanup if D1 commits but the response is lost.
      reservationDay = day;
      if (!await reserve(db, day, id, userId)) {
        reservationDay = undefined;
        if (hkDay() !== day) continue;
        if (controller.signal.aborted) break;
        return done({ status: 'quota' });
      }
      if (controller.signal.aborted) break;
      if (hkDay() === day && !initialized) {
        errorCode = 'upstream';
        await initialize(headers, controller.signal);
        initialized = true;
      }
      if (controller.signal.aborted) break;
      if (hkDay() !== day) {
        errorCode = 'quota_unavailable';
        await release(db, day, id, userId);
        reservationDay = undefined;
        continue;
      }
      // No await between the day check and dispatch. After calling fetch, delivery
      // is uncertain even when fetch fails, so the reservation stays charged.
      errorCode = 'upstream';
      dispatched = true;
      const response = await post(headers, body, controller.signal);
      const results = webResults(await readRpc(response, 2, controller.signal), key);
      controller.signal.throwIfAborted();
      return done({ status: 'ok', results });
    }
  } catch {
    // RPC bodies, transport errors, D1 diagnostics and abort reasons stay private.
  } finally {
    if (reservationDay && !dispatched) {
      // Deleting by unique ID is idempotent and cannot refund another attempt.
      await release(db, reservationDay, id, userId).catch(() => {});
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  return done(failure(signal?.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : errorCode));
}
