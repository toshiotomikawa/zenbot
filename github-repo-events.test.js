/**
 * Offline tests for the GitHub repository webhook → task topic completion.
 * No live Discord, no live GitHub, no outbound network. The only sockets
 * opened are loopback HTTP servers used to exercise the Express wiring,
 * exactly like the other offline webhook tests.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createRateLimiter } from './discord-feed-utils.js';
import {
  computeGithubSignature,
  createGithubEventsProcessor,
  GITHUB_EVENTS_ROUTE,
  isValidDeliveryId,
  normalizeGithubEvent,
  parseRepoAllowlist,
  readGithubEventsConfig,
  registerGithubEventsWebhook,
  verifyGithubSignature,
} from './github-repo-events.js';

const SECRET = 'test-github-webhook-secret-32chars!';
const REPO = 'toshiotomikawa/2a3a';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const OTHER_DELIVERY = '0f5c1a2b-3d4e-4f60-8a91-b2c3d4e5f607';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function repository(fullName = REPO) {
  const [owner, name] = fullName.split('/');
  return { full_name: fullName, name, owner: { login: owner }, default_branch: 'master' };
}

function pullRequestPayload({
  action = 'closed',
  number = 12,
  title = 'Adiciona página de planos',
  merged = true,
  login = 'toshiotomikawa',
  repo = REPO,
  headRef = 'feature/planos',
  baseRef = 'master',
} = {}) {
  return {
    action,
    number,
    pull_request: {
      number,
      title,
      html_url: `https://github.com/${repo}/pull/${number}`,
      merged,
      draft: false,
      created_at: '2026-08-20T10:00:00Z',
      updated_at: '2026-08-20T11:00:00Z',
      closed_at: action === 'closed' ? '2026-08-20T11:00:00Z' : null,
      merged_at: merged ? '2026-08-20T11:00:00Z' : null,
      head: { ref: headRef },
      base: { ref: baseRef },
      user: { login },
    },
    repository: repository(repo),
    sender: { login },
  };
}

function issuesPayload({
  action = 'opened',
  number = 7,
  title = 'Corrigir link de gabaritos',
  login = 'toshiotomikawa',
  repo = REPO,
} = {}) {
  return {
    action,
    issue: {
      number,
      title,
      html_url: `https://github.com/${repo}/issues/${number}`,
      created_at: '2026-08-20T09:00:00Z',
      updated_at: '2026-08-20T09:30:00Z',
      closed_at: action === 'closed' ? '2026-08-20T09:30:00Z' : null,
      user: { login },
    },
    repository: repository(repo),
    sender: { login },
  };
}

function pingPayload({ repo = REPO } = {}) {
  return {
    zen: 'Non-blocking is better than blocking.',
    hook_id: 1,
    hook: { type: 'Repository', events: ['pull_request'] },
    repository: repository(repo),
    sender: { login: 'toshiotomikawa' },
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

function fakeDiscord() {
  const calls = [];
  const posts = [];
  const discordRequest = async (endpoint, options = {}) => {
    calls.push({ endpoint, method: options.method ?? 'GET' });
    assert.fail('the webhook must not access the retired channel');
  };
  return { discordRequest, calls, posts };
}

function makeProcessor({ discord = fakeDiscord(), config = {}, taskCompletion = { handleMerge: async () => {} } } = {}) {
  const processor = createGithubEventsProcessor({
    env: {},
    discordRequest: discord.discordRequest,
    taskCompletion,
    configOverride: {
      enabled: true, valid: true, reason: 'ok', hmacSecret: SECRET,
      allowlist: [REPO], ...config,
    },
  });
  return { processor, discord };
}

async function withServer(register, fn) {
  const app = express();
  const result = register(app);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(port, result);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postHook(port, {
  event = 'pull_request',
  delivery = DELIVERY,
  body,
  raw,
  secret = SECRET,
  signature,
  contentType = 'application/json',
  omitSignature = false,
} = {}) {
  const payload = raw ?? JSON.stringify(body ?? {});
  const headers = { 'Content-Type': contentType };
  if (event !== null) headers['X-GitHub-Event'] = event;
  if (delivery !== null) headers['X-GitHub-Delivery'] = delivery;
  if (!omitSignature) {
    headers['X-Hub-Signature-256'] = signature
      ?? computeGithubSignature(Buffer.from(payload, 'utf8'), secret);
  }
  const res = await fetch(`http://127.0.0.1:${port}${GITHUB_EVENTS_ROUTE}`, {
    method: 'POST',
    headers,
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

// ─── Config ──────────────────────────────────────────────────────────────────

test('config is fail-closed: only GITHUB_EVENTS_ENABLED=1 enables the surface', () => {
  const base = {
    GITHUB_EVENTS_HMAC_SECRET: SECRET,
    GITHUB_EVENTS_REPO_ALLOWLIST: REPO,
  };
  assert.equal(readGithubEventsConfig({ ...base, GITHUB_EVENTS_ENABLED: '1' }).valid, true);
  for (const value of ['0', 'true', 'TRUE', 'yes', '', undefined, ' 1']) {
    const config = readGithubEventsConfig({ ...base, GITHUB_EVENTS_ENABLED: value });
    assert.equal(config.valid, false, `enabled=${JSON.stringify(value)} must not enable`);
    assert.equal(config.reason, 'disabled');
  }
});

test('config refuses missing, weak or malformed values', () => {
  const full = {
    GITHUB_EVENTS_ENABLED: '1',
    GITHUB_EVENTS_HMAC_SECRET: SECRET,
    GITHUB_EVENTS_REPO_ALLOWLIST: REPO,
  };
  assert.equal(readGithubEventsConfig({ ...full, GITHUB_EVENTS_HMAC_SECRET: '' }).reason, 'missing_config');
  assert.equal(readGithubEventsConfig({ ...full, GITHUB_EVENTS_REPO_ALLOWLIST: '' }).reason, 'missing_config');
  assert.equal(readGithubEventsConfig({ ...full, GITHUB_EVENTS_HMAC_SECRET: 'short' }).reason, 'weak_hmac_secret');
  assert.equal(readGithubEventsConfig({ ...full, GITHUB_EVENTS_REPO_ALLOWLIST: 'not-a-repo' }).reason, 'invalid_repo_allowlist');
});

test('config never leaks the secret through the log-safe view', () => {
  const config = readGithubEventsConfig({
    GITHUB_EVENTS_ENABLED: '1',
    GITHUB_EVENTS_HMAC_SECRET: SECRET,
    GITHUB_EVENTS_REPO_ALLOWLIST: REPO,
  });
  assert.equal(JSON.stringify(config.logSafe).includes(SECRET), false);
  assert.equal(config.logSafe.hmacSecret, undefined);
});

test('parseRepoAllowlist normalizes case and drops malformed entries', () => {
  assert.deepEqual(parseRepoAllowlist(' toshiotomikawa/2A3A , , bad , owner/name '), [REPO, 'owner/name']);
  assert.deepEqual(parseRepoAllowlist(undefined), []);
});

// ─── Signature ───────────────────────────────────────────────────────────────

test('verifyGithubSignature accepts a correct signature over the exact bytes', () => {
  const raw = Buffer.from('{"action":"opened"}', 'utf8');
  const good = computeGithubSignature(raw, SECRET);
  assert.match(good, /^sha256=[0-9a-f]{64}$/);
  assert.deepEqual(verifyGithubSignature(raw, good, SECRET), { ok: true });
});

test('verifyGithubSignature rejects missing, malformed and wrong signatures', () => {
  const raw = Buffer.from('{"action":"opened"}', 'utf8');
  assert.deepEqual(verifyGithubSignature(raw, undefined, SECRET), { ok: false, reason: 'missing_signature' });
  assert.deepEqual(verifyGithubSignature(raw, '', SECRET), { ok: false, reason: 'missing_signature' });
  assert.deepEqual(verifyGithubSignature(raw, 'sha1=deadbeef', SECRET), { ok: false, reason: 'malformed_signature' });
  assert.deepEqual(verifyGithubSignature(raw, 'sha256=nothex', SECRET), { ok: false, reason: 'malformed_signature' });
  assert.deepEqual(verifyGithubSignature(raw, `sha256=${'a'.repeat(63)}`, SECRET), { ok: false, reason: 'malformed_signature' });
  assert.deepEqual(verifyGithubSignature(raw, `sha256=${'a'.repeat(64)}`, SECRET), { ok: false, reason: 'invalid_signature' });
  assert.deepEqual(
    verifyGithubSignature(raw, computeGithubSignature(raw, 'another-secret-value-32-chars!!'), SECRET),
    { ok: false, reason: 'invalid_signature' },
  );
  assert.deepEqual(verifyGithubSignature(raw, computeGithubSignature(raw, SECRET), ''), { ok: false, reason: 'not_configured' });
});

test('a one-byte body change invalidates the signature', () => {
  const raw = Buffer.from('{"action":"opened"}', 'utf8');
  const good = computeGithubSignature(raw, SECRET);
  const tampered = Buffer.from('{"action":"reopened"}', 'utf8');
  assert.equal(verifyGithubSignature(tampered, good, SECRET).ok, false);
});

test('the hex half of the signature is case-insensitive', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  const good = computeGithubSignature(raw, SECRET);
  const upperHex = `sha256=${good.slice('sha256='.length).toUpperCase()}`;
  assert.equal(verifyGithubSignature(raw, upperHex, SECRET).ok, true);
});

// ─── Delivery id ────────────────────────────────────────────────────

test('delivery id must be a GUID', () => {
  assert.equal(isValidDeliveryId(DELIVERY), true);
  assert.equal(isValidDeliveryId(DELIVERY.toUpperCase()), true);
  for (const bad of [undefined, null, '', 'not-a-guid', DELIVERY.slice(0, -1), `${DELIVERY}x`, 42, `${DELIVERY} `]) {
    assert.equal(isValidDeliveryId(bad), false, `${String(bad)} must be rejected`);
  }
});

// ─── Dispatch and processing ─────────────────────────────────────────────────

function normalize(eventName, body, deliveryId = DELIVERY) {
  return normalizeGithubEvent({ eventName, deliveryId, body, allowlist: [REPO] });
}

test('only a merged, closed PR reaches task completion', () => {
  assert.equal(normalize('pull_request', pullRequestPayload()).action, 'complete');
  for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
    assert.equal(normalize('pull_request', pullRequestPayload({ action })).action, 'ignored');
  }
  assert.equal(normalize('pull_request', pullRequestPayload({ merged: false })).action, 'ignored');
  for (const event of ['issues', 'release', 'workflow_run', 'push', 'issue_comment']) {
    assert.equal(normalize(event, { repository: repository() }).action, 'ignored');
  }
});

test('dispatch validates repository, GUID, event and merged PR payload', () => {
  assert.equal(normalize('ping', pingPayload()).action, 'ping');
  assert.equal(normalize('ping', pingPayload({ repo: 'other/repo' })).status, 403);
  assert.equal(normalize('ping', {}).status, 403);
  assert.equal(normalize('pull_request', pullRequestPayload(), 'invalid').status, 400);
  assert.equal(normalize('', pullRequestPayload()).status, 400);
  assert.equal(normalize('pull_request', null).status, 400);
  assert.equal(normalize('pull_request', []).status, 400);
  assert.equal(normalize('pull_request', { repository: repository(), action: 'closed' }).status, 400);
  const body = pullRequestPayload(); delete body.pull_request.number;
  assert.equal(normalize('pull_request', body).status, 400);
  assert.equal(normalize('pull_request', pullRequestPayload({ number: -1 })).status, 400);
});

test('merged PR reaches completion without any feed POST or history recovery', async () => {
  const received = [];
  const { processor, discord } = makeProcessor({ taskCompletion: {
    handleMerge: async body => { received.push(body); },
  } });
  const body = pullRequestPayload();
  body.pull_request.body = 'Conclui: https://discord.com/channels/11111111111111111/33333333333333333';
  const result = await processor.processDelivery({ eventName: 'pull_request', deliveryId: DELIVERY, body });
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'processed');
  assert.deepEqual(received, [body]);
  assert.deepEqual(discord.calls, []);
});

test('ping and retired feed events acknowledge with 200 and no Discord calls', async () => {
  const { processor, discord } = makeProcessor({ taskCompletion: {
    handleMerge: () => assert.fail('unexpected completion'),
  } });
  for (const eventName of ['ping', 'issues', 'release', 'workflow_run', 'push']) {
    const result = await processor.processDelivery({ eventName, deliveryId: DELIVERY,
      body: { repository: repository(), action: 'completed' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.action, eventName === 'ping' ? 'ping' : 'ignored');
  }
  assert.deepEqual(discord.calls, []);
});

test('concurrent identical deliveries share completion work', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { processor } = makeProcessor({ taskCompletion: {
    handleMerge: async () => { calls++; await gate; },
  } });
  const delivery = { eventName: 'pull_request', deliveryId: DELIVERY, body: pullRequestPayload() };
  const first = processor.processDelivery(delivery);
  const second = processor.processDelivery(delivery);
  release();
  assert.ok((await Promise.all([first, second])).every(result => result.status === 200));
  assert.equal(calls, 1);
});

test('completion failure returns 502 and redelivery can retry', async () => {
  let calls = 0;
  const { processor } = makeProcessor({ taskCompletion: {
    handleMerge: async () => { if (++calls === 1) throw new Error('offline failure'); },
  } });
  const delivery = { eventName: 'pull_request', deliveryId: DELIVERY, body: pullRequestPayload() };
  assert.equal((await processor.processDelivery(delivery)).body.error, 'task_completion_failed');
  assert.equal((await processor.processDelivery(delivery)).status, 200);
  assert.equal(calls, 2);
});

test('disabled task WRITE gate acknowledges merge without Discord calls', async () => {
  const discord = fakeDiscord();
  const processor = createGithubEventsProcessor({ env: {}, discordRequest: discord.discordRequest,
    configOverride: { valid: true, allowlist: [REPO] } });
  const result = await processor.processDelivery({ eventName: 'pull_request', deliveryId: DELIVERY,
    body: pullRequestPayload() });
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'ignored');
  assert.deepEqual(discord.calls, []);
});

// ─── Express wiring ──────────────────────────────────────────────────────────

function registerWith(app, { discord = fakeDiscord(), config = {}, rateLimiter } = {}) {
  const { processor } = makeProcessor({ discord, config });
  const result = registerGithubEventsWebhook(app, { processor, rateLimiter });
  return { ...result, discord, processor };
}

test('a signed merged PR is accepted without a feed post', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, { body: pullRequestPayload() });
    assert.equal(res.status, 200);
    assert.equal(res.json.action, 'processed');
    assert.equal(discord.posts.length, 0);
  });
});

test('the route rejects a missing, malformed or wrong signature without touching Discord', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const body = pullRequestPayload();
    const missing = await postHook(port, { body, omitSignature: true });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, 'missing_signature');

    const malformed = await postHook(port, { body, signature: 'sha1=abc' });
    assert.equal(malformed.status, 401);
    assert.equal(malformed.json.error, 'malformed_signature');

    const wrong = await postHook(port, { body, secret: 'a-completely-different-secret!!!' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'invalid_signature');

    assert.deepEqual(discord.calls, []);
  });
});

test('the signature is verified over the raw bytes, not a re-serialization', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const pretty = JSON.stringify(pullRequestPayload(), null, 2);
    const compact = JSON.stringify(JSON.parse(pretty));
    assert.notEqual(pretty, compact, 'fixture must differ byte-wise from its re-serialization');

    const okRes = await postHook(port, { raw: pretty });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.action, 'processed');

    // Same signature, semantically identical body, different bytes → rejected.
    const signature = computeGithubSignature(Buffer.from(pretty, 'utf8'), SECRET);
    const tampered = await postHook(port, { raw: compact, signature, delivery: OTHER_DELIVERY });
    assert.equal(tampered.status, 401);
    assert.equal(discord.posts.length, 0);
  });
});

test('the route refuses a body that is not application/json', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, { body: pullRequestPayload(), contentType: 'text/plain' });
    assert.equal(res.status, 415);
    assert.deepEqual(discord.calls, []);
  });
});

test('the route refuses invalid JSON after a valid signature', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, { raw: '{"action": ' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_json');
    assert.deepEqual(discord.calls, []);
  });
});

test('the route refuses a payload larger than 1 MiB before any signature work', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const raw = `{"filler":"${'x'.repeat(1024 * 1024 + 64)}"}`;
    const res = await postHook(port, { raw });
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'payload_too_large');
    assert.deepEqual(discord.calls, []);
  });
});

test('unauthenticated requests never consume the rate limiter budget', async () => {
  const discord = fakeDiscord();
  const rateLimiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 2, maxGlobal: 100 });
  await withServer((app) => registerWith(app, { discord, rateLimiter }), async (port) => {
    const body = pullRequestPayload();
    for (let i = 0; i < 5; i += 1) {
      const res = await postHook(port, { body, omitSignature: true });
      assert.equal(res.status, 401, `unsigned request #${i + 1} must stay 401, never 429`);
    }
    const wrongSecret = await postHook(port, { body, secret: 'a-completely-different-secret!!!' });
    assert.equal(wrongSecret.status, 401);
    assert.deepEqual(discord.calls, []);

    // A real delivery still gets through after all that unauthenticated noise.
    const real = await postHook(port, { body });
    assert.equal(real.status, 200);
    assert.equal(real.json.action, 'processed');
    assert.equal(discord.posts.length, 0);
  });
});

test('authenticated deliveries are still rate-limited once over the budget', async () => {
  const discord = fakeDiscord();
  const rateLimiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 2, maxGlobal: 100 });
  await withServer((app) => registerWith(app, { discord, rateLimiter }), async (port) => {
    const deliveries = [DELIVERY, OTHER_DELIVERY, '11111111-2222-4333-8444-555555555555'];
    const statuses = [];
    for (const delivery of deliveries) {
      const res = await postHook(port, { body: pullRequestPayload(), delivery });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(discord.posts.length, 0);
  });
});

test('the signature is verified before JSON parsing, not after', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    // Unparseable body plus no signature: the signature verdict must win, which
    // is only possible if the HMAC ran over the raw bytes before any parsing.
    const unsigned = await postHook(port, { raw: '{"action": ', omitSignature: true });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.json.error, 'missing_signature');

    // Same unparseable bytes, correct signature over exactly those bytes.
    const signed = await postHook(port, { raw: '{"action": ' });
    assert.equal(signed.status, 400);
    assert.equal(signed.json.error, 'invalid_json');
    assert.deepEqual(discord.calls, []);
  });
});

test('a missing or malformed delivery header is a 400 with no Discord traffic', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const body = pullRequestPayload();
    const missing = await postHook(port, { body, delivery: null });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'invalid_delivery_id');
    const malformed = await postHook(port, { body, delivery: 'nope' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(discord.calls, []);
  });
});

test('the route answers ping without publishing', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, { event: 'ping', body: pingPayload() });
    assert.equal(res.status, 200);
    assert.equal(res.json.action, 'ping');
    assert.deepEqual(discord.calls, []);
  });
});

test('the route ignores non-published events with 200 and no Discord traffic', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const push = await postHook(port, {
      event: 'push', body: { repository: repository(), ref: 'refs/heads/master' },
    });
    assert.equal(push.status, 200);
    assert.equal(push.json.action, 'ignored');
    const sync = await postHook(port, {
      body: pullRequestPayload({ action: 'synchronize' }), delivery: OTHER_DELIVERY,
    });
    assert.equal(sync.json.action, 'ignored');
    assert.deepEqual(discord.calls, []);
  });
});

test('the route refuses a ping from a repository outside the allowlist', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, {
      event: 'ping', body: pingPayload({ repo: 'someoneelse/evil' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'repo_not_allowlisted');
    assert.deepEqual(discord.calls, []);
  });
});

test('the route rejects a foreign repository', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await postHook(port, { body: pullRequestPayload({ repo: 'someoneelse/evil' }) });
    assert.equal(res.status, 403);
    assert.deepEqual(discord.calls, []);
  });
});

test('a disabled or misconfigured surface registers no route at all', async () => {
  const discord = fakeDiscord();
  const configs = [
    { enabled: false, valid: false, reason: 'disabled' },
    { valid: false, reason: 'missing_config' },
  ];
  for (const config of configs) {
    await withServer((app) => {
      const { processor } = makeProcessor({ discord, config });
      return registerGithubEventsWebhook(app, { processor });
    }, async (port, result) => {
      assert.equal(result.registered, false);
      assert.equal(typeof result.reason, 'string');
      const res = await postHook(port, { body: pullRequestPayload() });
      assert.equal(res.status, 404);
    });
  }
  assert.deepEqual(discord.calls, []);
});

test('registering the surface does not install a global JSON parser', async () => {
  const discord = fakeDiscord();
  await withServer((app) => {
    const registered = registerWith(app, { discord });
    // A sibling route must still receive an unparsed body, like /interactions.
    app.post('/probe', (req, res) => {
      res.json({ bodyType: req.body === undefined ? 'undefined' : typeof req.body });
    });
    return registered;
  }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const json = await res.json();
    assert.equal(json.bodyType, 'undefined', 'no global parser may consume sibling route bodies');
  });
});

test('the surface answers only its own path', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/other-surface/whatever`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404, 'the GitHub surface must not answer for other webhook paths');
  });
});

test('retired release feed acknowledges repeated deliveries without posting', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const body = { repository: repository(), action: 'published' };
    const first = await postHook(port, { event: 'release', body });
    const second = await postHook(port, { event: 'release', body });
    assert.equal(first.json.action, 'ignored');
    assert.equal(second.json.action, 'ignored');
    assert.equal(discord.posts.length, 0);
  });
});

test('responses never echo the secret, the signature or the payload', async () => {
  const discord = fakeDiscord();
  await withServer((app) => registerWith(app, { discord }), async (port) => {
    const body = issuesPayload({ title: 'segredo-no-titulo' });
    const ok = await postHook(port, { event: 'issues', body });
    const bad = await postHook(port, {
      event: 'issues', body, secret: 'wrong-secret-value-that-is-long',
    });
    for (const res of [ok, bad]) {
      assert.equal(res.text.includes(SECRET), false);
      assert.equal(res.text.includes('sha256='), false);
      assert.equal(res.text.includes('segredo-no-titulo'), false);
    }
  });
});

/** Deep scan for a literal secret anywhere reachable from a returned value. */
function reachesSecret(value, secret, seen = new Set()) {
  if (typeof value === 'string') return value.includes(secret);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    let inner;
    try { inner = value[key]; } catch { continue; }
    if (reachesSecret(inner, secret, seen)) return true;
  }
  return false;
}

