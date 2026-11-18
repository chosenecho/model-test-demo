import { SEARCH_TOOL, searchQuery } from './chat-config.js';

export const MAX_SEARCH_CALLS = 2;
export const MAX_MODEL_ROUNDS = MAX_SEARCH_CALLS + 1;
export const CHAT_TIMEOUT_MS = 90_000;
const MAX_EVENT_CHARS = 256 * 1024;
const MAX_ROUND_BLOCKS = 128;
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'];

const toolErrors = {
  quota_exhausted: '今日搜索额度已用完',
  unavailable: '网页搜索暂不可用',
  no_results: '没有找到相关网页',
  tool_limit: '本轮搜索次数已达上限',
  invalid_query: '网页搜索参数无效',
  exhausted_hint: '本轮检索次数已用完，请直接基于上面的检索结果作答，不要输出工具调用格式。',
};

async function* messageEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let dataSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) {
            const raw = data.join('\n');
            data = [];
            dataSize = 0;
            if (raw !== '[DONE]') yield JSON.parse(raw);
          }
        } else if (line.startsWith('data:')) {
          dataSize += line.length;
          if (dataSize > MAX_EVENT_CHARS) throw new Error('event too large');
          data.push(line.slice(5).trimStart());
        }
      }
      if (buffer.length > MAX_EVENT_CHARS) throw new Error('event too large');
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function absorbUsage(target, update) {
  for (const field of USAGE_FIELDS) {
    if (Number.isSafeInteger(update?.[field]) && update[field] >= 0) target[field] = update[field];
  }
}

function appendDelta(block, delta) {
  switch (delta?.type) {
    case 'text_delta': block.text += delta.text; break;
    case 'thinking_delta': block.thinking += delta.thinking; break;
    case 'signature_delta': block.signature = (block.signature ?? '') + delta.signature; break;
    case 'input_json_delta': block.partial += delta.partial_json; break;
  }
}

async function readRound(upstream, emit, allocateIndex, firstRound, usage, signal) {
  const blocks = new Map();
  let terminal;
  for await (const event of messageEvents(upstream.body)) {
    signal.throwIfAborted();
    switch (event.type) {
      case 'message_start':
        absorbUsage(usage, event.message?.usage);
        if (firstRound) emit(event);
        break;
      case 'content_block_start': {
        if (blocks.size >= MAX_ROUND_BLOCKS || blocks.has(event.index)) throw new Error('invalid blocks');
        const block = { ...event.content_block };
        if (block.type === 'tool_use') {
          block.partial = '';
          blocks.set(event.index, { block });
        } else if (['text', 'thinking', 'redacted_thinking'].includes(block.type)) {
          const index = allocateIndex();
          blocks.set(event.index, { block, index });
          emit({ ...event, index });
        }
        break;
      }
      case 'content_block_delta': {
        const entry = blocks.get(event.index);
        if (!entry) break;
        appendDelta(entry.block, event.delta);
        if (entry.block.partial?.length > MAX_EVENT_CHARS) throw new Error('tool input too large');
        if (entry.index !== undefined) emit({ ...event, index: entry.index });
        break;
      }
      case 'content_block_stop': {
        const entry = blocks.get(event.index);
        if (!entry) break;
        if (entry.index !== undefined) emit({ ...event, index: entry.index });
        else {
          const { block } = entry;
          if (block.partial) {
            try { block.input = JSON.parse(block.partial); } catch (_) { block.input = {}; }
          }
          delete block.partial;
        }
        break;
      }
      case 'message_delta':
        absorbUsage(usage, event.usage);
        terminal = event;
        break;
      case 'message_stop':
        if (!terminal) throw new Error('missing message delta');
        return { content: [...blocks.values()].map(({ block }) => block), terminal };
      case 'error': throw new Error('upstream stream error');
    }
  }
  throw new Error('incomplete model stream');
}

function displayTool(emitBlock, call, query) {
  emitBlock({ type: 'server_tool_use', id: call.id, name: SEARCH_TOOL.name, kind: 'search', input: { action: 'search', queries: query ? [query] : [] } });
}

function displayResult(emitBlock, call, results, errorCode) {
  emitBlock({
    type: 'web_search_tool_result', tool_use_id: call.id, kind: 'search',
    content: errorCode ? [{ type: 'web_search_tool_result_error', error_code: errorCode }]
      : results.map(({ title, url, snippet }) => ({ type: 'web_search_result', title, url, snippet })),
  });
}

