import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createDiscordAgentMentions, registerDiscordAgentMentionsRoute, MENTION_MAX_AGE_MS } from './discord-agent-mentions.js';
import { DISCORD_AGENT_IDENTITIES } from './discord-agent-identities.js';
import { registerGptActions, buildGptActionsOpenApi } from './gpt-actions.js';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const PARENT = '323456789012345678';
const ROLE = '423456789012345678';
const OPUS = DISCORD_AGENT_IDENTITIES[0].botUserId;
const OPHELIA = DISCORD_AGENT_IDENTITIES[1].botUserId;
const OSIRIS = DISCORD_AGENT_IDENTITIES[2].botUserId;
const ENV = { MCP_DISCORD_2A3A_GUILD_ID: GUILD, AGENT_ALPHA_ACTIONS_API_KEY: 'o'.repeat(40), AGENT_BETA_ACTIONS_API_KEY: 'p'.repeat(40), AGENT_GAMMA_ACTIONS_API_KEY: 'q'.repeat(40) };
function fixture(now = Date.now) {
  const queue = createDiscordAgentMentions({ now, bootId: 'test-boot' });
  let sequence = 0;
  const message = (overrides = {}) => ({ id: String(523456789012345678n + BigInt(sequence++)), guild_id: GUILD,
    channel_id: CHANNEL, author: { id: '623456789012345678', username: 'human', bot: false },
    mentions: [{ id: OPUS }], mention_roles: [], content: 'hello', timestamp: new Date(now()).toISOString(), ...overrides });
  const request = async path => ({ json: async () => path.endsWith('/roles')
    ? [{ id: ROLE, managed: true, tags: { bot_id: OPHELIA } }]
    : { id: path.split('/')[1], guild_id: GUILD, name: path.endsWith(CHANNEL) ? 'channel' : 'parent',
      ...(path.endsWith(CHANNEL) ? { parent_id: PARENT } : {}) } });
  const ingest = data => queue.ingest(data, { env: ENV, request });
  return { queue, message, ingest, request };
}
function route(queue, env = ENV, logger = { info() {} }) {
  let handler;
  registerDiscordAgentMentionsRoute({ get(path, fn) { assert.equal(path, '/actions/2a3a-mentions'); handler = fn; } }, { env, queue, logger });
  return async (key, query = {}) => {
    const res = Object.assign(new EventEmitter(), { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
    await handler({ headers: { authorization: `Bearer ${key}` }, query }, res);
    return res;
  };
}

test('identity auth fails closed; each key only reads its own queue; logs contain only metadata', async () => {
  const f = fixture();
  await f.ingest(f.message());
  await f.ingest(f.message({ mentions: [{ id: OPHELIA }] }));
  await f.ingest(f.message({ mentions: [{ id: OSIRIS }] }));
  const logs = [];
  const invoke = route(f.queue, ENV, { info: value => logs.push(value) });
  for (const key of ['wrong', '', 'l'.repeat(40), `${ENV.AGENT_ALPHA_ACTIONS_API_KEY} extra`]) {
    const res = await invoke(key);
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { status: 'forbidden', error: 'unauthorized' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  for (const identity of DISCORD_AGENT_IDENTITIES) {
    const res = await invoke(ENV[identity.apiKeyEnv]);
    assert.equal(res.body.identity, identity.id);
    assert.equal(res.body.mentions.length, 1);
    assert.equal(res.body.mentions[0].content, 'hello');
  }
  assert.ok(logs.every(log => Object.keys(log).sort().join() === 'cursor,identity,quantity'));
  const duplicate = route(f.queue, { ...ENV, AGENT_BETA_ACTIONS_API_KEY: ENV.AGENT_ALPHA_ACTIONS_API_KEY });
  assert.equal((await duplicate(ENV.AGENT_ALPHA_ACTIONS_API_KEY)).code, 401);
  assert.equal((await route(f.queue, {})(ENV.AGENT_ALPHA_ACTIONS_API_KEY)).code, 401);
});

test('filters bots, everyone/here-only, wrong guild; accepts direct and managed bot-role mentions', async () => {
  const f = fixture();
  for (const overrides of [{ author: { id: '623456789012345678', bot: true } },
    { mentions: [], mention_everyone: true, content: '@everyone @here' },
    { guild_id: '723456789012345678' }, { mentions: [], mention_roles: ['823456789012345678'] }]) {
    await f.ingest(f.message(overrides));
  }
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 0);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 0);
  const direct = f.message();
  await f.ingest(direct);
  await f.ingest(direct); // Gateway replay does not duplicate a retained message.
  await f.ingest(f.message({ mentions: [], mention_roles: [ROLE] }));
  const item = (await f.queue.poll('agent-alpha')).mentions[0];
  assert.equal(item.channel_name, 'channel');
  assert.equal(item.parent_name, 'parent');
  assert.equal(item.parent_id, PARENT);
  assert.equal(item.author_name, 'human');
  assert.equal(item.url, `https://discord.com/channels/${GUILD}/${CHANNEL}/${direct.id}`);
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 1);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 1);
  const unManaged = f.message({ mentions: [], mention_roles: [ROLE] });
  const fresh = fixture();
  await fresh.queue.ingest(unManaged, { env: ENV, request: async path => path.endsWith('/roles')
    ? { json: async () => [{ id: ROLE, managed: false, tags: { bot_id: OPHELIA } }] } : f.request(path) });
  assert.equal((await fresh.queue.poll('agent-beta')).mentions.length, 0);
});

