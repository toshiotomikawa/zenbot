import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { registerGptActions, buildGptActionsOpenApi } from './gpt-actions.js';
import { DISCORD_AGENT_IDENTITIES, matchDiscordAgentIdentity } from './discord-agent-identities.js';
import { createDiscordAgentMentions } from './discord-agent-mentions.js';
import { createChannel2a3aService, resetChannel2a3aOperationCache, resetChannel2a3aWebhookCache, resetChannel2a3aIdentityCache } from './mcp-discord-2a3a.js';
import { DiscordRequest } from './utils.js';
import { audit } from './audit-log.js';

const GUILD = '11111111111111111';
const CATEGORY = '22222222222222222';
const CHANNEL = '33333333333333333';
const MESSAGE = '44444444444444444';
const FORUM = '55555555555555555';
const THREAD = '66666666666666666';
const TAG = '77777777777777777';
const KEY = 'FAKE-IDENTITY-ACTIONS-KEY-FOR-OFFLINE-TESTS';
const OPHELIA_KEY = 'FAKE-OPHELIA-ACTIONS-KEY-FOR-OFFLINE-TESTS';
const OPHELIA_TOKEN = 'FAKE-OPHELIA-BOT-TOKEN';
const LEGACY = 'FAKE-LEGACY-ACTIONS-KEY-FOR-OFFLINE-TESTS';
const READ_KEY = 'FAKE-READ-ONLY-ACTIONS-KEY-FOR-OFFLINE-TESTS';
const TOKEN = 'FAKE-IDENTITY-BOT-TOKEN';
const BODY = { channel_id: CHANNEL, content: 'Teste @everyone', operation_id: 'test-operation' };
const FORUM_BODY = { forum_id: FORUM, title: 'Tarefa da Ophelia', content: 'Teste @everyone @here <@&11111111111111111>', tag_name: 'Aberto', operation_id: 'test-operation' };

test.afterEach(() => {
  resetChannel2a3aOperationCache(); resetChannel2a3aWebhookCache(); resetChannel2a3aIdentityCache();
});