test('the public register function never hands back the HMAC secret', () => {
  const discord = fakeDiscord();

  const { processor } = makeProcessor({ discord });
  const registered = registerGithubEventsWebhook(express(), { processor });
  assert.equal(registered.registered, true);
  assert.equal(registered.config, undefined, 'the config object must not be returned');
  assert.equal(registered.processor, undefined, 'the processor reaches config.hmacSecret');
  assert.equal(registered.rateLimiter, undefined);
  assert.equal(reachesSecret(registered, SECRET), false, 'GITHUB_EVENTS_HMAC_SECRET leaked');
  assert.equal(JSON.stringify(registered).includes(SECRET), false);

  const off = makeProcessor({ discord, config: { valid: false, reason: 'disabled' } });
  const unregistered = registerGithubEventsWebhook(express(), { processor: off.processor });
  assert.equal(unregistered.registered, false);
  assert.equal(unregistered.config, undefined);
  assert.equal(reachesSecret(unregistered, SECRET), false, 'GITHUB_EVENTS_HMAC_SECRET leaked');

  // The processor itself still holds the secret internally; that is the point
  // of the assertions above, so guard the sentinel against becoming vacuous.
  assert.equal(reachesSecret(processor.config, SECRET), true);
  assert.deepEqual(discord.calls, []);
});

test('computeGithubSignature matches an independently computed HMAC', () => {
  const raw = Buffer.from('{"probe":true}', 'utf8');
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  assert.equal(computeGithubSignature(raw, SECRET), expected);
});