test('role REST failure preserves direct mentions and all-direct mentions skip role lookup', async () => {
  const f = fixture();
  let calls = 0;
  const request = async path => {
    if (path.endsWith('/roles')) { calls++; throw new Error('REST failure'); }
    return f.request(path);
  };
  await f.queue.ingest(f.message({ mention_roles: [ROLE] }), { env: ENV, request });
  assert.equal(calls, 1);
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 1);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 0);
  await f.queue.ingest(f.message({ mentions: [{ id: OPUS }, { id: OPHELIA }, { id: OSIRIS }], mention_roles: [ROLE] }), { env: ENV, request });
  assert.equal(calls, 1);
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 2);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 1);
});

test('managed role cache avoids a second REST call and expires at one hour', async () => {
  let time = Date.now();
  const f = fixture(() => time);
  let calls = 0;
  const request = async path => {
    if (path.endsWith('/roles')) calls++;
    return f.request(path);
  };
  const ingest = () => f.queue.ingest(f.message({ mentions: [], mention_roles: [ROLE] }), { env: ENV, request });
  await ingest();
  time += 60 * 60 * 1000 - 1;
  await ingest();
  assert.equal(calls, 1);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 2);
  time++;
  await ingest();
  assert.equal(calls, 2);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 3);
});

test('non-array roles preserve direct mentions without selecting a role identity', async () => {
  for (const roles of [null, {}, 'invalid']) {
    const f = fixture();
    const request = async path => path.endsWith('/roles') ? { json: async () => roles } : f.request(path);
    await f.queue.ingest(f.message({ mention_roles: [ROLE] }), { env: ENV, request });
    await f.queue.ingest(f.message({ mentions: [], mention_roles: [ROLE] }), { env: ENV, request });
    assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 1);
    assert.equal((await f.queue.poll('agent-beta')).mentions.length, 0);
  }
});

test('queue retains at most 200 per identity and drops items older than 72 hours', async () => {
  let time = Date.now();
  const f = fixture(() => time);
  for (let i = 0; i < 205; i++) await f.ingest(f.message());
  await f.ingest(f.message({ mentions: [{ id: OPHELIA }] }));
  const result = await f.queue.poll('agent-alpha');
  assert.equal(result.mentions.length, 200);
  assert.equal(result.mentions[0].cursor, 6);
  assert.equal(result.cursor, 206);
  time += MENTION_MAX_AGE_MS;
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 200);
  time++;
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 0);
  assert.equal((await f.queue.poll('agent-beta')).mentions.length, 0);
  await f.ingest(f.message({ timestamp: new Date(time - MENTION_MAX_AGE_MS - 1).toISOString() }));
  assert.equal((await f.queue.poll('agent-alpha')).mentions.length, 0);
});

test('long-poll wakes only for the selected identity and expires empty', async () => {
  const f = fixture();
  let resolved = false;
  const waiting = f.queue.poll('agent-alpha', { wait: 1 }).then(result => { resolved = true; return result; });
  await f.ingest(f.message({ mentions: [{ id: OPHELIA }] }));
  await Promise.resolve();
  assert.equal(resolved, false);
  await f.ingest(f.message());
  const result = await waiting;
  assert.equal(result.mentions.length, 1);
  const start = Date.now();
  const empty = await f.queue.poll('agent-alpha', { after: result.cursor, wait: 1 });
  assert.equal(empty.mentions.length, 0);
  assert.ok(Date.now() - start >= 900);
});

test('abort releases a pending long-poll', async () => {
  const f = fixture();
  const controller = new AbortController();
  const waiting = f.queue.poll('agent-alpha', { wait: 25 }, controller.signal);
  controller.abort();
  assert.equal((await waiting).mentions.length, 0);
});

