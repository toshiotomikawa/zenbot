import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGptActionsOpenApi,
  createGptActionsBearerAuth,
  createGptActionsRouteAuth,
  parseGptActionInput,
  readGptActionsConfig,
  registerGptActions,
} from './gpt-actions.js';
import { registerMcpServer } from './mcp.js';

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
  };
}

async function invoke(handlers, req, res) {
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (!handler) return;
    await handler(req, res, next);
  };
  await next();
}

const KEY = 'k'.repeat(48);
const READ_KEY = 'r'.repeat(48);
const ENV = { GPT_ACTIONS_ENABLED: 'true', GPT_ACTIONS_API_KEY: KEY };
const READ_CONFIG = { valid: true, guildIds: new Set(['1']), parentChannelIds: new Set(['2']) };
const WRITE_CONFIG = { valid: true };

test('config is explicit opt-in and rejects weak keys without returning the key', () => {
  assert.deepEqual(readGptActionsConfig({}), {
    enabled: false,
    valid: false,
    reason: 'disabled',
    missing: ['GPT_ACTIONS_ENABLED', 'GPT_ACTIONS_API_KEY'],
  });
  const weak = readGptActionsConfig({ GPT_ACTIONS_ENABLED: 'true', GPT_ACTIONS_API_KEY: 'short' });
  assert.equal(weak.reason, 'weak_api_key');
  assert.equal('apiKey' in weak, false);
  assert.equal(readGptActionsConfig(ENV).valid, true);
  assert.equal(readGptActionsConfig({ ...ENV, GPT_ACTIONS_READ_API_KEY: 'short' }).reason, 'weak_read_api_key');
  assert.equal(readGptActionsConfig({ ...ENV, GPT_ACTIONS_READ_API_KEY: KEY }).reason, 'duplicate_read_api_key');
  assert.equal(readGptActionsConfig({ ...ENV, GPT_ACTIONS_READ_API_KEY: READ_KEY }).valid, true);
});

