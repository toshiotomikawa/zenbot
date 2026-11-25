/**
 * Offline reliability tests for FortniteStatus Filtered Stream.
 * No live X API or Discord calls.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  adaptV2PostToTweet,
  buildEmbedMessage,
  buildUserTimelineUrl,
  canonicalStatusUrl,
  clampTimelineMaxResults,
  computeBackoffMs,
  configReadyForLive,
  createBoundedQueue,
  createFortniteStatusSeenStore,
  createFortniteStatusStreamClient,
  createNdjsonBuffer,
  createPostProcessor,
  createSerialQueueWorker,
  createWatchdog,
  classifyRecoveryHttpError,
  combineAbortSignals,
  fetchRecoveryPosts,
  logicalPostId,
  normalizeV2Post,
  parseStreamLine,
  publishNormalizedPost,
  rateLimitWaitMs,
  readFortniteStatusStreamConfig,
  startFortniteStatusStream,
} from './fortnite-status-stream.js';

const USER_ID = '1111111111111111111';

function tempCachePath() {
  return path.join(
    os.tmpdir(),
    `zenbot-fns-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

function basePost(overrides = {}) {
  return {
    id: '2000000000000000001',
    author_id: USER_ID,
    text: 'Servers are up',
    created_at: '2026-08-05T12:00:00.000Z',
    edit_history_tweet_ids: ['2000000000000000001'],
    public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, impression_count: 10 },
    ...overrides,
  };
}

function includesUsers(extra = []) {
  return {
    users: [
      {
        id: USER_ID,
        name: 'Fortnite Status',
        username: 'FortniteStatus',
        profile_image_url: 'https://example.test/a.jpg',
        verified: true,
        verified_type: 'business',
      },
      ...extra,
    ],
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function baseEnv(extra = {}) {
  return {
    FORTNITE_STATUS_STREAM_ENABLED: '1',
    X_API_BEARER_TOKEN: 'b',
    FORTNITE_STATUS_CHANNEL_ID: 'c',
    FORTNITE_STATUS_USER_ID: USER_ID,
    DISCORD_TOKEN: 'd',
    FORTNITE_STATUS_RENDER_MODE: 'embed',
    ...extra,
  };
}

// ─── Basics preserved ────────────────────────────────────────────────────────

test('config defaults to disabled', () => {
  const c = readFortniteStatusStreamConfig({});
  assert.equal(c.enabled, false);
  assert.equal(configReadyForLive(c).reason, 'disabled');
});

test('ndjson incomplete flush is not an event', () => {
  const b = createNdjsonBuffer();
  b.push('{"incomplete"');
  assert.ok(b.flushIncomplete().discarded > 0);
});

test('canonical URL and repost labeling', () => {
  const id = '2000000000000000042';
  assert.equal(canonicalStatusUrl(id), `https://x.com/FortniteStatus/status/${id}`);
  const rt = normalizeV2Post(
    basePost({
      id: '50',
      edit_history_tweet_ids: ['50'],
      referenced_tweets: [{ type: 'retweeted', id: '300' }],
    }),
    {
      users: [
        ...includesUsers().users,
        { id: '222', name: 'Other', username: 'OtherUser' },
      ],
      tweets: [{ id: '300', author_id: '222', text: 'orig', edit_history_tweet_ids: ['300'] }],
    },
    { userId: USER_ID },
  );
  const tweet = adaptV2PostToTweet(rt.post, rt.includes);
  assert.match(tweet.text, /repostou/i);
  const embed = buildEmbedMessage(rt, tweet);
  assert.equal(embed.content, 'https://x.com/FortniteStatus/status/50');
});

test('edit clears attachments', async () => {
  const n = normalizeV2Post(
    basePost({
      id: '2',
      edit_history_tweet_ids: ['1', '2'],
      text: 'edited',
    }),
    includesUsers(),
    { userId: USER_ID },
  );
  let body;
  const r = await publishNormalizedPost(n, {
    config: { channelId: 'ch', renderMode: 'auto' },
    existingMessageId: 'msg',
    discordRequest: async (_e, o) => {
      body = o.body;
      return { ok: true, json: async () => ({ id: 'msg' }) };
    },
  });
  assert.equal(r.clearedAttachments, true);
  assert.deepEqual(body.attachments, []);
});

// ─── Fatal pauses pipeline; second never runs ────────────────────────────────

test('fatal on first queue item never processes second before recovery', async () => {
  const queue = createBoundedQueue(10);
  const processed = [];
  let fatals = 0;
  const worker = createSerialQueueWorker({
    queue,
    sleep: async () => {},
    onFatal: () => { fatals += 1; },
    processItem: async (item) => {
      processed.push(item.id);
      if (item.id === '1') {
        // exhaust as fatal immediately
        return { action: 'fatal', reason: 'discord_failed' };
      }
      return { action: 'posted' };
    },
  });
  const run = worker.start();
  worker.push({ id: '1' });
  worker.push({ id: '2' });
  await sleep(40);
  assert.deepEqual(processed, ['1']);
  assert.equal(fatals, 1);
  assert.equal(worker.paused, true);
  // Second still sitting in queue, never processed
  assert.equal(queue.peek()?.id, '2');
  worker.stop();
  await run;
});

test('cursor stays at last confirmed after fatal via real worker+processor', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('0', { messageId: 'm0', latestPostId: '0' });
    assert.equal(store.lastSinceId, '0');

    const queue = createBoundedQueue(10);
    let publishCalls = [];
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv()),
      seenStore: store,
      maxAttempts: 1,
      publish: async (n) => {
        publishCalls.push(n.postId);
        return { ok: false, reason: 'discord_failed' };
      },
    });
    let fatal = false;
    const worker = createSerialQueueWorker({
      queue,
      sleep: async () => {},
      onFatal: () => { fatal = true; },
      processItem: async (item) => {
        const n = normalizeV2Post(item.data, item.includes, { userId: USER_ID });
        return processor.handleNormalized(n, { attempt: item.attempt || 0, source: 'stream' });
      },
    });
    const run = worker.start();
    worker.push({
      kind: 'post',
      data: basePost({ id: '1', edit_history_tweet_ids: ['1'] }),
      includes: {},
      attempt: 0,
    });
    worker.push({
      kind: 'post',
      data: basePost({ id: '2', edit_history_tweet_ids: ['2'] }),
      includes: {},
      attempt: 0,
    });
    await sleep(40);
    assert.equal(fatal, true);
    assert.equal(worker.paused, true);
    assert.deepEqual(publishCalls, ['1']);
    assert.equal(store.lastSinceId, '0');
    assert.equal(store.hasLogical('1'), false);
    assert.equal(store.hasLogical('2'), false);
    worker.stop();
    await run;
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

// ─── Worker pause / reconnect / no concurrent publish ────────────────────────

test('worker paused during reconnect and idle before queue clear', async () => {
  const cachePath = tempCachePath();
  try {
    let resolvePublish;
    const publishGate = new Promise((r) => { resolvePublish = r; });
    let publishStarted = false;
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath })),
      seenStore: store,
      maxAttempts: 3,
      publish: async () => {
        publishStarted = true;
        await publishGate;
        return { ok: true, mode: 'embed', messageId: 'm1' };
      },
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [], meta: {} }) }),
    });
    // Start worker via client internals
    const run = client.worker.start();
    client.worker.resume();
    client.queue.push({
      kind: 'post',
      data: basePost({ id: '5', edit_history_tweet_ids: ['5'] }),
      includes: {},
      attempt: 0,
    });
    client.worker.notify();
    await sleep(20);
    assert.equal(publishStarted, true);
    assert.equal(client.worker.busy, true);

    // prepareForReconnect must wait until publish finishes — kick it and release publish
    const prep = client._prepareForReconnect();
    await sleep(20);
    // Still busy — must not have cleared while busy
    assert.equal(client.worker.busy, true);
    resolvePublish();
    await prep;
    assert.equal(client.worker.paused, true);
    assert.equal(client.worker.busy, false);
    assert.equal(client.queue.size, 0);
    assert.equal(client._lastClearWhileBusy, false);
    client.worker.stop();
    await run;
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('no concurrent processItem between worker path (peak 1)', async () => {
  const queue = createBoundedQueue(10);
  let concurrent = 0;
  let peak = 0;
  const worker = createSerialQueueWorker({
    queue,
    sleep,
    processItem: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await sleep(25);
      concurrent -= 1;
      return { action: 'posted' };
    },
  });
  const run = worker.start();
  worker.push({ a: 1 });
  worker.push({ a: 2 });
  await sleep(80);
  worker.stop();
  await run;
  assert.equal(peak, 1);
});

test('recovery and stream duplicate posts only once via shared processor lock', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    let posts = 0;
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv()),
      seenStore: store,
      publish: async () => {
        posts += 1;
        await sleep(5);
        return { ok: true, mode: 'embed', messageId: 'm1' };
      },
    });
    const n = normalizeV2Post(basePost(), includesUsers(), { userId: USER_ID });
    const [a, b] = await Promise.all([
      processor.handleNormalized(n, { source: 'recovery' }),
      processor.handleNormalized(n, { source: 'stream' }),
    ]);
    const actions = [a.action, b.action].sort();
    assert.ok(actions.includes('posted') || actions.includes('updated'));
    assert.ok(actions.includes('duplicate_inflight') || actions.includes('duplicate'));
    assert.equal(posts, 1);
    assert.equal(processor.concurrentPublishPeak, 1);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

// ─── Recovery success / failure buffering ────────────────────────────────────

test('successful recovery loads recovery then hold then live order', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    const published = [];
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath })),
      seenStore: store,
      publish: async (n) => {
        published.push(n.postId);
        return { ok: true, mode: 'embed', messageId: `m-${n.postId}` };
      },
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [
            basePost({ id: '2', edit_history_tweet_ids: ['2'], created_at: '2026-08-05T12:01:00.000Z' }),
          ],
          meta: {},
        }),
      }),
    });

    const run = client.worker.start();
    client.worker.pause();
    // Simulate held stream event id 3 during recovery window
    client._setHolding(true);
    client._setLiveMode(false);
    client._enqueuePost(
      basePost({ id: '3', edit_history_tweet_ids: ['3'], created_at: '2026-08-05T12:02:00.000Z' }),
      {},
      'stream',
    );
    assert.equal(client._getHoldBuffer().length, 1);

    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.complete, true);
    assert.equal(phase.ok, true);
    const loaded = client._loadQueueRecoveryThenHold(phase.posts);
    assert.equal(loaded.ok, true);
    // Queue order: recovery 2 then held 3
    assert.equal(client.queue.toArray()[0].data.id, '2');
    assert.equal(client.queue.toArray()[1].data.id, '3');
    client._setLiveMode(true);
    client._setHolding(false);
    client.worker.resume();
    await client._drainQueueUntilEmpty();
    assert.deepEqual(published, ['2', '3']);
    client.worker.stop();
    await run;
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('HTTP error on recovery keeps buffer blocked and needRecovery', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    client._setHolding(true);
    client._setLiveMode(false);
    client._enqueuePost(basePost({ id: '9', edit_history_tweet_ids: ['9'] }), {}, 'stream');
    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.ok, false);
    assert.equal(phase.complete, false);
    // Simulate failed recovery handling
    client._requestReconnect(phase.reason);
    assert.equal(client._needRecovery, true);
    assert.equal(client._liveMode, false);
    assert.equal(client._holdingStream, true);
    assert.equal(client._getHoldBuffer().length, 1);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('timeout on recovery keeps buffer blocked', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async () => {
        const err = new Error('timeout');
        err.code = 'TIMEOUT';
        throw err;
      },
    });
    client._setHolding(true);
    client._enqueuePost(basePost({ id: '8', edit_history_tweet_ids: ['8'] }), {}, 'stream');
    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.ok, false);
    assert.equal(phase.reason, 'timeout');
    client._requestReconnect('timeout');
    assert.equal(client._needRecovery, true);
    assert.equal(client._getHoldBuffer().length, 1);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('fatal during recovery publish keeps pipeline paused', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv()),
      seenStore: store,
      maxAttempts: 1,
      publish: async () => ({ ok: false, reason: 'discord_failed' }),
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [basePost({ id: '2', edit_history_tweet_ids: ['2'] })],
          meta: {},
        }),
      }),
    });
    const run = client.worker.start();
    client.worker.pause();
    client._setHolding(true);
    client._enqueuePost(basePost({ id: '3', edit_history_tweet_ids: ['3'] }), {}, 'stream');
    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.ok, true);
    client._loadQueueRecoveryThenHold(phase.posts);
    client.worker.resume();
    await sleep(40);
    // Fatal should pause worker; hold was already loaded into queue but
    // second item must not publish after fatal on first recovery item.
    assert.equal(client.worker.paused, true);
    assert.equal(store.lastSinceId, '1');
    assert.equal(client._needRecovery, true);
    client.worker.stop();
    await run;
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

// ─── Backlog exceeded ────────────────────────────────────────────────────────

test('exactly recoveryMax items with next_token is backlog exceeded', async () => {
  const r = await fetchRecoveryPosts({
    userId: USER_ID,
    sinceId: '1',
    recoveryMax: 2,
    bearerToken: 'x',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [
          basePost({ id: '10', edit_history_tweet_ids: ['10'] }),
          basePost({ id: '11', edit_history_tweet_ids: ['11'] }),
        ],
        meta: { next_token: 'more' },
      }),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'backlog_exceeded');
  assert.equal(r.capped, true);
  assert.equal(r.posts.length, 0);
});

test('backlog exceeded does not publish or advance cursor', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let posts = 0;
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv()),
      seenStore: store,
      publish: async () => {
        posts += 1;
        return { ok: true, mode: 'embed', messageId: 'x' };
      },
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({
        FORTNITE_STATUS_CACHE_PATH: cachePath,
        FORTNITE_STATUS_RECOVERY_MAX: '2',
      }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [
            basePost({ id: '2', edit_history_tweet_ids: ['2'] }),
            basePost({ id: '3', edit_history_tweet_ids: ['3'] }),
          ],
          meta: { next_token: 'MORE' },
        }),
      }),
    });
    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.ok, false);
    assert.equal(phase.reason, 'backlog_exceeded');
    assert.equal(posts, 0);
    assert.equal(store.lastSinceId, '1');
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

// ─── Hold overflow / backoff stability ───────────────────────────────────────

test('holdBuffer overflow aborts without silent loss of prior held items', () => {
  const client = createFortniteStatusStreamClient({
    env: baseEnv({ FORTNITE_STATUS_HOLD_BUFFER_MAX: '1' }),
    allowDiscordHistory: false,
    sleep: async () => {},
  });
  client._setHolding(true);
  client._setLiveMode(false);
  assert.equal(client._enqueuePost(basePost({ id: '1', edit_history_tweet_ids: ['1'] }), {}, 'stream').ok, true);
  assert.equal(client._enqueuePost(basePost({ id: '2', edit_history_tweet_ids: ['2'] }), {}, 'stream').ok, false);
  assert.equal(client._needRecovery, true);
  assert.equal(client._getHoldBuffer().length, 1);
  assert.equal(client._getHoldBuffer()[0].data.id, '1');
});

test('classify recovery HTTP and rate-limit wait floor', () => {
  assert.equal(classifyRecoveryHttpError(429), 'rate_limit');
  assert.equal(classifyRecoveryHttpError(503), 'http');
  assert.equal(classifyRecoveryHttpError(401), 'permanent');
  const floor = computeBackoffMs('rate_limit', 0);
  const farReset = String(Math.floor(Date.now() / 1000) + 3600);
  assert.ok(rateLimitWaitMs(0, farReset) >= floor);
  assert.ok(rateLimitWaitMs(0, farReset) >= 3_500_000);
});

test('combineAbortSignals aborts when either signal aborts', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const c = combineAbortSignals(a.signal, b.signal);
  assert.equal(c.aborted, false);
  b.abort();
  assert.equal(c.aborted, true);
});

// ─── Retries / misc ──────────────────────────────────────────────────────────

test('discord retry then success', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    let n = 0;
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv()),
      seenStore: store,
      maxAttempts: 3,
      publish: async () => {
        n += 1;
        if (n < 2) return { ok: false, reason: 'discord_failed' };
        return { ok: true, mode: 'embed', messageId: 'm' };
      },
    });
    const post = normalizeV2Post(basePost(), includesUsers(), { userId: USER_ID });
    let r = await processor.handleNormalized(post, { attempt: 0 });
    assert.equal(r.action, 'retry');
    r = await processor.handleNormalized(post, { attempt: r.attempt });
    assert.equal(r.action, 'posted');
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('clamp max_results and timeline url', () => {
  assert.equal(clampTimelineMaxResults(1), 5);
  assert.equal(clampTimelineMaxResults(7), 7);
  assert.match(buildUserTimelineUrl(USER_ID, { maxResults: 6 }), /max_results=6/);
});

test('startFortniteStatusStream does not attach SIGTERM', () => {
  const before = process.listenerCount('SIGTERM');
  startFortniteStatusStream({ env: {} });
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('recovery omitted without prior state', async () => {
  const cachePath = tempCachePath();
  try {
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      fetchImpl: async () => { throw new Error('no'); },
    });
    const r = await client._fetchRecoveryPhase();
    assert.equal(r.skipped, true);
    assert.equal(r.complete, true);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('logical id edit history', () => {
  assert.equal(
    logicalPostId(basePost({
      id: '9',
      edit_history_tweet_ids: ['1', '9'],
    })),
    '1',
  );
});

test('parseStreamLine invalid safe', () => {
  assert.equal(parseStreamLine('{x').kind, 'invalid_json');
});

test('watchdog fires', async () => {
  let fired = 0;
  let now = 0;
  const w = createWatchdog({
    timeoutMs: 40,
    now: () => now,
    onTimeout: () => { fired += 1; },
  });
  w.start();
  w.touch();
  now = 100;
  await sleep(60);
  w.stop();
  assert.ok(fired >= 1);
});

test('backoff classes', () => {
  assert.ok(computeBackoffMs('network', 5) >= computeBackoffMs('network', 0));
});

// ─── Generation gate / structured recovery (integrated client) ───────────────

function emptyStreamBody(closeMs = 30) {
  return {
    getReader() {
      let doneOnce = false;
      return {
        async read() {
          if (!doneOnce) {
            await new Promise((r) => setTimeout(r, closeMs));
            doneOnce = true;
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function hangStreamBody(signal) {
  return {
    getReader() {
      return {
        async read() {
          await new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener?.('abort', resolve, { once: true });
            // keep-alive style idle
            setTimeout(resolve, 60_000);
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

test('invalidated attempt after delayed recovery never goes live or publishes', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let published = 0;
    let timelineStarted = null;
    let timelineFinish;
    const timelineGate = new Promise((r) => { timelineFinish = r; });
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath })),
      seenStore: store,
      publish: async () => {
        published += 1;
        return { ok: true, mode: 'embed', messageId: 'm' };
      },
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        if (String(url).includes('/tweets/search/stream')) {
          return { ok: true, body: hangStreamBody(init.signal) };
        }
        timelineStarted = Date.now();
        await timelineGate;
        if (init.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return {
          ok: true,
          json: async () => ({
            data: [basePost({ id: '2', edit_history_tweet_ids: ['2'] })],
            meta: {},
          }),
        };
      },
    });

    const genBefore = client._attemptGeneration;
    // Manually drive one connect barrier
    const ac = new AbortController();
    // Simulate start of attempt
    client.worker.start();
    client.worker.pause();
    // Bump generation as connectOnce would via runLoop — use private reconnect
    // by starting barrier with current gen then invalidating
    const attemptId = client._attemptGeneration;
    const barrierPromise = client._runBarrier(attemptId, ac.signal);
    await sleep(20);
    assert.ok(timelineStarted != null);
    // Invalidate while recovery in flight (watchdog / stream error)
    client._requestReconnect('watchdog');
    timelineFinish();
    const outcome = await barrierPromise;
    assert.equal(outcome.invalidated || outcome.reason === 'attempt_invalidated' || !outcome.ok, true);
    assert.equal(client._liveMode, false);
    assert.equal(published, 0);
    assert.ok(client._attemptGeneration > genBefore || client._needRecovery);
    client.worker.stop();
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stream error during recovery invalidates; late timeline success does not go live', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let published = 0;
    let finishTimeline;
    const gate = new Promise((r) => { finishTimeline = r; });
    const processor = createPostProcessor({
      config: readFortniteStatusStreamConfig(baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath })),
      seenStore: store,
      publish: async () => {
        published += 1;
        return { ok: true, mode: 'embed', messageId: 'm' };
      },
    });
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        if (String(url).includes('stream')) {
          return { ok: true, body: hangStreamBody(init.signal) };
        }
        await gate;
        return {
          ok: true,
          json: async () => ({
            data: [basePost({ id: '2', edit_history_tweet_ids: ['2'] })],
            meta: {},
          }),
        };
      },
    });
    client.worker.start();
    client.worker.pause();
    const attemptId = client._attemptGeneration;
    const p = client._runBarrier(attemptId, new AbortController().signal);
    await sleep(10);
    client._requestReconnect('stream_error');
    finishTimeline();
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(client._liveMode, false);
    assert.equal(published, 0);
    client.worker.stop();
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stop() during recovery prevents later resume', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let finishTimeline;
    const gate = new Promise((r) => { finishTimeline = r; });
    let published = 0;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      processor: createPostProcessor({
        config: readFortniteStatusStreamConfig(baseEnv()),
        seenStore: store,
        publish: async () => {
          published += 1;
          return { ok: true, mode: 'embed', messageId: 'm' };
        },
      }),
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) return { ok: true, body: emptyStreamBody(5) };
        await gate;
        return {
          ok: true,
          json: async () => ({
            data: [basePost({ id: '2', edit_history_tweet_ids: ['2'] })],
            meta: {},
          }),
        };
      },
    });
    client.worker.start();
    client.worker.pause();
    const attemptId = client._attemptGeneration;
    const p = client._runBarrier(attemptId, new AbortController().signal);
    await sleep(10);
    await client.stop();
    finishTimeline();
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(client._liveMode, false);
    assert.equal(published, 0);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('timeline 429 yields rate_limit class and respects reset header', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: { get: (h) => (String(h).toLowerCase() === 'x-rate-limit-reset' ? reset : null) },
        json: async () => ({}),
      }),
    });
    const phase = await client._fetchRecoveryPhase();
    assert.equal(phase.ok, false);
    assert.equal(phase.backoffKind, 'rate_limit');
    assert.equal(phase.rateLimitReset, reset);
    const wait = rateLimitWaitMs(0, phase.rateLimitReset);
    assert.ok(wait >= 60_000);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('timeline 503 is http class; 401/403 permanent/blocked path', async () => {
  assert.equal(classifyRecoveryHttpError(503), 'http');
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    for (const status of [401, 403]) {
      const client = createFortniteStatusStreamClient({
        env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
        allowDiscordHistory: false,
        seenStore: store,
        sleep: async () => {},
        fetchImpl: async () => ({
          ok: false,
          status,
          headers: { get: () => null },
          json: async () => ({}),
        }),
      });
      const phase = await client._fetchRecoveryPhase();
      assert.equal(phase.ok, false);
      assert.equal(phase.backoffKind, 'permanent');
    }
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('backlog_exceeded blocks further recovery attempts until clear', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let timelineCalls = 0;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({
        FORTNITE_STATUS_CACHE_PATH: cachePath,
        FORTNITE_STATUS_RECOVERY_MAX: '2',
      }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async () => {
        timelineCalls += 1;
        return {
          ok: true,
          json: async () => ({
            data: [
              basePost({ id: '2', edit_history_tweet_ids: ['2'] }),
              basePost({ id: '3', edit_history_tweet_ids: ['3'] }),
            ],
            meta: { next_token: 'MORE' },
          }),
        };
      },
    });
    client.worker.start();
    client.worker.pause();
    const attemptId = client._attemptGeneration;
    const out = await client._runBarrier(attemptId, new AbortController().signal);
    assert.equal(out.reason, 'backlog_exceeded');
    assert.equal(out.backoffKind, 'blocked');
    assert.equal(client._blockedReason, 'backlog_exceeded');
    assert.equal(timelineCalls, 1);
    // Second recovery while blocked must not call timeline again
    const out2 = await client._fetchRecoveryPhase();
    assert.equal(out2.reason, 'backlog_exceeded');
    assert.equal(timelineCalls, 1);
    // Simulate process restart / config bump
    client._clearBlockedForTest();
    const out3 = await client._fetchRecoveryPhase();
    assert.equal(timelineCalls, 2);
    assert.equal(out3.ok, false); // still backlog with same mock
    client.worker.stop();
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('only current attempt can clear needRecovery via successful barrier', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    // no prior state → successful barrier skips recovery and may go live
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [], meta: {} }) }),
    });
    client.worker.start();
    client.worker.pause();
    const id0 = client._attemptGeneration;
    // Stale barrier after invalidate
    client._requestReconnect('test');
    const stale = await client._runBarrier(id0, new AbortController().signal);
    assert.equal(stale.ok, false);
    assert.equal(client._needRecovery, true);
    assert.equal(client._liveMode, false);
    assert.equal(client.worker.paused, true);

    // Current attempt (generation after invalidate) succeeds and alone may go live
    const id1 = client._attemptGeneration;
    const fresh = await client._runBarrier(id1, new AbortController().signal);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.complete, true);
    assert.equal(client._needRecovery, false);
    assert.equal(client._liveMode, true);
    assert.equal(client.worker.paused, false);
    client.worker.stop();
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('flapping stream 200 closes produce progressive reconnect delays', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    let streamOpens = 0;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      // Cap sleep so tests stay fast but do not tight-loop the event loop.
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30)));
      },
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          streamOpens += 1;
          return { ok: true, body: emptyStreamBody(1) };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    const started = client.start();
    assert.equal(started.started, true);
    for (let i = 0; i < 80 && streamOpens < 3; i += 1) {
      await sleep(25);
    }
    await client.stop();
    const networkDelays = client._getReconnectDelays().filter((d) => d.kind === 'network');
    assert.ok(streamOpens >= 2, `expected >=2 stream opens, got ${streamOpens}`);
    assert.ok(networkDelays.length >= 1, 'expected reconnect delay records');
    if (networkDelays.length >= 2) {
      assert.ok(
        networkDelays[1].wait >= networkDelays[0].wait,
        `expected progressive backoff, got ${networkDelays.map((d) => d.wait)}`,
      );
    }
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stable stream activity resets network attempt counter', () => {
  let now = 1_000_000;
  const client = createFortniteStatusStreamClient({
    env: baseEnv(),
    allowDiscordHistory: false,
    sleep: async () => {},
    now: () => now,
  });
  // Force high attempt count then note activity across stable window
  client._setNetworkAttempt(4);
  client._noteStreamActivity();
  assert.equal(client._getNetworkAttempt(), 4);
  now += 31_000;
  client._noteStreamActivity();
  assert.equal(client._getNetworkAttempt(), 0);
});

// ─── Permanent stream errors → blocked auth_or_config ────────────────────────

test('stream HTTP 401 opens once and enters auth_or_config blocked', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let streamCalls = 0;
    let timelineCalls = 0;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          streamCalls += 1;
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            text: async () => 'unauthorized',
          };
        }
        timelineCalls += 1;
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    await sleep(80);
    assert.equal(client._blockedReason, 'auth_or_config');
    assert.equal(client._streamConnectCount, 1);
    assert.equal(streamCalls, 1);
    assert.equal(timelineCalls, 0);
    assert.equal(client._recoveryFetchCount, 0);
    assert.equal(client._liveMode, false);
    assert.equal(client.worker.paused, true);
    assert.equal(client._needRecovery, true);
    const opensAfter = client._streamConnectCount;
    await sleep(50);
    assert.equal(client._streamConnectCount, opensAfter);
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stream HTTP 403 does not start recovery', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    store.remember('1', { messageId: 'm1', latestPostId: '1' });
    let timelineCalls = 0;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
        }
        timelineCalls += 1;
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    await sleep(60);
    assert.equal(client._blockedReason, 'auth_or_config');
    assert.equal(timelineCalls, 0);
    assert.equal(client._recoveryFetchCount, 0);
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stream HTTP 400 keeps worker paused and liveMode false', async () => {
  const cachePath = tempCachePath();
  try {
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return { ok: false, status: 400, headers: { get: () => null }, text: async () => '' };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    await sleep(60);
    assert.equal(client._blockedReason, 'auth_or_config');
    assert.equal(client._liveMode, false);
    assert.equal(client.worker.paused, true);
    await client.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('no new stream connections while blocked; stop wakes promptly', async () => {
  const cachePath = tempCachePath();
  try {
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return { ok: false, status: 401, headers: { get: () => null }, text: async () => '' };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    await sleep(50);
    assert.equal(client._blockedReason, 'auth_or_config');
    const n = client._streamConnectCount;
    await sleep(80);
    assert.equal(client._streamConnectCount, n);
    const t0 = Date.now();
    await client.stop();
    assert.ok(Date.now() - t0 < 2000, 'stop during blocked should finish promptly');
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('new client instance can retry after previous was blocked', async () => {
  const cachePath = tempCachePath();
  try {
    const store = createFortniteStatusSeenStore({ cachePath });
    store.loadFromDisk();
    const bad = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      seenStore: store,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return { ok: false, status: 401, headers: { get: () => null }, text: async () => '' };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    bad.start();
    await sleep(40);
    assert.equal(bad._blockedReason, 'auth_or_config');
    await bad.stop();

    let streamOk = 0;
    const good = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          streamOk += 1;
          return { ok: true, body: emptyStreamBody(5) };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    good.start();
    await sleep(40);
    assert.equal(good._blockedReason, null);
    assert.ok(streamOk >= 1);
    await good.stop();
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stream HTTP 429 uses rate_limit and x-rate-limit-reset', async () => {
  const cachePath = tempCachePath();
  try {
    const reset = String(Math.floor(Date.now() / 1000) + 90);
    let sawRateLimit = false;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      // Cap delay; never await stop() from inside sleep (deadlocks runLoop).
      sleep: async (ms) => {
        sawRateLimit = true;
        await sleep(Math.min(Number(ms) || 0, 20));
      },
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return {
            ok: false,
            status: 429,
            headers: {
              get: (h) => (String(h).toLowerCase() === 'x-rate-limit-reset' ? reset : null),
            },
            text: async () => '',
          };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    for (let i = 0; i < 40 && !sawRateLimit; i += 1) await sleep(15);
    await client.stop();
    const rl = client._getReconnectDelays().filter((d) => d.kind === 'rate_limit');
    assert.ok(rl.length >= 1, 'expected rate_limit reconnect delay');
    assert.ok(rl[0].wait >= 60_000);
    assert.equal(rl[0].rateLimitReset, reset);
    assert.equal(client._blockedReason, null);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});

test('stream HTTP 503 uses http backoff not permanent block', async () => {
  const cachePath = tempCachePath();
  try {
    let sawHttp = false;
    const client = createFortniteStatusStreamClient({
      env: baseEnv({ FORTNITE_STATUS_CACHE_PATH: cachePath }),
      allowDiscordHistory: false,
      sleep: async (ms) => {
        sawHttp = true;
        await sleep(Math.min(Number(ms) || 0, 20));
      },
      fetchImpl: async (url) => {
        if (String(url).includes('stream')) {
          return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
        }
        return { ok: true, json: async () => ({ data: [], meta: {} }) };
      },
    });
    client.start();
    for (let i = 0; i < 40 && !sawHttp; i += 1) await sleep(15);
    await client.stop();
    assert.equal(client._blockedReason, null);
    const httpDelays = client._getReconnectDelays().filter((d) => d.kind === 'http');
    assert.ok(httpDelays.length >= 1);
    assert.equal(httpDelays[0].status, 503);
  } finally {
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
  }
});