async function harness(t, { token = TOKEN, failure, outside = false, moveForum = false, invalidForumResponse = false, opheliaKey = OPHELIA_KEY, opheliaToken = OPHELIA_TOKEN, mentionsQueue } = {}) {
  const calls = [];
  const logs = [];
  const env = { GPT_ACTIONS_ENABLED: '1', GPT_ACTIONS_API_KEY: LEGACY, GPT_ACTIONS_READ_API_KEY: READ_KEY,
    MCP_DISCORD_2A3A_READ_ENABLED: '1', MCP_DISCORD_2A3A_WRITE_ENABLED: '1',
    MCP_DISCORD_2A3A_GUILD_ID: GUILD, MCP_DISCORD_2A3A_CATEGORY_ID: CATEGORY,
    DISCORD_TOKEN: 'FAKE-LEGACY-DISCORD-TOKEN', AGENT_ALPHA_ACTIONS_API_KEY: KEY,
    AGENT_BETA_ACTIONS_API_KEY: opheliaKey, AGENT_BETA_DISCORD_TOKEN: opheliaToken,
    ...(token ? { AGENT_ALPHA_DISCORD_TOKEN: token } : {}) };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, options });
    const response = (value) => ({ json: async () => value });
    if (endpoint === `channels/${CHANNEL}`) return response({ id: CHANNEL, guild_id: GUILD, parent_id: outside ? GUILD : CATEGORY, type: 0 });
    if (endpoint === `channels/${CATEGORY}`) return response({ id: CATEGORY, guild_id: GUILD, type: 4 });
    if (endpoint === `channels/${FORUM}`) return response({ id: FORUM, guild_id: GUILD,
      parent_id: outside || (moveForum && calls.filter(call => call.endpoint === endpoint).length > 1) ? GUILD : CATEGORY,
      type: 15, available_tags: [{ id: TAG, name: 'Aberto' }] });
    if (endpoint.includes('members/search')) return response([]);
    if (endpoint === 'users/@me') return response({ id: GUILD, bot: true });
    if (endpoint === 'applications/@me') return response({ id: GUILD });
    if (endpoint.endsWith('/webhooks')) return response(options.method === 'GET' ? [] : { id: MESSAGE, token: 'FAKE-WEBHOOK-TOKEN' });
    if (options.method === 'POST') {
      if (failure) {
        const error = new Error(`${TOKEN} ${KEY}`);
        error.headers = { Authorization: `Bot ${TOKEN}` };
        error.body = 'FAKE-DISCORD-RESPONSE-BODY';
        if (typeof failure === 'number') error.status = failure;
        throw error;
      }
      if (endpoint === `channels/${FORUM}/threads`) return response({ id: THREAD, guild_id: GUILD,
        parent_id: invalidForumResponse ? CATEGORY : FORUM, type: 11, name: options.body.name,
        applied_tags: options.body.applied_tags, message: { id: MESSAGE, channel_id: THREAD, content: options.body.message.content } });
      return response({ id: MESSAGE, channel_id: CHANNEL, content: options.body.content, nonce: options.body.nonce });
    }
    throw new Error('unexpected_test_endpoint');
  };
  const app = express();
  registerGptActions(app, { env, mentionsQueue, discordRequest: request, logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = async (body = BODY, key = KEY, route = 'message') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/actions/2a3a-channels/${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async (route, key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/actions/${route}`, { headers: { Authorization: `Bearer ${key}` } });
    return { status: response.status, body: await response.json() };
  };
  return { post, get, calls, logs, env };
}

test('immutable registry and fixed-size timingSafeEqual comparisons, including wrong-length keys', () => {
  assert.ok(Object.isFrozen(DISCORD_AGENT_IDENTITIES));
  assert.ok(Object.isFrozen(DISCORD_AGENT_IDENTITIES[0]));
  const original = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (left, right) => { calls++; assert.equal(left.length, 32); assert.equal(right.length, 32); return original(left, right); };
  try {
    const env = { AGENT_ALPHA_ACTIONS_API_KEY: KEY };
    assert.equal(matchDiscordAgentIdentity(KEY, env).id, 'agent-alpha');
    for (const key of ['', 'wrong', KEY + 'x', 'x'.repeat(100)]) assert.equal(matchDiscordAgentIdentity(key, env), undefined);
    assert.equal(calls, 5 * DISCORD_AGENT_IDENTITIES.length);
    assert.equal(matchDiscordAgentIdentity('short', { AGENT_ALPHA_ACTIONS_API_KEY: 'short' }), undefined);
  } finally { crypto.timingSafeEqual = original; }
});

test('identity authenticates and posts REST with its bot token, mentions suppressed and replay once', async t => {
  const h = await harness(t);
  const result = await h.post();
  assert.equal(result.body.status, 'posted'); assert.equal(result.body.identity, 'agent-alpha'); assert.equal(result.body.via, 'bot');
  const sends = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(sends.length, 1); assert.equal(sends[0].endpoint, `channels/${CHANNEL}/messages`);
  assert.equal(sends[0].options.headers.Authorization === `Bot ${TOKEN}`, true);
  assert.deepEqual(sends[0].options.body.allowed_mentions, { parse: [] });
  assert.equal(sends[0].options.body.enforce_nonce, true);
  assert.equal((await h.post()).body.process_replay, true);
  assert.equal((await h.post({ ...BODY, content: 'different' })).body.status, 'conflict');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  const visible = JSON.stringify([result, h.logs]);
  for (const secret of [KEY, TOKEN, LEGACY]) assert.equal(visible.includes(secret), false);
});

test('identity rejects any author field before Discord, including empty/null/prohibited', async t => {
  const h = await harness(t);
  for (const author of ['Opus 5.5 · Diretor', '', null, 'discord', 9]) {
    const result = await h.post({ ...BODY, author });
    assert.equal(result.status, 400); assert.equal(result.body.error, 'invalid_author');
  }
  assert.equal(h.calls.length, 0);
});

for (const failure of ['missing', 401, 403, 500, 'network']) {
  test(`identity fails closed without webhook and sanitizes errors: ${failure}`, async t => {
    const h = await harness(t, failure === 'missing' ? { token: null } : { failure });
    const result = await h.post();
    assert.equal(result.body.error, ['missing', 401, 403].includes(failure) ? 'identity_bot_unavailable' : 'identity_bot_result_unknown');
    assert.equal(h.calls.some(call => call.endpoint.includes('webhook')), false);
    assert.equal(JSON.stringify([result, h.logs]).includes(TOKEN), false);
    assert.equal(JSON.stringify([result, h.logs]).includes(KEY), false);
    assert.equal(JSON.stringify(h.logs).includes('Authorization'), false);
    assert.equal(JSON.stringify(h.logs).includes('FAKE-DISCORD-RESPONSE-BODY'), false);
    assert.equal(Object.hasOwn(result.body, 'cause'), false);
    const audit = h.logs.map(([, fields]) => fields)
      .find(fields => fields?.operation === 'post_2a3a_message' && fields.error === result.body.error);
    assert.ok(audit);
    assert.equal(audit.correlation_id, result.body.correlation_id);
    assert.ok(audit.correlation_id);
    if (['missing', 401, 403].includes(failure)) {
      assert.equal(audit.cause, failure === 'missing' ? 'token_missing' : `discord_${failure}`);
    } else {
      assert.equal(Object.hasOwn(audit, 'cause'), false);
    }
    if ([500, 'network'].includes(failure)) {
      assert.equal((await h.post()).body.status, 'ambiguous');
      assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
    }
  });
}

test('legacy author still sends via webhook and has separate idempotency from identity', async t => {
  const h = await harness(t);
  assert.equal((await h.post()).body.identity, 'agent-alpha');
  const result = await h.post({ ...BODY, author: 'Opus 5.5 · Diretor' }, LEGACY);
  assert.equal(result.body.status, 'posted'); assert.equal(result.body.via, 'webhook');
  assert.equal('identity' in result.body, false);
  assert.ok(h.calls.some(call => call.endpoint.startsWith('webhooks/')));
  // A legacy operation_id resembling our nonce prefix must never replay the identity receipt.
  const plain = await h.post({ ...BODY, operation_id: `agent-alpha:${BODY.operation_id}` }, LEGACY);
  assert.equal(plain.body.status, 'posted');
  assert.equal('identity' in plain.body, false);
  assert.equal(plain.body.process_replay, false);
});

test('identity cannot bypass category, limits, mention allowlist, input schema or access other routes', async t => {
  const h = await harness(t, { outside: true });
  assert.equal((await h.post()).body.status, 'blocked');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal((await h.post({ ...BODY, content: 'x'.repeat(2001) })).body.error, 'invalid_content');
  assert.equal((await h.post({ ...BODY, mention_user_ids: [GUILD] })).body.error, 'mention_user_not_allowed');
  assert.equal((await h.post({ ...BODY, identity: 'agent-alpha' })).body.error, 'invalid_request');
  assert.equal((await h.post({}, KEY, 'forum-tags')).status, 401);
  assert.equal((await h.post(BODY, 'FAKE-WRONG-KEY')).status, 401);
});


test('both identity keys use only their own bot token and separate replay receipts', async t => {
  const h = await harness(t);
  for (const [key, token, id] of [[OPHELIA_KEY, OPHELIA_TOKEN, 'agent-beta'], [KEY, TOKEN, 'agent-alpha']]) {
    const result = await h.post(BODY, key);
    assert.equal(result.body.status, 'posted');
    assert.equal(result.body.identity, id);
    assert.equal(result.body.via, 'bot');
    const sends = h.calls.filter(call => call.options.method === 'POST');
    assert.equal(sends.at(-1).options.headers.Authorization === `Bot ${token}`, true);
    assert.equal((await h.post(BODY, key)).body.process_replay, true);
    assert.equal(JSON.stringify([result, h.logs]).includes(key), false);
    assert.equal(JSON.stringify([result, h.logs]).includes(token), false);
  }
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 2);
  assert.equal(h.calls.some(call => call.endpoint.includes('webhook')), false);
  assert.ok(DISCORD_AGENT_IDENTITIES.every(Object.isFrozen));
});

test('Ophelia missing token cannot use the configured Opus token', async t => {
  const missing = await harness(t, { opheliaToken: '' });
  assert.equal((await missing.post(BODY, OPHELIA_KEY)).body.error, 'identity_bot_unavailable');
  assert.equal(missing.calls.length, 0);
});

test('duplicate identity keys disable initialization even when shared with the legacy key', () => {
  for (const key of [KEY, LEGACY]) {
    const env = { AGENT_ALPHA_ACTIONS_API_KEY: key, AGENT_BETA_ACTIONS_API_KEY: key, GPT_ACTIONS_API_KEY: key };
    assert.equal(matchDiscordAgentIdentity(key, env), undefined);
    const app = { get() { assert.fail('route registered'); }, post() { assert.fail('route registered'); }, use() { assert.fail('route registered'); } };
    assert.deepEqual(registerGptActions(app, { env }), { registered: false, reason: 'duplicate_identity_keys' });
  }
});

test('Opus say notifies Ophelia without an env mention allowlist', async t => {
  const h = await harness(t);
  const target = DISCORD_AGENT_IDENTITIES[1].botUserId;
  const result = await h.post({ ...BODY, content: `<@${target}> @everyone @here`, mention_user_ids: [target] });
  assert.equal(result.body.status, 'posted');
  assert.equal(result.body.identity, 'agent-alpha');
  const send = h.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(send.options.body.allowed_mentions,
    { parse: [], users: [target], roles: [], replied_user: false });
});

test('forum-post uses each authenticated identity bot and isolates concurrent replay from other identities and legacy', async t => {
  const h = await harness(t);
  for (const [key, token, id] of [[OPHELIA_KEY, OPHELIA_TOKEN, 'agent-beta'], [KEY, TOKEN, 'agent-alpha']]) {
    const results = await Promise.all([h.post(FORUM_BODY, key, 'forum-post'), h.post(FORUM_BODY, key, 'forum-post')]);
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'created');
      assert.equal(result.body.identity, id);
      assert.equal(result.body.via, 'bot');
      assert.equal(result.body.thread_id, THREAD);
      assert.equal(result.body.message_id, MESSAGE);
      assert.deepEqual(result.body.applied_tags, [TAG]);
    }
    assert.equal(results.filter(result => result.body.process_replay).length, 1);
    const send = h.calls.filter(call => call.options.method === 'POST').at(-1);
    assert.equal(send.endpoint, `channels/${FORUM}/threads`);
    assert.equal(send.options.headers.Authorization === `Bot ${token}`, true);
    assert.equal(send.options.sensitiveErrors, true);
    assert.deepEqual(send.options.body, { name: FORUM_BODY.title, applied_tags: [TAG],
      message: { content: FORUM_BODY.content, allowed_mentions: { parse: [] } } });
    assert.equal((await h.post(FORUM_BODY, key, 'forum-post')).body.process_replay, true);
    assert.equal((await h.post({ ...FORUM_BODY, title: 'Outro título' }, key, 'forum-post')).body.status, 'conflict');
    const visible = JSON.stringify([results, h.logs]);
    for (const secret of [key, token, LEGACY]) assert.equal(visible.includes(secret), false);
  }
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 2);
  assert.equal((await h.post(FORUM_BODY, LEGACY, 'forum-post')).body.status, 'created');
  const legacy = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(legacy.length, 3);
  assert.equal(Object.hasOwn(legacy.at(-1).options, 'headers'), false);
  assert.equal(h.calls.some(call => call.endpoint.includes('webhook')), false);
});

test('Ophelia forum-post still requires operation_id, existing tag, valid schema and rejects any author', async t => {
  const h = await harness(t);
  for (const author of ['Opus 5.5 · Diretor', '', null, 'discord', 9]) {
    const result = await h.post({ ...FORUM_BODY, author }, OPHELIA_KEY, 'forum-post');
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_author');
  }
  assert.equal(h.calls.length, 0);
  for (const [changes, error] of [[{ operation_id: undefined }, 'invalid_operation_id'],
    [{ content: 'x'.repeat(2001) }, 'invalid_content'], [{ identity: 'agent-alpha' }, 'invalid_request'],
    [{ mention_user_ids: [GUILD] }, 'mention_user_not_allowed']]) {
    assert.equal((await h.post({ ...FORUM_BODY, ...changes }, OPHELIA_KEY, 'forum-post')).body.error, error);
  }
  for (const tag_name of ['aberto', 'Inexistente']) {
    assert.equal((await h.post({ ...FORUM_BODY, tag_name }, OPHELIA_KEY, 'forum-post')).body.reason, 'unknown_tag_name');
  }
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

for (const options of [{ outside: true }, { moveForum: true }]) {
  test(`Ophelia forum-post refuses forum outside category including final revalidation: ${JSON.stringify(options)}`, async t => {
    const h = await harness(t, options);
    assert.equal((await h.post(FORUM_BODY, OPHELIA_KEY, 'forum-post')).body.status, 'blocked');
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
    assert.deepEqual(h.calls.map(call => [call.options.method, call.endpoint]), [
      ['GET', `channels/${CATEGORY}`], ['GET', `channels/${FORUM}`],
      ...(options.moveForum ? [['GET', `channels/${FORUM}`]] : []),
    ]);
  });
}

for (const failure of ['missing', 401, 403, 500, 'network', 'invalid_response']) {
  test(`Ophelia forum-post fails closed without other bot or webhook fallback: ${failure}`, async t => {
    const h = await harness(t, failure === 'missing' ? { opheliaToken: '' }
      : failure === 'invalid_response' ? { invalidForumResponse: true } : { failure });
    const result = await h.post(FORUM_BODY, OPHELIA_KEY, 'forum-post');
    const unavailable = ['missing', 401, 403].includes(failure);
    assert.equal(result.body.error, unavailable ? 'identity_bot_unavailable' : 'identity_bot_result_unknown');
    assert.equal(h.calls.some(call => call.endpoint.includes('webhook')), false);
    const sends = h.calls.filter(call => call.options.method === 'POST');
    assert.equal(sends.length, failure === 'missing' ? 0 : 1);
    if (sends.length) assert.equal(sends[0].options.headers.Authorization === `Bot ${OPHELIA_TOKEN}`, true);
    const visible = JSON.stringify([result, h.logs]);
    for (const secret of [KEY, TOKEN, OPHELIA_KEY, OPHELIA_TOKEN, LEGACY, 'FAKE-DISCORD-RESPONSE-BODY']) assert.equal(visible.includes(secret), false);
    if (!unavailable) {
      assert.equal((await h.post(FORUM_BODY, OPHELIA_KEY, 'forum-post')).body.process_replay, true);
      assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
    }
  });
}

test('identity keys still receive 401 on all other registered 2A3A routes and status', async t => {
  const h = await harness(t);
  for (const key of [OPHELIA_KEY, KEY]) {
    for (const route of ['list', 'read', 'attachment', 'forum-tags', 'forum-archived', 'reaction']) {
      const result = await h.post({}, key, route);
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { status: 'forbidden', error: 'unauthorized' });
    }
    assert.equal((await h.get('status', key)).status, 401);
  }
  assert.equal(h.calls.length, 0);
});

test('unconfigured or invalid identity key receives 401 before forum-post touches Discord', async t => {
  const h = await harness(t, { opheliaKey: '' });
  for (const key of [OPHELIA_KEY, 'FAKE-WRONG-KEY']) {
    const result = await h.post(FORUM_BODY, key, 'forum-post');
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { status: 'forbidden', error: 'unauthorized' });
  }
  assert.equal(h.calls.length, 0);
});

test('forum-post OpenAPI describes identity permissions without extending other task routes', () => {
  const api = buildGptActionsOpenApi({ baseUrl: 'https://example.com', channel2a3aWrite: true });
  const description = api.paths['/actions/2a3a-channels/forum-post'].post.description;
  assert.ok(description.includes('Configured identity API keys create via their own bot token.'));
  assert.ok(description.includes('without webhook fallback'));
  assert.ok(description.includes('Identity callers must omit author; any author field is rejected as invalid_author.'));
  assert.ok(description.includes('Only legacy keys may use optional author through the bot-owned webhook.'));
  for (const route of ['forum-tags', 'forum-archived', 'reaction']) {
    const operation = api.paths[`/actions/2a3a-channels/${route}`].post;
    assert.equal(operation.description.includes('Configured identity API keys'), false);
    assert.equal(operation.description.includes('webhook'), false);
    assert.equal(operation.description.includes('author'), false);
  }
});

test('pre-existing mentions GET lets each identity read only its own queue and rejects legacy/read/invalid credentials', async t => {
  const queue = createDiscordAgentMentions({ bootId: 'identity-route-test' });
  const h = await harness(t, { mentionsQueue: queue });
  for (const [index, identity] of DISCORD_AGENT_IDENTITIES.entries()) {
    await queue.ingest({ id: index ? THREAD : MESSAGE, guild_id: GUILD, channel_id: CHANNEL,
      author: { id: TAG, bot: false }, mentions: [{ id: identity.botUserId }],
      content: `fixture-for-${identity.id}`, timestamp: new Date().toISOString() },
    { env: h.env, request: async endpoint => ({ json: async () => ({
      id: endpoint.split('/')[1], guild_id: GUILD, name: 'fixture-channel' }) }) });
  }
  for (const [key, id] of [[OPHELIA_KEY, 'agent-beta'], [KEY, 'agent-alpha']]) {
    const result = await h.get('2a3a-mentions?after=0&wait=0', key);
    assert.equal(result.status, 200);
    assert.equal(result.body.identity, id);
    assert.equal(result.body.boot_id, 'identity-route-test');
    assert.deepEqual(result.body.mentions.map(mention => mention.content), [`fixture-for-${id}`]);
    assert.equal((await h.get(`2a3a-mentions?after=${result.body.cursor}&wait=0`, key)).body.mentions.length, 0);
    assert.equal((await h.get('2a3a-mentions?identity=agent-alpha', key)).status, 400);
  }
  for (const key of [LEGACY, READ_KEY, 'FAKE-WRONG-KEY']) {
    const result = await h.get('2a3a-mentions', key);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { status: 'forbidden', error: 'unauthorized' });
  }
  assert.equal(h.calls.length, 0);
  const metadata = h.logs.filter(([value]) => typeof value === 'object').map(([value]) => Object.keys(value).sort());
  assert.ok(metadata.length > 0);
  assert.ok(metadata.every(keys => keys.join() === 'cursor,identity,quantity'));
});

test('forum-post checks category and forum twice before identity POST and rejects wrong created parent', async t => {
  for (const invalidForumResponse of [false, true]) {
    const h = await harness(t, { invalidForumResponse });
    const result = await h.post({ ...FORUM_BODY, operation_id: `parent-check-${invalidForumResponse}` }, OPHELIA_KEY, 'forum-post');
    assert.equal(result.body.status, invalidForumResponse ? 'ambiguous' : 'created');
    if (invalidForumResponse) assert.equal(result.body.error, 'identity_bot_result_unknown');
    assert.deepEqual(h.calls.map(call => [call.options.method, call.endpoint]), [
      ['GET', `channels/${CATEGORY}`], ['GET', `channels/${FORUM}`],
      ['GET', `channels/${FORUM}`], ['POST', `channels/${FORUM}/threads`],
    ]);
    const send = h.calls.at(-1);
    assert.equal(send.options.headers.Authorization === `Bot ${OPHELIA_TOKEN}`, true);
  }
});

test('one identity colliding with full/read legacy key, including option overrides, disables Actions initialization', () => {
  for (const identity of DISCORD_AGENT_IDENTITIES) {
    for (const legacyKeyName of ['GPT_ACTIONS_API_KEY', 'GPT_ACTIONS_READ_API_KEY']) {
      for (const override of [false, true]) {
        const env = { GPT_ACTIONS_ENABLED: '1', GPT_ACTIONS_API_KEY: LEGACY, GPT_ACTIONS_READ_API_KEY: READ_KEY,
          AGENT_ALPHA_ACTIONS_API_KEY: KEY, AGENT_BETA_ACTIONS_API_KEY: OPHELIA_KEY,
          AGENT_GAMMA_ACTIONS_API_KEY: 'FAKE-OSIRIS-ACTIONS-KEY-FOR-OFFLINE-TESTS' };
        const options = { env };
        if (override) options[legacyKeyName === 'GPT_ACTIONS_API_KEY' ? 'apiKey' : 'readOnlyApiKey'] = env[identity.apiKeyEnv];
        else env[identity.apiKeyEnv] = env[legacyKeyName];
        const app = { get() { assert.fail('route registered'); }, post() { assert.fail('route registered'); } };
        assert.deepEqual(registerGptActions(app, options), { registered: false, reason: 'duplicate_identity_keys' });
      }
    }
  }
});

for (const collision of ['full', 'read', 'both-identities']) {
  test(`forum-post never falls back to legacy or webhook if identity keys collide after registration: ${collision}`, async t => {
    const h = await harness(t);
    const key = collision === 'read' ? READ_KEY : LEGACY;
    h.env.AGENT_BETA_ACTIONS_API_KEY = key;
    if (collision === 'both-identities') h.env.AGENT_ALPHA_ACTIONS_API_KEY = key;
    for (const body of [FORUM_BODY, { ...FORUM_BODY, author: 'Opus 5.5 · Diretor' }]) {
      const result = await h.post(body, key, 'forum-post');
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { status: 'forbidden', error: 'unauthorized' });
    }
    assert.equal((await h.post({}, key, 'forum-tags')).status, 401);
    assert.equal((await h.get('status', key)).status, 401);
    assert.equal((await h.get('2a3a-mentions', key)).status, 401);
    assert.equal(h.calls.length, 0);
    assert.equal(h.logs.length, 0);
  });
}

test('real DiscordRequest transport never logs identity forum-post headers or error payloads', async t => {
  const output = [];
  const responseSecret = 'FAKE-RESPONSE-SECRET-NOT-FOR-LOGS';
  for (const method of ['info', 'error', 'log', 'warn', 'debug']) {
    t.mock.method(console, method, (...args) => output.push(args));
  }
  for (const method of ['info', 'error']) t.mock.method(audit, method, meta => output.push(meta));
  let sends = 0;
  let readErrorBody = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const endpoint = new URL(url).pathname.replace('/api/v10/', '');
    if (options.method === 'POST') {
      sends++;
      assert.equal(endpoint, `channels/${FORUM}/threads`);
      assert.equal(options.headers.Authorization === `Bot ${OPHELIA_TOKEN}`, true);
      assert.equal(Object.hasOwn(options, 'sensitiveErrors'), false);
      return { ok: false, status: 403, body: { cancel: async () => {} },
        json: async () => { readErrorBody = true; return { Authorization: options.headers.Authorization, message: responseSecret }; } };
    }
    assert.ok([`channels/${CATEGORY}`, `channels/${FORUM}`].includes(endpoint));
    return { ok: true, status: 200, json: async () => endpoint.endsWith(CATEGORY)
      ? { id: CATEGORY, guild_id: GUILD, type: 4 }
      : { id: FORUM, guild_id: GUILD, parent_id: CATEGORY, type: 15, available_tags: [{ id: TAG, name: 'Aberto' }] } };
  });
  const config = { valid: true, guildId: GUILD, categoryId: CATEGORY };
  const service = createChannel2a3aService({ readConfig: config, writeConfig: config,
    env: { AGENT_BETA_DISCORD_TOKEN: OPHELIA_TOKEN },
    // Give metadata GETs a synthetic credential too; only the service supplies POST auth.
    request: (endpoint, options) => DiscordRequest(endpoint, { ...options,
      headers: options.headers ?? { Authorization: 'Bot FAKE-LEGACY-DISCORD-TOKEN' } }),
    logger: { info: (...args) => output.push(args), error: (...args) => output.push(args) } });
  const result = await service.create2a3aForumPost(FORUM_BODY, DISCORD_AGENT_IDENTITIES[1]);
  assert.equal(result.error, 'identity_bot_unavailable');
  assert.equal(sends, 1);
  assert.equal(readErrorBody, false);
  assert.ok(output.some(item => item?.subsystem === 'discord-rest' && item.status === 403));
  const visible = JSON.stringify([result, output]);
  for (const value of [OPHELIA_TOKEN, 'FAKE-LEGACY-DISCORD-TOKEN', responseSecret, 'Authorization', 'headers', 'options']) {
    assert.equal(visible.includes(value), false);
  }
});