test('old boot returns all retained items; same boot obeys cursor; content is bounded', async () => {
  const f = fixture();
  await f.ingest(f.message({ content: 'a'.repeat(1501) }));
  await f.ingest(f.message({ content: 'b'.repeat(1500) }));
  const first = await f.queue.poll('agent-alpha');
  assert.equal(first.mentions[0].content.length, 1500);
  assert.equal(first.mentions[0].truncated, true);
  assert.equal('truncated' in first.mentions[1], false);
  assert.equal((await f.queue.poll('agent-alpha', { after: first.cursor, boot_id: 'old-boot' })).mentions.length, 2);
  assert.equal((await f.queue.poll('agent-alpha', { after: first.cursor, boot_id: first.boot_id })).mentions.length, 0);
  assert.equal((await f.queue.poll('agent-alpha', { after: first.mentions[0].cursor })).mentions.length, 1);
  assert.equal((await f.queue.poll('agent-alpha', { after: 999 })).boot_id, 'test-boot');
});

test('route rejects invalid query parameters with closed error', async () => {
  const invoke = route(fixture().queue);
  for (const query of [{ wait: '26' }, { wait: '-1' }, { wait: '1.2' }, { after: 'NaN' },
    { after: '9007199254740992' }, { after: ['1', '2'] }, { wait: '1\n' },
    { identity: 'agent-beta' }, { boot_id: ['a'] }, { boot_id: 'boot\n' }]) {
    const res = await invoke(ENV.AGENT_ALPHA_ACTIONS_API_KEY, query);
    assert.equal(res.code, 400);
    assert.deepEqual(res.body, { status: 'invalid_input', error: 'invalid_mentions_query' });
  }
  assert.equal((await invoke(ENV.AGENT_ALPHA_ACTIONS_API_KEY, { wait: '0', after: '0', boot_id: 'old-boot' })).code, 200);
});

test('Actions bootstrap registers the GET route under existing gates', () => {
  const routes = new Map();
  const app = { get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, post() {} };
  registerGptActions(app, { env: { ...ENV, GPT_ACTIONS_ENABLED: 'true', GPT_ACTIONS_API_KEY: 'a'.repeat(40) },
    channel2a3aReadConfig: { valid: true, guildId: GUILD }, channel2a3aService: {}, logger: { info() {} } });
  assert.ok(routes.has('GET /actions/2a3a-mentions'));
  const schema = buildGptActionsOpenApi({ baseUrl: 'https://example.com', mentions: true }).paths['/actions/2a3a-mentions'].get;
  assert.equal(schema.operationId, 'get2a3aMentions');
  assert.equal(schema.parameters.find(parameter => parameter.name === 'wait').schema.maximum, 25);
});

test('HTTP route authenticates, validates repeated query params, and releases a real long-poll', async t => {
  const f = fixture();
  const app = express();
  let pollStarted;
  const started = new Promise(resolve => { pollStarted = resolve; });
  const queue = { poll(...args) {
    const result = f.queue.poll(...args);
    pollStarted();
    return result;
  } };
  registerGptActions(app, { env: { ...ENV, GPT_ACTIONS_ENABLED: 'true', GPT_ACTIONS_API_KEY: 'a'.repeat(40) },
    mentionsQueue: queue, channel2a3aReadConfig: { valid: true, guildId: GUILD },
    channel2a3aService: {}, logger: { info() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/actions/2a3a-mentions`;
  const headers = { Authorization: `Bearer ${ENV.AGENT_ALPHA_ACTIONS_API_KEY}` };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}?after=1&after=2`, { headers })).status, 400);
  const pending = fetch(`${url}?after=0&wait=25`, { headers });
  await started;
  await f.ingest(f.message());
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.identity, 'agent-alpha');
  assert.equal(body.mentions.length, 1);
  const isolated = await fetch(url, { headers: { Authorization: `Bearer ${ENV.AGENT_BETA_ACTIONS_API_KEY}` } });
  assert.equal((await isolated.json()).mentions.length, 0);
});

test('registered identity bots reach peer queues but never their own queue', async () => {
  const f = fixture();
  await f.ingest(f.message({ author: { id: OPHELIA, bot: true }, mentions: [{ id: OPUS }] }));
  await f.ingest(f.message({ author: { id: OPUS, bot: true }, mentions: [{ id: OPUS }, { id: OPHELIA }] }));
  await f.ingest(f.message({ author: { id: '623456789012345678', bot: true } }));
  await f.ingest(f.message({ author: { id: OPHELIA, bot: true }, webhook_id: '723456789012345678' }));
  const opus = (await f.queue.poll('agent-alpha')).mentions;
  assert.equal(opus.length, 1);
  assert.equal(opus[0].author_id, OPHELIA);
  const ophelia = (await f.queue.poll('agent-beta')).mentions;
  assert.equal(ophelia.length, 1);
  assert.equal(ophelia[0].author_id, OPUS);
});
