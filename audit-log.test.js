import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  auditDiscordRest,
  createAuditLogger,
  createHttpAuditMiddleware,
  formatAuditLine,
  normalizeDiscordEndpoint,
  pickSafeMeta,
  redactText,
  runWithAuditContext,
  sanitizeHttpRoute,
  withOperationAudit,
} from './audit-log.js';
import { DiscordRequest } from './utils.js';
import { handleDispatch, setPresenceDiscordRequest } from './presence.js';

function wait(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('formatter uses INFO and ERROR with trailing marker', () => {
  const info = formatAuditLine('INFO', { subsystem: 'http', method: 'POST', route: '/interactions', status: 200, elapsed_ms: 12 });
  const error = formatAuditLine('ERROR', { subsystem: 'http', method: 'POST', route: '/interactions', status: 500, elapsed_ms: 9, error_code: 'timeout' });
  assert.match(info, /^\*\*INFO:\*\* /);
  assert.doesNotMatch(info, /🟥/);
  assert.match(error, /^\*\*ERROR:\*\* /);
  assert.match(error, /🟥$/);
  const warn = formatAuditLine('warn', { subsystem: 'gateway', event: 'close' });
  assert.match(warn, /^\*\*WARN:\*\* /);
  assert.match(error, /timeout/);
});

test('model metadata never accepts provider values; requested route is a closed constant', () => {
  assert.equal(pickSafeMeta({ model: 'nvidia/test-model:free' }).model, undefined);
  assert.equal(pickSafeMeta({ requested_model: 'openrouter/free' }).requested_model, 'openrouter/free');
  for (const model of ['sk-or-v1-synthetic-key', 'https://example.com/key', 'provider/model\n', 'provider/model secret', {}, ['provider/model'], `provider/${'x'.repeat(130)}`]) {
    assert.equal(pickSafeMeta({ model }).model, undefined);
    assert.equal(pickSafeMeta({ requested_model: model }).requested_model, undefined);
  }
  assert.match(formatAuditLine('INFO', { subsystem: 'llm', requested_model: 'openrouter/free', prompt: 'sentinel', authorization: 'sentinel' }), /openrouter\/free/);
  assert.doesNotMatch(formatAuditLine('INFO', { subsystem: 'llm', model: 'openrouter/synthetic-prompt-sentinel' }), /synthetic-prompt-sentinel/);
});

test('redaction strips webhook urls and bearer-like tokens', () => {
  const dirty = 'see https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv and Bearer supersecretvalue';
  const cleaned = redactText(dirty);
  assert.equal(cleaned.includes('webhooks/123'), false);
  assert.equal(cleaned.includes('supersecretvalue'), false);
  assert.match(cleaned, /\[redacted-webhook\]/);
  assert.match(cleaned, /\[redacted-auth\]/);
});

test('allowlist drops sensitive keys and unknown objects', () => {
  const safe = pickSafeMeta({
    subsystem: 'discord-rest',
    method: 'POST',
    endpoint: 'channels/:id/messages',
    status: 204,
    token: 'Bot REALTOKEN',
    authorization: 'Bearer abc',
    webhook_url: 'https://discord.com/api/webhooks/1/abc',
    DISCORD_TOKEN: 'xyz',
    api_key: 'k',
    password: 'p',
    cookie: 'c',
    signature: 's',
    prompt: 'never',
    body: { secret: 'nope' },
    extra: 'drop-me',
  });
  assert.deepEqual(Object.keys(safe).sort(), ['endpoint', 'method', 'status', 'subsystem']);
  assert.equal(safe.token, undefined);
  assert.equal(safe.prompt, undefined);
  assert.equal(safe.body, undefined);
});

test('formatter never interpolates dropped secrets', () => {
  const line = formatAuditLine('INFO', {
    subsystem: 'llm',
    provider: 'openrouter',
    authorization: 'Bearer leaked',
    webhookUrl: 'https://discord.com/api/webhooks/111111111111111111/tokenvalue',
  });
  assert.equal(line.includes('leaked'), false);
  assert.equal(line.includes('tokenvalue'), false);
  assert.equal(line.includes('webhook'), false);
});

test('normalizes discord channel endpoints', () => {
  assert.equal(normalizeDiscordEndpoint('channels/123456789012345678/messages'), 'channels/:id/messages');
});

test('normalizes relative interaction webhook endpoints without leaking tokens', () => {
  const token = 'interaction-token-that-must-not-escape';
  const endpoint = `webhooks/123456789012345678/${token}/messages/@original`;
  const normalized = normalizeDiscordEndpoint(endpoint);
  assert.equal(normalized, 'webhooks/:id/:token/messages/@original');
  assert.equal(normalized.includes(token), false);
  const line = formatAuditLine('ERROR', { subsystem: 'discord-rest', endpoint });
  assert.equal(line.includes(token), false);
});

test('audit writes INFO to stdout and ERROR to stderr without Discord requests', (t) => {
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args));
  t.mock.method(console, 'error', (...args) => stderr.push(args));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected Discord request');
  });
  const logger = createAuditLogger();
  const info = logger.info({ subsystem: 'http', method: 'GET', route: '/health', status: 200 });
  const error = logger.error({ subsystem: 'http', status: 500 });
  assert.deepEqual(stdout, [[info]]);
  assert.deepEqual(stderr, [[error]]);
  assert.match(info, /^\*\*INFO:\*\* /);
  assert.match(error, /^\*\*ERROR:\*\* .*🟥$/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('audit output stays on one line', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  createAuditLogger().info({ event: 'first\nsecond\rthird' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\r\n]/);
});