test('bearer middleware rejects missing/wrong token and accepts exact token', () => {
  const auth = createGptActionsBearerAuth(KEY);
  for (const authorization of [undefined, 'Bearer wrong', `Basic ${KEY}`, `Bearer ${KEY} extra`]) {
    const req = { headers: authorization ? { authorization } : {} };
    const res = fakeResponse();
    let called = false;
    auth(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
    assert.deepEqual(res.body, { status: 'forbidden', error: 'unauthorized' });
  }
  const req = { headers: { authorization: `Bearer ${KEY}` } };
  const res = fakeResponse();
  let called = false;
  auth(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.body, undefined);
});

test('read-only bearer is accepted on READ routes and rejected on WRITE routes', () => {
  const readAuth = createGptActionsRouteAuth(KEY, READ_KEY, { allowReadOnly: true });
  const writeAuth = createGptActionsRouteAuth(KEY, READ_KEY);
  const req = { headers: { authorization: `Bearer ${READ_KEY}` } };
  const readRes = fakeResponse();
  let readCalled = false;
  readAuth(req, readRes, () => { readCalled = true; });
  assert.equal(readCalled, true);

  const writeRes = fakeResponse();
  let writeCalled = false;
  writeAuth(req, writeRes, () => { writeCalled = true; });
  assert.equal(writeCalled, false);
  assert.equal(writeRes.statusCode, 403);
  assert.equal(writeRes.headers['Cache-Control'], 'no-store');
  assert.deepEqual(writeRes.body, { status: 'forbidden', error: 'insufficient_privilege' });
});

test('input parser is strict and normalizes repo', () => {
  assert.deepEqual(parseGptActionInput('findIssueThread', {
    repo: 'Toshiotomikawa/ZenBot', issue_number: 5,
  }), {
    ok: true,
    value: { repo: 'toshiotomikawa/zenbot', issue_number: 5 },
  });
  assert.equal(parseGptActionInput('findIssueThread', {
    repo: 'a/b', issue_number: 1, thread_id: '123',
  }).ok, false);
  assert.equal(parseGptActionInput('readIssueThread', {
    repo: 'a/b', issue_number: 1, limit: 101,
  }).error, 'invalid_pagination');
  assert.equal(parseGptActionInput('ensureIssueThread', {
    repo: 'a/b', issue_number: 1, title: '',
  }).error, 'invalid_title');
  assert.equal(parseGptActionInput('postIssueMessage', {
    repo: 'a/b', issue_number: 1, content: 'x', operation_id: '',
  }).error, 'invalid_operation_id');
});

test('OpenAPI exposes six narrow actions and marks writes consequential', () => {
  const doc = buildGptActionsOpenApi({ baseUrl: 'https://example.com/' });
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.servers, [{ url: 'https://example.com' }]);
  assert.deepEqual(doc.components.schemas, {});
  const statusResponseSchema = doc.paths['/actions/status'].get.responses[200]
    .content['application/json'].schema;
  assert.equal(statusResponseSchema.type, 'object');
  assert.deepEqual(statusResponseSchema.properties, {});
  const operations = Object.values(doc.paths).flatMap((path) => Object.values(path));
  assert.deepEqual(operations.map((op) => op.operationId), [
    'getBoteliaStatus',
    'findIssueThread',
    'readIssueThread',
    'ensureIssueThread',
    'setIssueThreadState',
    'postIssueMessage',
  ]);
  assert.equal(doc.paths['/actions/issue-thread/ensure'].post['x-openai-isConsequential'], true);
  assert.equal(doc.paths['/actions/issue-thread/message'].post['x-openai-isConsequential'], true);
  assert.equal(doc.paths['/actions/issue-thread/find'].post['x-openai-isConsequential'], false);
  for (const path of [
    '/actions/issue-thread/find',
    '/actions/issue-thread/read',
    '/actions/issue-thread/ensure',
    '/actions/issue-thread/message',
  ]) {
    const schema = doc.paths[path].post.requestBody.content['application/json'].schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal('thread_id' in schema.properties, false);
    const responseSchema = doc.paths[path].post.responses[200].content['application/json'].schema;
    assert.equal(responseSchema.type, 'object');
    assert.deepEqual(responseSchema.properties, {});
  }
  assert.throws(() => buildGptActionsOpenApi({ baseUrl: 'http://example.com' }), /invalid_actions_base_url/);
});

test('alex work actions parse repo-only reserve and reject extra fields', () => {
  assert.deepEqual(parseGptActionInput('reserveAlexWork', { repo: 'Toshiotomikawa/2A3A' }), {
    ok: true,
    value: { repo: 'Toshiotomikawa/2A3A' },
  });
  assert.equal(parseGptActionInput('reserveAlexWork', {
    repo: 'a/b', issue_number: 1, labels: ['alex-ready'],
  }).ok, false);
  assert.equal(parseGptActionInput('markAlexWorkAwaitingReview', {
    repo: 'a/b', issue_number: 10, head: 'feat/10-x',
  }).value.head, 'feat/10-x');
  assert.deepEqual(parseGptActionInput('handoffAlexWork', {
    repo: 'toshiotomikawa/2A3A', issue_number: 12,
  }).value, { repo: 'toshiotomikawa/2a3a', issue_number: 12 });
  assert.equal(parseGptActionInput('handoffAlexWork', { repo: 'a/b' }).ok, false);
});

test('registration fails closed unless Actions, READ, and WRITE are all valid', () => {
  const app = fakeApp();
  assert.deepEqual(registerGptActions(app, { env: {} }), { registered: false, reason: 'disabled' });
  assert.equal(registerGptActions(app, {
    env: ENV, discordReadConfig: { valid: false },
  }).reason, 'discord_read_not_configured');
  assert.equal(registerGptActions(app, {
    env: ENV, discordReadConfig: READ_CONFIG, discordWriteConfig: { valid: false },
  }).reason, 'discord_write_not_configured');
  assert.equal(app.routes.size, 0);
});