export function startChatLoop({ firstResponse, initialBody, abort, fetchModel, search, finish, onRound, allowContinuation }) {
  let nextIndex = 0;
  let canceled = false;
  const allocateIndex = () => nextIndex++;
  const signal = abort.signal;
  const aggregate = {};
  let missingUsage = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const emit = (event) => {
        if (!canceled) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const emitBlock = (content_block) => {
        const index = allocateIndex();
        emit({ type: 'content_block_start', index, content_block });
        emit({ type: 'content_block_stop', index });
      };
      const run = async () => {
        let upstream = firstResponse;
        let body = initialBody;
        let searches = 0;
        let round = 0;
        let status = 200;
        let reason;
        try {
          while (round < MAX_MODEL_ROUNDS) {
            signal.throwIfAborted();
            const usage = {};
            let next;
            try {
              next = await readRound(upstream, emit, allocateIndex, round === 0, usage, signal);
            } finally {
              round++;
              const complete = Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens) && Boolean(next);
              missingUsage ||= !complete;
              for (const [field, amount] of Object.entries(usage)) aggregate[field] = (aggregate[field] ?? 0) + amount;
              onRound(round, usage, complete);
            }
            const calls = next.content.filter((block) => block.type === 'tool_use');
            if (next.terminal.delta?.stop_reason !== 'tool_use') {
              emit({ ...next.terminal, usage: aggregate });
              emit({ type: 'message_stop' });
              break;
            }
            if (!calls.length || !body.tools || round >= MAX_MODEL_ROUNDS) throw new Error('unexpected tool round');
            const results = [];
            let disableSearch = false;
            for (const call of calls) {
              signal.throwIfAborted();
              const query = searchQuery(call);
              displayTool(emitBlock, call, query);
              let errorCode;
              let items = [];
              if (!query) errorCode = 'invalid_query';
              else if (searches >= MAX_SEARCH_CALLS) errorCode = 'tool_limit';
              else if (disableSearch) errorCode = 'unavailable';
              else {
                searches++;
                const response = await search(query, signal);
                signal.throwIfAborted();
                if (response.status === 'ok') {
                  items = response.results;
                  if (!items.length) errorCode = 'no_results';
                } else {
                  errorCode = response.status === 'quota' ? 'quota_exhausted' : 'unavailable';
                  disableSearch = true;
                }
              }
              displayResult(emitBlock, call, items, errorCode);
              results.push({ type: 'tool_result', tool_use_id: call.id, ...(errorCode && { is_error: true }), content: errorCode ? toolErrors[errorCode] : JSON.stringify(items) });
            }
            body = { ...body, messages: [...body.messages, { role: 'assistant', content: next.content }, { role: 'user', content: results }] };
            const exhausted = searches >= MAX_SEARCH_CALLS;
            if (exhausted && !disableSearch) {
              body.messages.at(-1).content.push({ type: 'text', text: toolErrors.exhausted_hint });
            }
            if (disableSearch || exhausted || round === MAX_MODEL_ROUNDS - 1) {
              body.tool_choice = { type: 'none' };
            }
            const continuationError = await allowContinuation(body);
            signal.throwIfAborted();
            if (continuationError) {
              emitBlock({ type: 'text', text: continuationError });
              emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: aggregate });
              emit({ type: 'message_stop' });
              break;
            }
            let response;
            try { response = await fetchModel(body, signal); } catch (error) {
              missingUsage = true;
              throw error;
            }
            if (!response.ok || !response.body) {
              await response.body?.cancel().catch(() => {});
              throw new Error('continuation upstream rejected');
            }
            upstream = response;
          }
        } catch (_) {
          status = signal.aborted ? 499 : 502;
          reason = signal.aborted ? 'chat canceled or timed out' : 'tool loop interrupted';
          if (!canceled) emit({ type: 'error', error: { type: 'api_error', message: signal.aborted ? '本轮响应已停止或超时' : '对话响应中断，请重试' } });
        } finally {
          if (!canceled) controller.close();
          try {
            await finish(missingUsage || !round ? null : aggregate, status, reason);
          } finally {
            resolveCompletion();
          }
        }
      };
      void run().catch(() => {});
    },
    cancel() {
      canceled = true;
      abort.abort();
    },
  });
  return { stream, completion };
}
