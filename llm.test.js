import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { askConversation, checkLLMStatus, formatLLMStatus } from './llm.js';
import { audit, formatAuditLine } from './audit-log.js';

const KEY = 'synthetic-credential-sentinel';
const PROMPT = 'synthetic-prompt-sentinel';
const RESPONSE = 'synthetic-response-sentinel';
const keys = ['OPENROUTER_API_KEY'];
let saved;
let events;
test.beforeEach((t) => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = KEY;
  events = [];
  t.mock.method(audit, 'info', (meta) => events.push({ level: 'INFO', meta }));
  t.mock.method(audit, 'error', (meta) => events.push({ level: 'ERROR', meta }));
});
test.afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const completion = (content = RESPONSE, model = 'test/model:free') => ({ model, choices: [{ message: { role: 'assistant', content } }] });

test('conversation sends one exact bounded OpenRouter request and no provider fallback', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return response(completion(`  ${RESPONSE}  `));
  });
  const result = await askConversation(PROMPT, 'system-contract');
  assert.deepEqual(result, { ok: true, text: RESPONSE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'openrouter/free', messages: [{ role: 'system', content: 'system-contract' }, { role: 'user', content: PROMPT }],
    max_tokens: 512, stream: false, reasoning: { enabled: false, exclude: true }, provider: { data_collection: 'deny' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].meta.requested_model, 'openrouter/free');
  assert.equal(events[0].meta.model, undefined);
  assert.equal(events[0].meta.outcome, 'ok');
  const logs = events.map(({ level, meta }) => formatAuditLine(level, meta)).join('\n');
  for (const secret of [KEY, PROMPT, RESPONSE]) assert.equal(logs.includes(secret), false);
});

test('missing conversation key never fetches', async (t) => {
  delete process.env.OPENROUTER_API_KEY;
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  assert.deepEqual(await askConversation(PROMPT), { ok: false, reason: 'no-key' });
  assert.equal(mock.mock.callCount(), 0);
});

for (const [status, reason] of [[401, 'invalid-key'], [403, 'invalid-key'], [402, 'quota'], [404, 'unavailable'], [429, 'rate-limited'], [500, 'unavailable'], [503, 'unavailable']]) {
  test(`HTTP ${status} has closed reason, no retry, no raw error read or log`, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
      ok: false, status, body: { cancel: async () => {} },
      text: () => { throw new Error(KEY); }, json: () => { throw new Error(KEY); },
    }));
    const errorLog = t.mock.method(console, 'error', () => {});
    assert.deepEqual(await askConversation(PROMPT), { ok: false, reason });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(errorLog.mock.callCount(), 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.outcome, 'error');
    assert.equal(JSON.stringify(events).includes(KEY), false);
  });
}

for (const [label, body, reason] of [
  ['blank', completion(' \n '), 'empty'], ['null content', completion(null), 'invalid-response'],
  ['array content', completion([]), 'invalid-response'], ['object content', completion({ secret: KEY }), 'invalid-response'],
  ['missing choices', {}, 'invalid-response'], ['null JSON', null, 'invalid-response'],
  ['array JSON', [], 'invalid-response'], ['embedded error', { ...completion(), error: { message: KEY } }, 'invalid-response'],
  ['tool response', { choices: [{ message: { content: RESPONSE, tool_calls: [{}] } }] }, 'invalid-response'],
  ['malformed tool object', { choices: [{ message: { content: RESPONSE, tool_calls: {} } }] }, 'invalid-response'],
  ['malformed tool string', { choices: [{ message: { content: RESPONSE, tool_calls: 'secret' } }] }, 'invalid-response'],
]) {
  test(`${label} is final failure and never falls back`, async (t) => {
    const mock = t.mock.method(globalThis, 'fetch', async () => response(body));
    assert.deepEqual(await askConversation(PROMPT), { ok: false, reason });
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(events.at(-1).meta.outcome, 'error');
    assert.equal(JSON.stringify(events).includes(KEY), false);
  });
}

test('malformed JSON fails without HTTP success audit or raw output', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(KEY));
  assert.deepEqual(await askConversation(PROMPT), { ok: false, reason: 'invalid-response' });
  assert.equal(events.length, 1);
  assert.equal(events[0].meta.outcome, 'error');
  assert.equal(JSON.stringify(events).includes(KEY), false);
});