test('existing HTTP bootstrap can register Actions while MCP stays disabled', () => {
  const app = fakeApp();
  const readService = {
    async findIssueThread() { return { status: 'not_found' }; },
    async readIssueThread() { return { status: 'not_found' }; },
  };
  const writeService = {
    async ensureIssueThread() { return { status: 'found', created: true }; },
    async postIssueMessage() { return { status: 'posted' }; },
  };
  const result = registerMcpServer(app, {
    env: { ...ENV, MCP_ENABLED: 'false' },
    gptActions: {
      discordReadConfig: READ_CONFIG,
      discordWriteConfig: WRITE_CONFIG,
      discordReadService: readService,
      discordWriteService: writeService,
      publicBaseUrl: 'https://botelia.example',
    },
  });
  assert.deepEqual(result, { registered: false, reason: 'disabled' });
  assert.equal(app.routes.size, 9);
  assert.equal(app.routes.has('GET /actions/2a3a-mentions'), true);
  assert.equal(app.routes.has('GET /actions/openapi.json'), true);
  assert.equal(app.routes.has('GET /assets/director-avatar.png'), true);
  assert.equal(app.routes.has('POST /actions/issue-thread/message'), true);
});

test('registered routes require auth and delegate only validated issue inputs', async () => {
  const calls = [];
  const readService = {
    async findIssueThread(input) { calls.push(['find', input]); return { status: 'found', repo: input.repo }; },
    async readIssueThread(input) { calls.push(['read', input]); return { status: 'found', messages: [] }; },
  };
  const writeService = {
    async ensureIssueThread(input) { calls.push(['ensure', input]); return { status: 'found', created: true }; },
    async postIssueMessage(input) { calls.push(['post', input]); return { status: 'posted' }; },
  };
  const app = fakeApp();
  const result = registerGptActions(app, {
    env: ENV,
    discordReadConfig: READ_CONFIG,
    discordWriteConfig: WRITE_CONFIG,
    discordReadService: readService,
    discordWriteService: writeService,
    readOnlyApiKey: READ_KEY,
    publicBaseUrl: 'https://botelia.example',
  });
  assert.equal(result.registered, true);
  assert.equal(app.routes.size, 8);

  for (const route of [
    'GET /actions/status',
    'POST /actions/issue-thread/find',
    'POST /actions/issue-thread/read',
  ]) {
    const res = fakeResponse();
    const body = route.endsWith('/find')
      ? { repo: 'a/b', issue_number: 1 }
      : { repo: 'a/b', issue_number: 1, limit: 10 };
    await invoke(app.routes.get(route), {
      headers: { authorization: `Bearer ${READ_KEY}` },
      body,
    }, res);
    assert.equal(res.statusCode, 200, route);
  }

  for (const route of [
    'POST /actions/issue-thread/ensure',
    'POST /actions/issue-thread/message',
  ]) {
    const res = fakeResponse();
    await invoke(app.routes.get(route), {
      headers: { authorization: `Bearer ${READ_KEY}` },
      body: {},
    }, res);
    assert.equal(res.statusCode, 403, route);
    assert.deepEqual(res.body, { status: 'forbidden', error: 'insufficient_privilege' });
  }
  calls.length = 0;

  const unauthRes = fakeResponse();
  await invoke(app.routes.get('POST /actions/issue-thread/ensure'), {
    headers: {}, body: { repo: 'a/b', issue_number: 1, title: 't' },
  }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
  assert.equal(unauthRes.headers['Cache-Control'], 'no-store');
  assert.equal(calls.length, 0);

  const badRes = fakeResponse();
  await invoke(app.routes.get('POST /actions/issue-thread/ensure'), {
    headers: { authorization: `Bearer ${KEY}` },
    body: { repo: 'a/b', issue_number: 1, title: 't', thread_id: '123' },
  }, badRes);
  assert.equal(badRes.statusCode, 400);
  assert.equal(calls.length, 0);

  const okRes = fakeResponse();
  await invoke(app.routes.get('POST /actions/issue-thread/ensure'), {
    headers: { authorization: `Bearer ${KEY}` },
    body: { repo: 'Toshiotomikawa/ZenBot', issue_number: 5, title: 'Smoke' },
  }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.deepEqual(okRes.body, { status: 'found', created: true });
  assert.deepEqual(calls, [[
    'ensure',
    { repo: 'toshiotomikawa/zenbot', issue_number: 5, title: 'Smoke' },
  ]]);
  assert.equal(okRes.headers['Cache-Control'], 'no-store');

  const schemaRes = fakeResponse();
  await invoke(app.routes.get('GET /actions/openapi.json'), {
    headers: {}, get: () => 'ignored.example',
  }, schemaRes);
  assert.equal(schemaRes.body.servers[0].url, 'https://botelia.example');
  assert.equal(schemaRes.body.openapi, '3.1.0');
});

test('unexpected service errors are sanitized', async () => {
  const logs = [];
  const app = fakeApp();
  registerGptActions(app, {
    env: ENV,
    discordReadConfig: READ_CONFIG,
    discordWriteConfig: WRITE_CONFIG,
    discordReadService: {
      findIssueThread: async () => { throw new Error('secret-ish detail'); },
      readIssueThread: async () => ({}),
    },
    discordWriteService: {
      ensureIssueThread: async () => ({}),
      postIssueMessage: async () => ({}),
    },
    logger: { error: (...args) => logs.push(args) },
    publicBaseUrl: 'https://botelia.example',
  });
  const res = fakeResponse();
  await invoke(app.routes.get('POST /actions/issue-thread/find'), {
    headers: { authorization: `Bearer ${KEY}` },
    body: { repo: 'a/b', issue_number: 1 },
  }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { status: 'error', error: 'internal_error' });
  assert.equal(JSON.stringify(logs).includes('secret-ish detail'), false);
});

test('task state Action has strict input and consequential schema', () => {
  const input = { thread_id: '33333333333333333', state: 'Em andamento', operation_id: 'test' };
  assert.deepEqual(parseGptActionInput('setIssueThreadState', input), { ok: true, value: input });
  for (const bad of [{ ...input, state: 'em andamento' }, { ...input, guild_id: '1' }, { ...input, thread_id: input.thread_id + '\n' }, { ...input, operation_id: '' }]) {
    assert.equal(parseGptActionInput('setIssueThreadState', bad).ok, false);
  }
  const schema = buildGptActionsOpenApi({ baseUrl: 'https://example.com' }).paths['/actions/issue-thread/tag'].post;
  assert.equal(schema['x-openai-isConsequential'], true);
  assert.equal(buildGptActionsOpenApi({ baseUrl: 'https://example.com', issueWrite: false }).paths['/actions/issue-thread/tag'], undefined);
});
test('task state Action requires WRITE and delegates exact input', async () => {
  const app = fakeApp();
  const calls = [];
  registerGptActions(app, { env: ENV, readOnlyApiKey: READ_KEY, discordReadConfig: READ_CONFIG,
    discordWriteConfig: WRITE_CONFIG, discordReadService: {},
    discordWriteService: { setIssueThreadState(input) { calls.push(input); return { status: 'ok' }; } } });
  const handlers = app.routes.get('POST /actions/issue-thread/tag');
  const denied = fakeResponse();
  await invoke(handlers, { headers: { authorization: `Bearer ${READ_KEY}` } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
  const input = { thread_id: '33333333333333333', state: 'Aberto', operation_id: 'tag' };
  // The route parser is Express middleware; handler delegation can be exercised after authentication with a parsed body.
  const res = fakeResponse();
  await handlers.at(-1)({ body: input }, res);
  assert.deepEqual(calls, [input]);
  assert.equal(res.body.status, 'ok');
});
