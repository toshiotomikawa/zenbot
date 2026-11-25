import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

process.env.LOG_CHANNEL_ID = '1300000000000000088';
process.env.BOAS_VINDAS_CHANNEL_ID = '1300000000000000001';
process.env.NODE_TEST_CONTEXT = '1';

const { handleDispatch, loadJoinAccountIndex, postJoinLogEntry,
  reconcileBoasVindasJoins, setPresenceDiscordRequest } = await import('./presence.js');
const { DiscordRequest, DiscordMultipartRequest, formatJoinLogEntry } = await import('./utils.js');
const LOG = process.env.LOG_CHANNEL_ID;
const WELCOME = process.env.BOAS_VINDAS_CHANNEL_ID;
const logger = { info() {}, error() {} };
let nextUser = 0;

function fixture(t, { failFirst = false, history = [], welcome = [], holdHistory = null } = {}) {
  // No fixture writes a backup or reads real member data.
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'mkdirSync', () => {});
  t.mock.method(fs, 'writeFileSync', () => {});
  const backups = [];
  t.mock.method(fs, 'appendFileSync', (...args) => backups.push(args));
  const posts = [];
  const releases = [];
  const request = async (endpoint, options = {}) => {
    if (options.method === 'POST') {
      assert.equal(endpoint, `channels/${LOG}/messages`);
      posts.push(options.body);
      await new Promise((resolve) => releases.push(resolve));
      if (failFirst && posts.length === 1) throw new Error('simulated_rejection');
      return { json: async () => ({ id: String(posts.length) }) };
    }
    if (endpoint.startsWith(`channels/${LOG}/messages?`)) {
      if (holdHistory) await holdHistory;
      return { json: async () => history };
    }
    if (endpoint.startsWith(`channels/${WELCOME}/messages?`)) return { json: async () => welcome };
    throw new Error('unexpected_join_request');
  };
  setPresenceDiscordRequest(request);
  t.after(() => setPresenceDiscordRequest(null));
  return { posts, backups, release: () => releases.shift()?.() };
}

function entry() {
  return { userId: String(1300000000000000100n + BigInt(nextUser++)),
    displayName: 'Test member', joinedAt: '2026-08-01T12:00:59.900Z' };
}

function dispatch(source, data) {
  const user = { id: data.userId, username: data.displayName };
  if (source === 'member') handleDispatch('GUILD_MEMBER_ADD', { user, joined_at: data.joinedAt }, logger);
  else handleDispatch('MESSAGE_CREATE', { type: 7, channel_id: WELCOME,
    author: user, timestamp: new Date(new Date(data.joinedAt).getTime() + 200).toISOString() }, logger);
}

for (const sources of [['member', 'system'], ['system', 'member']]) {
  test(`concurrent ${sources.join(' + ')} posts once, including minute boundary`, async (t) => {
    const h = fixture(t);
    const data = entry();
    dispatch(sources[0], data);
    dispatch(sources[1], data);
    await setImmediate();
    const concurrentPosts = h.posts.length;
    // Release all requests even on the broken implementation.
    h.release(); h.release();
    await setImmediate();
    await postJoinLogEntry(data);
    assert.equal(concurrentPosts, 1);
    assert.equal(h.posts.length, 1);
    assert.equal(h.backups.length, 1);
    assert.deepEqual(h.posts[0].allowed_mentions, { parse: [] });
  });

  test(`failed ${sources[0]} leaves ${sources[1]} available`, async (t) => {
    const h = fixture(t, { failFirst: true });
    const data = entry();
    dispatch(sources[0], data);
    dispatch(sources[1], data);
    await setImmediate();
    h.release();
    await setImmediate();
    assert.equal(h.posts.length, 2);
    h.release();
    await setImmediate();
    assert.equal(await postJoinLogEntry(data), false);
    assert.equal(h.backups.length, 1);
  });

  test(`${sources[0]} alone still logs`, async (t) => {
    const h = fixture(t);
    const data = entry();
    dispatch(sources[0], data);
    await setImmediate();
    h.release();
    await setImmediate();
    assert.equal(await postJoinLogEntry(data), false);
    assert.equal(h.posts.length, 1);
    assert.equal(h.backups.length, 1);
  });
}

test('history load blocks live events until persisted joins are indexed', async (t) => {
  const data = entry();
  let releaseHistory;
  const holdHistory = new Promise((resolve) => { releaseHistory = resolve; });
  const h = fixture(t, { holdHistory,
    history: [{ id: '1300000000000000010', content: formatJoinLogEntry(data) }] });
  const loading = loadJoinAccountIndex();
  dispatch('member', data);
  dispatch('system', data);
  await setImmediate();
  assert.equal(h.posts.length, 0);
  releaseHistory();
  await loading;
  assert.equal(await postJoinLogEntry(data), false);
  assert.equal(h.posts.length, 0);
});

test('reconciliation and live member event share deduplication', async (t) => {
  const data = entry();
  const h = fixture(t, { welcome: [{ type: 7, author: { id: data.userId, username: data.displayName },
    timestamp: data.joinedAt }] });
  dispatch('member', data);
  const reconciling = reconcileBoasVindasJoins();
  await setImmediate();
  assert.equal(h.posts.length, 1);
  h.release();
  await reconciling;
  assert.equal(h.posts.length, 1);
});

test('distinct rejoin outside the window is logged', async (t) => {
  const h = fixture(t);
  const data = entry();
  const first = postJoinLogEntry(data);
  await setImmediate(); h.release();
  assert.equal(await first, true);
  const second = postJoinLogEntry({ ...data, joinedAt: '2026-08-01T12:04:00Z' });
  await setImmediate(); h.release();
  assert.equal(await second, true);
  assert.equal(h.posts.length, 2);
});

test('permanent join channel refuses deletion and mutation before network access', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{}'); });
  for (const request of [DiscordRequest, DiscordMultipartRequest]) {
    for (const method of ['DELETE', 'PATCH', 'delete', 'patch']) {
      for (const suffix of ['', '/', '?reason=test']) {
        await assert.rejects(request(`channels/${LOG}${suffix}`, { method, body: { archived: true } }),
          /protected_join_log_channel/);
      }
    }
  }
  assert.equal(requests, 0);
  await DiscordRequest(`channels/${LOG}`, { method: 'GET' });
  await DiscordRequest(`channels/${LOG}/messages`, { method: 'POST', body: { content: 'fixture' } });
  await DiscordMultipartRequest(`channels/${LOG}/messages`, { payloadJson: { content: 'fixture' } });
  await DiscordRequest('channels/1300000000000000002', { method: 'PATCH', body: { archived: true } });
  assert.equal(requests, 4);
});