test('network rejection does not expose exception or inspect arbitrary error properties', async (t) => {
  const err = new Error(KEY);
  Object.defineProperty(err, 'name', { get() { throw new Error('name must not be read'); } });
  t.mock.method(globalThis, 'fetch', async () => { throw err; });
  const errorLog = t.mock.method(console, 'error', () => {});
  assert.deepEqual(await askConversation(PROMPT), { ok: false, reason: 'network' });
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(JSON.stringify(events).includes(KEY), false);
});

test('model metadata cannot reflect prompt, response or credentials into audit', async (t) => {
  let reflected;
  t.mock.method(globalThis, 'fetch', async () => response(completion(RESPONSE, `openrouter/${reflected}`)));
  for (const sentinel of [KEY, PROMPT, RESPONSE]) {
    reflected = sentinel;
    assert.equal((await askConversation(PROMPT)).ok, true);
  }
  const logs = JSON.stringify(events);
  for (const reflected of [KEY, PROMPT, RESPONSE]) assert.equal(logs.includes(reflected), false);
  assert.ok(events.every(({ meta }) => meta.requested_model === 'openrouter/free' && !('model' in meta)));
});

test('conversation never reads the untrusted model field', async (t) => {
  const json = completion();
  Object.defineProperty(json, 'model', { get() { throw new Error(KEY); } });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => json }));
  assert.deepEqual(await askConversation(PROMPT), { ok: true, text: RESPONSE });
});

for (const bodyStarted of [false, true]) {
  test(`deadline cancels real HTTP ${bodyStarted ? 'body read' : 'headers'}`, async (t) => {
    const nativeFetch = globalThis.fetch;
    const nativeTimeout = AbortSignal.timeout;
    const timeoutCalls = [];
    t.mock.method(AbortSignal, 'timeout', (ms) => { timeoutCalls.push(ms); return nativeTimeout(100); });
    const server = createServer((_req, res) => {
      if (bodyStarted) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"choices":'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.mock.method(globalThis, 'fetch', async (_url, init) => nativeFetch(`http://127.0.0.1:${server.address().port}`, init));
    try {
      assert.deepEqual(await askConversation(PROMPT), { ok: false, reason: 'timeout' });
      assert.deepEqual(timeoutCalls, [15_000]);
      assert.equal(events.length, 1);
      assert.equal(events[0].meta.error_code, 'timeout');
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
}

test('key status uses metadata only and projects numeric free quota', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return response({ data: { is_free_tier: false, usage: 0, free_model_daily_requests: { remaining: 17 }, label: KEY, unknown: { token: KEY } } });
  });
  const status = await checkLLMStatus();
  assert.deepEqual(calls, ['https://openrouter.ai/api/v1/key']);
  assert.deepEqual(Object.keys(status), ['openrouter']);
  assert.deepEqual(status.openrouter, { ok: true, model: 'openrouter/free', freeDailyRemaining: 17, inferenceVerified: false });
  assert.equal(JSON.stringify(status).includes(KEY), false);
  const display = formatLLMStatus(status);
  assert.match(display, /OpenRouter Free · conversa/);
  assert.match(display, /inferência não testada/);
  assert.match(display, /restante: 17/);
});

for (const body of [{}, null, { error: { message: KEY } }, { data: {} }, { data: [] }, { data: { is_free_tier: false, usage: -1 } }]) {
  test('invalid key metadata never produces valid-auth display', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => response(body));
    const status = await checkLLMStatus();
    assert.deepEqual(status.openrouter, { ok: false, reason: 'invalid-response' });
    const display = formatLLMStatus(status);
    assert.equal(display.includes('Autenticação válida'), false);
    assert.equal(display.includes(KEY), false);
  });
}

test('missing status key reports only OpenRouter and makes no request', async (t) => {
  delete process.env.OPENROUTER_API_KEY;
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const status = await checkLLMStatus();
  assert.deepEqual(status, { openrouter: { ok: false, reason: 'no-key' } });
  assert.equal(mock.mock.callCount(), 0);
  assert.equal(formatLLMStatus(status), '**OpenRouter Free · conversa**: ✘ (chave não configurada)');
});

test('status display drops arbitrary reasons and malformed quota metadata', () => {
  const failure = formatLLMStatus({ openrouter: { ok: false, reason: KEY } });
  assert.equal(failure, '**OpenRouter Free · conversa**: ✘ (indisponível)');
  const display = formatLLMStatus({ openrouter: { ok: true, freeDailyRemaining: KEY } });
  assert.equal(display.includes(KEY), false);
  assert.match(display, /OpenRouter Free · conversa/);
});