test('audit output failure does not throw', (t) => {
  t.mock.method(console, 'error', () => { throw new Error('output unavailable'); });
  assert.equal(createAuditLogger().error({ subsystem: 'http' }), null);
});

test('Discord REST audit no longer excludes the retired channel', () => {
  const events = [];
  auditDiscordRest({ info: (meta) => events.push(meta) })(
    'request', 'channels/1300000000000000077/messages', 'POST', Date.now(), 200,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].endpoint, 'channels/:id/messages');
});

test('Discord REST failures do not expose response bodies or interaction tokens', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const originalToken = process.env.DISCORD_TOKEN;
  const output = [];
  const interactionToken = 'interaction-token-that-must-not-escape';
  const responseSecret = 'response-body-secret-that-must-not-escape';
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ message: responseSecret }),
  });
  console.error = (...args) => output.push(args.join(' '));
  process.env.DISCORD_TOKEN = 'test-token-not-logged';
  try {
    await assert.rejects(
      () => DiscordRequest(`webhooks/123456789012345678/${interactionToken}/messages/@original`, { method: 'PATCH' }),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.message.includes(responseSecret), false);
        assert.equal(error.message.includes(interactionToken), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalToken == null) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  }
  const logged = output.join('\n');
  assert.equal(logged.includes(interactionToken), false);
  assert.equal(logged.includes(responseSecret), false);
  assert.match(logged, /webhooks\/:id\/:token\/messages\/@original/);
});

test('withOperationAudit records tool metadata without args', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const logger = createAuditLogger();
  const result = await withOperationAudit(logger, { subsystem: 'mcp', tool: 'botelia_status', action: 'botelia_status' }, async () => ({
    structuredContent: { status: 'ok' },
  }));
  assert.equal(result.structuredContent.status, 'ok');
  await wait(20);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /botelia_status/);
  assert.equal(lines[0].includes('structuredContent'), false);
});

test('withOperationAudit logs timeout/error and rethrows', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const logger = createAuditLogger();
  const err = new Error('aborted');
  err.name = 'AbortError';
  await assert.rejects(() => withOperationAudit(logger, { subsystem: 'gpt-actions', tool: 'findIssueThread' }, async () => {
    throw err;
  }));
  await wait(20);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\*\*ERROR:\*\* /);
  assert.match(lines[0], /timeout/);
  assert.match(lines[0], /🟥$/);
});

test('http middleware logs method route status duration and request id', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const logger = createAuditLogger();
  const app = express();
  app.use(createHttpAuditMiddleware(logger));
  app.post('/interactions', (req, res) => res.status(200).json({ ok: true }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/interactions`, { method: 'POST', body: 'raw-not-logged' });
  assert.equal(res.status, 200);
  await wait(30);
  server.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\*\*INFO:\*\* /);
  assert.match(lines[0], /POST/);
  assert.match(lines[0], /\/interactions/);
  assert.equal(lines[0].includes('raw-not-logged'), false);
});

test('http middleware records an aborted response exactly once', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const logger = createAuditLogger();
  const middleware = createHttpAuditMiddleware(logger);
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  middleware({ method: 'POST', path: '/interactions' }, res, () => {});
  res.emit('close');
  res.emit('finish');
  await wait(20);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\*\*ERROR:\*\* /);
  assert.match(lines[0], /client_abort/);
});

test('request id from ALS is merged into later events', () => {
  const line = runWithAuditContext({ request_id: 'rid-test-1' }, () => formatAuditLine('INFO', {
    subsystem: 'discord-rest',
    method: 'GET',
    endpoint: 'users/@me',
    status: 200,
  }));
  assert.match(line, /rid-test-1/);
});

test('sanitizeHttpRoute prefers route templates', () => {
  const route = sanitizeHttpRoute({
    baseUrl: '',
    route: { path: '/webhooks/claude-status/:secret' },
    path: '/webhooks/claude-status/supersecret',
    url: '/webhooks/claude-status/supersecret',
  });
  assert.equal(route, '/webhooks/claude-status/:secret');
  const unmatched = sanitizeHttpRoute({
    baseUrl: '',
    path: '/webhooks/claude-status/supersecret',
    url: '/webhooks/claude-status/supersecret',
  });
  assert.equal(unmatched, '/webhooks/claude-status/:secret');
  assert.equal(unmatched.includes('supersecret'), false);
});

function jsonResponse(body) {
  return { json: async () => body };
}

test('handleDispatch audits MESSAGE_CREATE from the retired audit channel', async () => {
  const auditEvents = [];
  setPresenceDiscordRequest(async () => jsonResponse({}));
  try {
    handleDispatch('MESSAGE_CREATE', {
      id: '1550000000000000001',
      channel_id: '1300000000000000077',
      author: { id: '1400000000000000001', bot: true },
    }, { info: (meta) => auditEvents.push(meta) });
    await wait();
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].event, 'MESSAGE_CREATE');
    assert.equal(auditEvents[0].channel_id, '1300000000000000077');
  } finally {
    setPresenceDiscordRequest();
  }
});
