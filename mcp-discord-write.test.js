import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleTaskThreadCreate, handleTaskThreadUpdate } from './task-thread-state.js';
import test from 'node:test';
import {
  DIRECTOR_READ_MARK_LIMIT,
  DIRECTOR_READ_MARK_PAUSE_MS,
  buildIssueMarker,
  buildIssueThreadName,
  createDiscordWriteService,
  markDirectorPingsReadWith,
  readDiscordWriteConfig,
} from './mcp-discord-write.js';
import { readDiscordReadConfig } from './mcp-discord-read.js';

const GUILD = '11111111111111111';
const PARENT = '22222222222222222';
const THREAD = '33333333333333333';
const MESSAGE = '44444444444444444';
const BOT = '55555555555555555';
const OPEN_TAG = '66666666666666666';
const DONE_TAG = '77777777777777777';
const DEFAULT_TAGS = [
  { id: OPEN_TAG, name: 'Aberto' },
  { id: DONE_TAG, name: 'Concluído' },
];
const ENV = {
  MCP_DISCORD_READ_ENABLED: '1',
  MCP_DISCORD_GUILD_IDS: GUILD,
  MCP_DISCORD_PARENT_CHANNEL_IDS: PARENT,
  MCP_DISCORD_WRITE_ENABLED: '1',
  MCP_DISCORD_WRITE_GUILD_IDS: GUILD,
  MCP_DISCORD_WRITE_PARENT_CHANNEL_IDS: PARENT,
  MCP_DISCORD_WRITE_REPOS: 'a/b',
  DISCORD_TOKEN: 'sentinel-discord-token',
};

function response(body) { return { json: async () => body }; }
function found(threadId = THREAD) {
  return {
    status: 'found', repo: 'a/b', issue_number: 42,
    thread: {
      thread_id: threadId, name: '2a3a-42-example', verified: true,
      verification: 'verified', archived: false,
    },
  };
}

function harness({ resolutions = [{ status: 'not_found', repo: 'a/b', issue_number: 42, candidates: [] }], parent = {}, channel = {}, create = {}, post = {} } = {}) {
  const calls = [];
  let resolutionIndex = 0;
  const readService = {
    async findIssueThread() {
      const value = resolutions[Math.min(resolutionIndex, resolutions.length - 1)];
      resolutionIndex += 1;
      return value;
    },
  };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, options });
    assert.ok(['GET', 'POST'].includes(options.method));
    assert.equal(options.sensitiveErrors, true);
    if (endpoint === `channels/${PARENT}` && options.method === 'GET') {
      return response({ id: PARENT, guild_id: GUILD, type: 15, flags: 0, available_tags: DEFAULT_TAGS, ...parent });
    }
    if (endpoint === 'users/@me' && options.method === 'GET') return response({ id: BOT, bot: true });
    if (endpoint === `channels/${THREAD}` && options.method === 'GET') {
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        thread_metadata: { archived: false, locked: false }, ...channel,
      });
    }
    if (endpoint === `channels/${PARENT}/threads` && options.method === 'POST') {
      const body = options.body;
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, name: body.name,
        applied_tags: body.applied_tags,
        thread_metadata: { archived: false },
        message: { id: THREAD, channel_id: THREAD, content: body.message.content, author: { id: BOT } },
        ...create,
      });
    }
    if (endpoint === `channels/${THREAD}/messages` && options.method === 'POST') {
      return response({ id: MESSAGE, channel_id: THREAD, content: options.body.content, nonce: options.body.nonce, ...post });
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const logger = { entries: [], info(label, fields) { this.entries.push({ label, fields }); } };
  const config = readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV));
  return { service: createDiscordWriteService({ config, readService, request, logger }), calls, logger };
}

test('Discord WRITE config is separate, repo-bound, subset-bound, and single-target', () => {
  const read = readDiscordReadConfig(ENV);
  const valid = readDiscordWriteConfig(ENV, read);
  assert.equal(valid.valid, true);
  assert.deepEqual([...valid.repos], ['a/b']);
  assert.equal(readDiscordWriteConfig({ ...ENV, MCP_DISCORD_WRITE_ENABLED: '0' }, read).valid, false);
  assert.equal(readDiscordWriteConfig({ ...ENV, MCP_DISCORD_WRITE_REPOS: '../x' }, read).reason, 'invalid_config');
  assert.equal(
    readDiscordWriteConfig({ ...ENV, MCP_DISCORD_WRITE_REPOS: 'a/b,c/d' }, read).reason,
    'single_repo_required',
  );
  assert.equal(readDiscordWriteConfig({ ...ENV, MCP_DISCORD_WRITE_REPOS: 'A/B,a/b' }, read).valid, true);
  assert.equal(
    readDiscordWriteConfig({ ...ENV, MCP_DISCORD_WRITE_PARENT_CHANNEL_IDS: '99999999999999999' }, read).reason,
    'write_not_subset_of_read',
  );
  const twoGuilds = `${GUILD},99999999999999999`;
  const readTwo = readDiscordReadConfig({ ...ENV, MCP_DISCORD_GUILD_IDS: twoGuilds });
  assert.equal(
    readDiscordWriteConfig({ ...ENV, MCP_DISCORD_GUILD_IDS: twoGuilds, MCP_DISCORD_WRITE_GUILD_IDS: twoGuilds }, readTwo).reason,
    'single_target_required',
  );
});

test('thread naming and marker are deterministic and sanitized', () => {
  assert.equal(buildIssueThreadName(42, 'Olá, Mundo / @everyone!'), '2a3a-42-ola-mundo-everyone');
  assert.equal(
    buildIssueMarker('Toshi/ZenBot', 42),
    'BOTELIA_ISSUE_THREAD_V1 {"repo":"toshi/zenbot","issue_number":42}',
  );
  assert.ok(buildIssueThreadName(42, 'x'.repeat(200)).length <= 100);
});

test('ensure creates exactly one forum post tagged Aberto with trusted marker and no mentions', async () => {
  const notFound = { status: 'not_found', repo: 'a/b', issue_number: 42, candidates: [] };
  const h = harness({ resolutions: [notFound, notFound] });
  const result = await h.service.ensureIssueThread({ repo: 'A/B', issue_number: 42, title: 'Implement Phase 2' });
  assert.equal(result.status, 'found');
  assert.equal(result.created, true);
  assert.equal(result.thread.thread_id, THREAD);
  assert.equal(result.untrusted_data, true);
  const writes = h.calls.filter((call) => call.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, `channels/${PARENT}/threads`);
  assert.equal(writes[0].options.body.name, '2a3a-42-implement-phase-2');
  assert.deepEqual(writes[0].options.body.applied_tags, [OPEN_TAG]);
  assert.deepEqual(writes[0].options.body.message.allowed_mentions, { parse: [] });
  assert.match(writes[0].options.body.message.content, /^BOTELIA_ISSUE_THREAD_V1 /);
  assert.match(writes[0].options.body.message.content, /GitHub Issue: https:\/\/github.com\/a\/b\/issues\/42$/);
});

test('ensure returns an existing verified writable thread without creating or retagging', async () => {
  const h = harness({ resolutions: [found()] });
  const result = await h.service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Anything' });
  assert.equal(result.status, 'found');
  assert.equal(result.created, false);
  assert.equal(result.untrusted_data, true);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
  assert.ok(h.calls.some((call) => call.endpoint === `channels/${THREAD}`));
  assert.ok(!h.calls.some((call) => call.endpoint === `channels/${PARENT}`));
});

test('ensure and post reject valid but non-allowlisted repos before Discord access', async () => {
  const h = harness();
  const ensure = await h.service.ensureIssueThread({ repo: 'other/repo', issue_number: 42, title: 'Issue' });
  assert.deepEqual([ensure.status, ensure.reason], ['blocked', 'repo_not_allowlisted']);
  const post = await h.service.postIssueMessage({
    repo: 'other/repo', issue_number: 42, content: 'x', operation_id: 'wrong-repo-1',
  });
  assert.deepEqual([post.status, post.reason], ['blocked', 'repo_not_allowlisted']);
  assert.equal(h.calls.length, 0);
});

test('ensure fails closed for unverified or ambiguous candidates', async () => {
  for (const status of ['unverified', 'ambiguous']) {
    const h = harness({ resolutions: [{ status, repo: 'a/b', issue_number: 42, candidates: [{ thread_id: THREAD }] }] });
    const result = await h.service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Issue' });
    assert.equal(result.status, 'blocked');
    assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
  }
});

test('ensure resolves the exact Aberto forum tag even when tags are required', async () => {
  const notFound = { status: 'not_found', repo: 'a/b', issue_number: 42, candidates: [] };
  const h = harness({ resolutions: [notFound, notFound], parent: { flags: 16 } });
  const result = await h.service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Issue' });
  assert.equal(result.status, 'found');
  const write = h.calls.find((call) => call.endpoint === `channels/${PARENT}/threads`);
  assert.deepEqual(write.options.body.applied_tags, [OPEN_TAG]);
});

test('ensure fails closed when the exact Aberto tag is missing, ambiguous, or malformed', async () => {
  const notFound = { status: 'not_found', repo: 'a/b', issue_number: 42, candidates: [] };
  const cases = [
    [{ available_tags: [{ id: DONE_TAG, name: 'Concluído' }] }, 'open_tag_not_found'],
    [{ available_tags: [{ id: OPEN_TAG, name: 'Aberto' }, { id: DONE_TAG, name: 'Aberto' }] }, 'open_tag_ambiguous'],
    [{ available_tags: [{ id: 'not-a-snowflake', name: 'Aberto' }] }, 'invalid_open_tag'],
  ];
  for (const [parent, reason] of cases) {
    const h = harness({ resolutions: [notFound], parent });
    const result = await h.service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Issue' });
    assert.deepEqual([result.status, result.reason], ['blocked', reason]);
    assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
  }
});

test('process-local issue lock prevents duplicate concurrent creation', async () => {
  let created = false;
  let creates = 0;
  const calls = [];
  const readService = {
    async findIssueThread() {
      return created ? found() : { status: 'not_found', repo: 'a/b', issue_number: 42, candidates: [] };
    },
  };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, options });
    if (endpoint === `channels/${PARENT}` && options.method === 'GET') {
      return response({ id: PARENT, guild_id: GUILD, type: 15, flags: 0, available_tags: DEFAULT_TAGS });
    }
    if (endpoint === 'users/@me' && options.method === 'GET') return response({ id: BOT, bot: true });
    if (endpoint === `channels/${PARENT}/threads` && options.method === 'POST') {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      created = true;
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, name: options.body.name,
        applied_tags: options.body.applied_tags,
        thread_metadata: { archived: false },
        message: { id: THREAD, content: options.body.message.content, author: { id: BOT } },
      });
    }
    if (endpoint === `channels/${THREAD}` && options.method === 'GET') {
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        thread_metadata: { archived: false, locked: false },
      });
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const config = readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV));
  const service = createDiscordWriteService({ config, readService, request, logger: { info() {} } });
  const [first, second] = await Promise.all([
    service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Issue' }),
    service.ensureIssueThread({ repo: 'a/b', issue_number: 42, title: 'Issue' }),
  ]);
  assert.equal(creates, 1);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
});

test('post resolves verified thread, checks write allowlist, and uses Discord nonce enforcement', async () => {
  const h = harness({ resolutions: [found()] });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'hello @everyone', operation_id: 'op-123',
  });
  assert.equal(result.status, 'posted');
  assert.equal(result.process_replay, false);
  const write = h.calls.find((call) => call.endpoint === `channels/${THREAD}/messages`);
  assert.ok(write);
  assert.equal(write.options.method, 'POST');
  assert.equal(write.options.body.enforce_nonce, true);
  assert.equal(write.options.body.nonce.length, 25);
  assert.deepEqual(write.options.body.allowed_mentions, { parse: [] });
});

test('post can ping exactly one configured user without opening parse', async () => {
  const h = harness({ resolutions: [found()] });
  const userId = '1300000000000000000';
  const result = await h.service.postIssueMessage({
    repo: 'a/b',
    issue_number: 42,
    content: `<@${userId}> hello`,
    operation_id: 'mention-1',
    mention_user_ids: [userId],
  });
  assert.equal(result.status, 'posted');
  const write = h.calls.find((call) => call.endpoint === `channels/${THREAD}/messages`);
  assert.deepEqual(write.options.body.allowed_mentions, { parse: [], users: [userId] });
});

test('post rejects malformed mention_user_ids before Discord write', async () => {
  const h = harness({ resolutions: [found()] });
  const result = await h.service.postIssueMessage({
    repo: 'a/b',
    issue_number: 42,
    content: 'x',
    operation_id: 'mention-bad',
    mention_user_ids: ['not-a-snowflake'],
  });
  assert.equal(result.status, 'invalid_input');
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
});

test('post refuses unresolved, archived, or outside-allowlist threads without POST', async () => {
  const unresolved = harness({ resolutions: [{ status: 'unverified', repo: 'a/b', issue_number: 42 }] });
  assert.equal((await unresolved.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'x', operation_id: 'unresolved-1',
  })).status, 'blocked');
  assert.equal(unresolved.calls.filter((call) => call.options.method === 'POST').length, 0);

  const archived = harness({ resolutions: [found()], channel: { thread_metadata: { archived: true, locked: false } } });
  const archivedResult = await archived.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'x', operation_id: 'archived-1',
  });
  assert.deepEqual([archivedResult.status, archivedResult.reason], ['blocked', 'thread_not_writable']);
  assert.equal(archived.calls.filter((call) => call.options.method === 'POST').length, 0);

  for (const threadMetadata of [undefined, {}, { archived: false }, { archived: false, locked: 'false' }]) {
    const malformed = harness({ resolutions: [found()], channel: { thread_metadata: threadMetadata } });
    const malformedResult = await malformed.service.postIssueMessage({
      repo: 'a/b', issue_number: 42, content: 'x', operation_id: `malformed-${JSON.stringify(threadMetadata)}`,
    });
    assert.deepEqual([malformedResult.status, malformedResult.reason], ['blocked', 'invalid_thread_metadata']);
    assert.equal(malformed.calls.filter((call) => call.options.method === 'POST').length, 0);
  }

  const outside = harness({ resolutions: [found()], channel: { parent_id: '99999999999999999' } });
  const outsideResult = await outside.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'x', operation_id: 'outside-1',
  });
  assert.deepEqual([outsideResult.status, outsideResult.reason], ['blocked', 'outside_write_allowlist']);
  assert.equal(outside.calls.filter((call) => call.options.method === 'POST').length, 0);
});

test('operation cache replays same content and rejects changed content', async () => {
  const h = harness({ resolutions: [found()] });
  const first = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'same', operation_id: 'cache-unique-1',
  });
  assert.equal(first.status, 'posted');
  const writesAfterFirst = h.calls.filter((call) => call.options.method === 'POST').length;
  const second = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'same', operation_id: 'cache-unique-1',
  });
  assert.equal(second.status, 'posted');
  assert.equal(second.process_replay, true);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, writesAfterFirst);
  const conflict = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'different', operation_id: 'cache-unique-1',
  });
  assert.deepEqual([conflict.status, conflict.error], ['conflict', 'operation_id_reused_with_different_content']);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, writesAfterFirst);
});

test('concurrent calls with the same operation_id never produce two Discord writes', async () => {
  const calls = [];
  let releaseFirstPost;
  const firstPostGate = new Promise((resolve) => { releaseFirstPost = resolve; });
  let postCount = 0;
  const readService = { async findIssueThread() { return found(); } };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, options });
    if (endpoint === `channels/${THREAD}` && options.method === 'GET') {
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        thread_metadata: { archived: false, locked: false },
      });
    }
    if (endpoint === `channels/${THREAD}/messages` && options.method === 'POST') {
      postCount += 1;
      if (postCount === 1) await firstPostGate;
      return response({ id: MESSAGE, channel_id: THREAD, content: options.body.content, nonce: options.body.nonce });
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const service = createDiscordWriteService({
    config: readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV)), readService, request, logger: { info() {} },
  });

  const callArgs = { repo: 'a/b', issue_number: 42, content: 'concurrent-same', operation_id: 'concurrent-unique-1' };
  const firstPromise = service.postIssueMessage(callArgs);
  await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = service.postIssueMessage(callArgs);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstPost();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
  assert.equal(first.status, 'posted');
  assert.equal(second.status, 'posted');
  assert.equal(first.message_id, second.message_id);
  assert.equal(first.process_replay, false);
  assert.equal(second.process_replay, true);
});

test('Discord nonce replay with different content fails closed after process-cache loss semantics', async () => {
  const h = harness({ resolutions: [found()], post: { content: 'old-content' } });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'new-content', operation_id: 'nonce-mismatch-unique-1',
  });
  assert.deepEqual([result.status, result.error], ['conflict', 'discord_nonce_content_mismatch']);
});

test('logs and error results never contain message content or Discord error body', async () => {
  const secret = 'SECRET_MESSAGE_CONTENT';
  const readService = { async findIssueThread() { return found(); } };
  const logger = { lines: [], info(...args) { this.lines.push(JSON.stringify(args)); } };
  const request = async (endpoint, options) => {
    if (options.method === 'GET') {
      return response({ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, thread_metadata: { archived: false, locked: false } });
    }
    const error = new Error('VERY_SECRET_DISCORD_BODY');
    error.status = 403;
    throw error;
  };
  const service = createDiscordWriteService({
    config: readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV)), readService, request, logger,
  });
  const result = await service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: secret, operation_id: 'error-unique-1',
  });
  assert.equal(result.error, 'discord_http_403');
  const haystack = JSON.stringify(result) + logger.lines.join('');
  assert.ok(!haystack.includes(secret));
  assert.ok(!haystack.includes('VERY_SECRET_DISCORD_BODY'));
  assert.ok(!haystack.includes(ENV.DISCORD_TOKEN));
});

// ─── Internal canonical handoff edit/delete ─────────────────────────────────

const OTHER_AUTHOR = '88888888888888888';

function handoffHarness({
  resolution = found(),
  channel = {},
  message = {},
  missing = false,
  patch = {},
  deleteStatus = null,
} = {}) {
  const calls = [];
  const readService = { async findIssueThread() { return resolution; } };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, method: options.method });
    assert.equal(options.sensitiveErrors, true);
    if (endpoint === 'users/@me' && options.method === 'GET') return response({ id: BOT, bot: true });
    if (endpoint === `channels/${THREAD}` && options.method === 'GET') {
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        thread_metadata: { archived: false, locked: false }, ...channel,
      });
    }
    if (endpoint === `channels/${THREAD}/messages/${MESSAGE}`) {
      if (options.method === 'GET') {
        if (missing) { const error = new Error('gone'); error.status = 404; throw error; }
        return response({ id: MESSAGE, channel_id: THREAD, content: 'antigo', author: { id: BOT }, ...message });
      }
      if (options.method === 'PATCH') {
        return response({ id: MESSAGE, channel_id: THREAD, content: options.body.content, ...patch });
      }
      if (options.method === 'DELETE') {
        if (deleteStatus) { const error = new Error('delete'); error.status = deleteStatus; throw error; }
        return response(null);
      }
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const logger = { entries: [], info(label, fields) { this.entries.push({ label, fields }); } };
  const config = readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV));
  return { service: createDiscordWriteService({ config, readService, request, logger }), calls };
}

const EDIT = {
  repo: 'a/b', issue_number: 42, message_id: MESSAGE,
  content: 'canonical', operation_id: 'alex-handoff-v1:a/b#42:edit',
};
const DELETE = {
  repo: 'a/b', issue_number: 42, message_id: MESSAGE,
  operation_id: 'alex-handoff-v1:a/b#42:delete',
};

test('the canonical handoff edit rewrites only a Botélia message inside the issue thread', async () => {
  const h = handoffHarness();
  const result = await h.service.editIssueHandoff({ ...EDIT, mention_user_ids: ['1300000000000000000'] });
  assert.equal(result.status, 'edited');
  assert.equal(result.thread_id, THREAD);
  assert.equal(result.message_id, MESSAGE);
  assert.equal(result.unchanged, false);
  assert.deepEqual(h.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'PATCH']);
});

test('an unchanged canonical handoff is not rewritten', async () => {
  const h = handoffHarness({ message: { content: 'canonical' } });
  const result = await h.service.editIssueHandoff(EDIT);
  assert.equal(result.status, 'edited');
  assert.equal(result.unchanged, true);
  assert.equal(h.calls.some((call) => call.method === 'PATCH'), false);
});

test('the canonical handoff verbs refuse another author', async () => {
  const edit = handoffHarness({ message: { author: { id: OTHER_AUTHOR } } });
  const edited = await edit.service.editIssueHandoff(EDIT);
  assert.deepEqual([edited.status, edited.reason], ['blocked', 'foreign_author']);
  assert.equal(edit.calls.some((call) => call.method === 'PATCH'), false);

  const remove = handoffHarness({ message: { author: { id: OTHER_AUTHOR } } });
  const deleted = await remove.service.deleteIssueHandoff(DELETE);
  assert.deepEqual([deleted.status, deleted.reason], ['blocked', 'foreign_author']);
  assert.equal(remove.calls.some((call) => call.method === 'DELETE'), false);
});

test('the canonical handoff verbs refuse a message outside the resolved thread', async () => {
  const h = handoffHarness({ message: { channel_id: '99999999999999999' } });
  const result = await h.service.editIssueHandoff(EDIT);
  assert.deepEqual([result.status, result.reason], ['blocked', 'message_not_in_thread']);
  assert.equal(h.calls.some((call) => call.method === 'PATCH'), false);
});

test('the canonical handoff verbs never resolve an unverified or missing thread', async () => {
  for (const [status, reason] of [['not_found', 'thread_not_found'], ['unverified', 'thread_unverified'], ['ambiguous', 'thread_ambiguous']]) {
    const h = handoffHarness({ resolution: { status, repo: 'a/b', issue_number: 42, candidates: [] } });
    const edited = await h.service.editIssueHandoff(EDIT);
    assert.deepEqual([edited.status, edited.reason], ['blocked', reason]);
    const removed = await h.service.deleteIssueHandoff(DELETE);
    assert.deepEqual([removed.status, removed.reason], ['blocked', reason]);
    assert.equal(h.calls.some((call) => call.method !== 'GET'), false);
  }
});

test('the canonical handoff verbs refuse an unwritable thread', async () => {
  const h = handoffHarness({ resolution: found(), channel: { thread_metadata: { archived: true, locked: false } } });
  const result = await h.service.editIssueHandoff(EDIT);
  assert.deepEqual([result.status, result.reason], ['blocked', 'thread_not_writable']);
});

test('an already absent canonical handoff deletes idempotently', async () => {
  const gone = handoffHarness({ missing: true });
  const first = await gone.service.deleteIssueHandoff(DELETE);
  assert.equal(first.status, 'deleted');
  assert.equal(first.already_absent, true);
  assert.equal(gone.calls.some((call) => call.method === 'DELETE'), false);

  const raced = handoffHarness({ deleteStatus: 404 });
  const second = await raced.service.deleteIssueHandoff(DELETE);
  assert.equal(second.status, 'deleted');
  assert.equal(second.already_absent, true);
});

test('an absent message is not silently recreated by the edit path', async () => {
  const h = handoffHarness({ missing: true });
  const result = await h.service.editIssueHandoff(EDIT);
  assert.deepEqual([result.status, result.reason], ['blocked', 'message_absent']);
  assert.equal(h.calls.some((call) => call.method === 'PATCH'), false);
});

test('the canonical handoff verbs reject caller input they must never accept', async () => {
  const h = handoffHarness();
  const cases = [
    [{ ...EDIT, repo: 'someone/else' }, 'repo_not_allowlisted', 'blocked'],
    [{ ...EDIT, message_id: 'not-a-snowflake' }, 'invalid_message_id', 'invalid_input'],
    [{ ...EDIT, operation_id: '' }, 'invalid_operation_id', 'invalid_input'],
    [{ ...EDIT, content: '' }, 'invalid_content', 'invalid_input'],
    [{ ...EDIT, content: 'x'.repeat(2001) }, 'invalid_content', 'invalid_input'],
    [{ ...EDIT, mention_user_ids: ['1', '2'] }, 'invalid_mention_user_ids', 'invalid_input'],
  ];
  for (const [input, reason, status] of cases) {
    const result = await h.service.editIssueHandoff(input);
    assert.equal(result.status, status, reason);
    assert.equal(result.reason ?? result.error, reason);
  }
  const badDelete = await h.service.deleteIssueHandoff({ ...DELETE, message_id: '1' });
  assert.deepEqual([badDelete.status, badDelete.error], ['invalid_input', 'invalid_message_id']);
  assert.equal(h.calls.length, 0);
});

test('a Discord response that does not confirm the rewrite fails closed', async () => {
  const h = handoffHarness({ patch: { content: 'algo diferente' } });
  const result = await h.service.editIssueHandoff(EDIT);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'invalid_discord_response');
});

function stateHarness({ tags = DEFAULT_TAGS, thread = {}, updated = {}, closeError = false, refuseArchiveOnce = false, patchError = null } = {}) {
  const calls = [];
  let refusedArchive = 0;
  const channel = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    applied_tags: [OPEN_TAG], thread_metadata: { archived: false, locked: false }, ...thread };
  const service = createDiscordWriteService({ config: readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV)),
    readService: { findIssueThread() { throw new Error('must not read messages'); } }, logger: { info() {} },
    request: async (endpoint, options) => {
      calls.push({ endpoint, options });
      assert.equal(options.sensitiveErrors, true);
      if (options.method === 'PATCH') {
        assert.equal(endpoint, `channels/${THREAD}`);
        const body = options.body ?? {};
        if (patchError) throw patchError;
        // Discord recusa (HTTP 400, código 50083) PATCH que edita um tópico já
        // arquivado com qualquer campo além de `archived: false`.
        if (channel.thread_metadata.archived && body.archived !== false) {
          throw Object.assign(new Error('Thread is archived'), { status: 400, discord_code: 50083 });
        }
        if (refuseArchiveOnce && body.archived === true && refusedArchive === 0) {
          refusedArchive += 1;
          throw Object.assign(new Error('Thread is archived'), { status: 400, discord_code: 50083 });
        }
        if (closeError && body.archived === true) throw Object.assign(new Error('RAW-SECRET'), { status: 403 });
        // `applied_tags` e `thread_metadata` mudam de forma independente, como
        // no Discord: um PATCH que traz etiqueta junto de arquivamento move o
        // estado inteiro. Tratar os dois como blocos mutuamente exclusivos
        // deixaria o mock afirmar um estado que o Discord não tem.
        const metadata = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'applied_tags'));
        const metaKeys = Object.keys(metadata);
        assert.ok(!metaKeys.length
          || (metaKeys.length === 1 && metaKeys[0] === 'archived' && metadata.archived === false)
          || (metaKeys.length === 2 && metaKeys[0] === 'archived' && metaKeys[1] === 'locked'
            && metadata.archived === true && metadata.locked === true),
        `PATCH de metadados inesperado: ${JSON.stringify(body)}`);
        if ('archived' in metadata) channel.thread_metadata.archived = metadata.archived;
        if ('locked' in metadata) channel.thread_metadata.locked = metadata.locked;
        if ('applied_tags' in body) channel.applied_tags = [...body.applied_tags];
        return response({ ...channel, ...updated });
      }
      assert.equal(options.method, 'GET');
      if (endpoint === `channels/${PARENT}`) return response({ id: PARENT, guild_id: GUILD, type: 15, available_tags: tags });
      assert.equal(endpoint, `channels/${THREAD}`);
      return response(channel);
    } });
  return { service, calls };
}
const stateInput = (id = crypto.randomUUID()) => ({ thread_id: THREAD, state: 'Concluído', operation_id: id });
test('state tag replaces state only, confirms Discord and retries without PATCH', async () => {
  const extra = '88888888888888888';
  const h = stateHarness({ thread: { applied_tags: [OPEN_TAG, extra] } });
  const input = stateInput();
  const result = await h.service.setIssueThreadState(input);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.applied_tags, [extra, DONE_TAG]);
  assert.equal(result.changed, true);
  assert.equal((await h.service.setIssueThreadState(input)).changed, false);
  assert.equal(h.calls.filter((c) => c.options.method === 'PATCH').length, 2);
  assert.equal((await h.service.setIssueThreadState({ ...input, state: 'Aberto' })).status, 'conflict');
});
test('already requested state succeeds without writing', async () => {
  const h = stateHarness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: true } } });
  assert.equal((await h.service.setIssueThreadState(stateInput())).changed, false);
  assert.ok(h.calls.every((c) => c.options.method === 'GET'));
});
for (const [name, options, expected] of [
  ['outside forum', { thread: { parent_id: MESSAGE } }, 'outside_write_allowlist'],
  ['outside guild', { thread: { guild_id: MESSAGE } }, 'outside_write_allowlist'],
  ['missing tag', { tags: [] }, 'state_tag_not_found'],
  ['duplicate tag', { tags: [{ id: DONE_TAG, name: 'Concluído' }, { id: OPEN_TAG, name: 'Concluído' }] }, 'state_tag_ambiguous'],
  ['archived and locked', { thread: { thread_metadata: { archived: true, locked: true } } }, 'thread_not_writable'],
  ['locked', { thread: { thread_metadata: { archived: false, locked: true } } }, 'thread_not_writable'],
]) test(`state tag fails closed: ${name}`, async () => {
  const h = stateHarness(options);
  assert.equal((await h.service.setIssueThreadState(stateInput())).reason, expected);
  assert.ok(h.calls.every((c) => c.options.method === 'GET'));
});
test('invalid states are rejected before any Discord request', async () => {
  for (const state of ['concluído', 'Concluído\n', 'other', null, 3]) {
    const h = stateHarness();
    assert.equal((await h.service.setIssueThreadState({ ...stateInput(), state })).error, 'invalid_state');
    assert.equal(h.calls.length, 0);
  }
});
test('divergent Discord tags and lost non-state tag fail confirmation', async () => {
  for (const applied_tags of [[OPEN_TAG], [DONE_TAG]]) {
    const h = stateHarness({ thread: { applied_tags: [OPEN_TAG, MESSAGE] }, updated: { applied_tags } });
    assert.equal((await h.service.setIssueThreadState(stateInput())).error, 'invalid_discord_response');
  }
});

test('each exact state resolves its live tag name and removes multiple prior states', async () => {
  const tags = ['Aberto', 'Em andamento', 'Aguardando Diretor', 'Concluído'].map((name, index) => ({ name, id: String(66666666666666660n + BigInt(index)) }));
  for (const tag of tags) {
    const h = stateHarness({ tags, thread: { applied_tags: tags.map((item) => item.id) } });
    const result = await h.service.setIssueThreadState({ ...stateInput(), state: tag.name });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.applied_tags, [tag.id]);
  }
});

for (const applied_tags of [undefined, []]) test(`state tag accepts initially empty tags (${applied_tags === undefined ? 'absent' : 'array'})`, async () => {
  const h = stateHarness({ thread: { applied_tags } });
  const input = stateInput();
  const result = await h.service.setIssueThreadState(input);
  assert.equal(result.status, 'ok');
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied_tags, [DONE_TAG]);
  assert.deepEqual(h.calls.find((call) => call.options.method === 'PATCH').options.body, { applied_tags: [DONE_TAG] });
  assert.equal((await h.service.setIssueThreadState(input)).changed, false);
  assert.equal(h.calls.filter((call) => call.options.method === 'PATCH').length, 2);
});
test('state tag still requires applied_tags in PATCH confirmation', async () => {
  const h = stateHarness({ thread: { applied_tags: undefined }, updated: { applied_tags: undefined } });
  assert.equal((await h.service.setIssueThreadState(stateInput())).error, 'invalid_discord_response');
});
test('state tag does not normalize malformed initial tags', async () => {
  for (const applied_tags of [null, 'invalid', {}, [DONE_TAG, DONE_TAG]]) {
    const h = stateHarness({ thread: { applied_tags } });
    assert.equal((await h.service.setIssueThreadState(stateInput())).error, 'invalid_discord_response');
    assert.ok(h.calls.every((call) => call.options.method === 'GET'));
  }
});

function gatewayStateHarness({ appliedTags, fail = false, initialMetadata = { archived: false, locked: false } } = {}) {
  const calls = [];
  const entries = [];
  let metadata = initialMetadata;
  let current = appliedTags;
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, newly_created: true, name: 'UNTRUSTED-NAME' };
  const options = { env: ENV, logger: { info(meta) { entries.push(meta); }, error(meta) { entries.push(meta); } },
    request: async (endpoint, options) => {
      calls.push({ endpoint, options });
      if (fail === true || options.method === fail) throw new Error('UNTRUSTED-ERROR');
      if (endpoint.startsWith(`guilds/${GUILD}/audit-logs`)) return response({ audit_log_entries: [], users: [] });
      if (endpoint === `channels/${PARENT}`) return response({ id: PARENT, guild_id: GUILD, type: 15, available_tags: [...DEFAULT_TAGS, { id: '88888888888888881', name: 'Em andamento' }, { id: '88888888888888882', name: 'Aguardando Diretor' }] });
      assert.equal(endpoint, `channels/${THREAD}`);
      if (options.method === 'PATCH') {
        if ('applied_tags' in options.body) current = options.body.applied_tags;
        else { assert.deepEqual(options.body, { archived: true, locked: true }); metadata = options.body; }
      } else assert.equal(options.method, 'GET');
      return response({ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, applied_tags: current, thread_metadata: metadata });
    } };
  return { event, options, calls, entries };
}
test('Gateway new untagged task receives Aberto, replay does not write twice', async () => {
  const h = gatewayStateHarness();
  await handleTaskThreadCreate(h.event, h.options);
  const patches = () => h.calls.filter((call) => call.options.method === 'PATCH');
  assert.deepEqual(patches()[0].options.body.applied_tags, [OPEN_TAG]);
  await handleTaskThreadCreate(h.event, h.options);
  assert.equal(patches().length, 1);
  assert.equal(h.entries[0].outcome, 'ok');
  assert.ok(!JSON.stringify(h.entries).includes('UNTRUSTED'));
});
test('Gateway preserves author state and skips bot-created already-open tasks', async () => {
  for (const stateId of [OPEN_TAG, DONE_TAG, '88888888888888881', '88888888888888882']) {
    const h = gatewayStateHarness({ appliedTags: [stateId] });
    await handleTaskThreadCreate(h.event, h.options);
    assert.ok(h.calls.every((call) => call.options.method === 'GET'));
    assert.equal(h.entries[0].outcome, 'ok');
  }
});
test('Gateway ignores other guild/forum and visibility events without requests', async () => {
  for (const change of [{ parent_id: MESSAGE }, { guild_id: MESSAGE }, { newly_created: false }, { newly_created: undefined }, { type: 12 }]) {
    const h = gatewayStateHarness();
    await handleTaskThreadCreate({ ...h.event, ...change }, h.options);
    assert.equal(h.calls.length, 0);
    assert.equal(h.entries.length, 0);
  }
});
test('Gateway Discord failure is contained and audit has metadata only', async () => {
  for (const fail of [true, 'PATCH']) {
    const h = gatewayStateHarness({ fail });
    await assert.doesNotReject(handleTaskThreadCreate(h.event, h.options));
    assert.equal(h.entries[0].outcome, 'error');
    assert.equal(h.entries[0].error_code, 'task_tag_failed');
    assert.ok(!JSON.stringify(h.entries).includes('UNTRUSTED'));
  }
});
test('Gateway non-state tags are preserved', async () => {
  const h = gatewayStateHarness({ appliedTags: [MESSAGE] });
  await handleTaskThreadCreate(h.event, h.options);
  assert.deepEqual(h.calls.find((call) => call.options.method === 'PATCH').options.body.applied_tags, [MESSAGE, OPEN_TAG]);
});

test('completion confirms tag before archive/lock; close failure is never success', async () => {
  for (const closeError of [false, true]) {
    const h = stateHarness({ closeError });
    const result = await h.service.setIssueThreadState(stateInput());
    assert.deepEqual(h.calls.filter(c => c.options.method === 'PATCH').map(c => c.options.body),
      [{ applied_tags: [DONE_TAG] }, { archived: true, locked: true }]);
    assert.equal(result.status, closeError ? 'error' : 'ok');
    if (closeError) assert.equal(result.error, 'discord_http_403');
    else assert.equal(result.locked, true);
  }
});
test('other states never archive or lock', async () => {
  const tags = ['Aberto', 'Em andamento', 'Aguardando Diretor', 'Concluído'].map((name, index) => ({ name, id: String(66666666666666660n + BigInt(index)) }));
  for (const state of ['Aberto', 'Em andamento', 'Aguardando Diretor']) {
    const h = stateHarness({ tags });
    assert.equal((await h.service.setIssueThreadState({ ...stateInput(), state })).status, 'ok');
    assert.ok(h.calls.filter(c => c.options.method === 'PATCH').every(c => !('archived' in c.options.body)));
  }
});
test('completed archived but unlocked thread reopens before archiving, idempotently', async () => {
  const h = stateHarness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: false } } });
  const input = stateInput();
  const result = await h.service.setIssueThreadState(input);
  assert.equal(result.status, 'ok');
  assert.equal(result.locked, true);
  // Reabrir preserva etiquetas; o arquivamento só é aceito com o fórum aberto.
  assert.deepEqual(h.calls.filter((c) => c.options.method === 'PATCH').map((c) => c.options.body), [
    { archived: false },
    { archived: true, locked: true },
  ]);
  assert.equal((await h.service.setIssueThreadState(input)).changed, false);
  assert.equal(h.calls.filter((c) => c.options.method === 'PATCH').length, 2);
});

test('completed archived but unlocked thread reopens before writing the tag', async () => {
  const h = stateHarness({ thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } } });
  const result = await h.service.setIssueThreadState(stateInput());
  assert.equal(result.status, 'ok');
  assert.deepEqual(h.calls.filter((c) => c.options.method === 'PATCH').map((c) => c.options.body), [
    { archived: false },
    { applied_tags: [DONE_TAG] },
    { archived: true, locked: true },
  ]);
});

test('Discord refusing the archive reports the stable code, retry converges', async () => {
  const h = stateHarness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: false } },
    refuseArchiveOnce: true });
  const input = stateInput();
  const refused = await h.service.setIssueThreadState(input);
  assert.deepEqual([refused.status, refused.error], ['error', 'thread_archived_edit_refused']);
  assert.deepEqual(h.calls.filter((c) => c.options.method === 'PATCH').map((c) => c.options.body), [
    { archived: false },
    { archived: true, locked: true },
  ]);
  // reopened and still Concluído: a retry converges and stays idempotent
  const retried = await h.service.setIssueThreadState({ ...input, operation_id: crypto.randomUUID() });
  assert.equal(retried.status, 'ok');
  assert.equal(retried.changed, true);
  assert.deepEqual(h.calls.filter((c) => c.options.method === 'PATCH').map((c) => c.options.body), [
    { archived: false },
    { archived: true, locked: true },
    { archived: true, locked: true },
  ]);
});

test('a stable error code survives a status attached by the request layer', async () => {
  // A allowlist de `safeError` é avaliada antes da faixa de status: código
  // estável não pode virar `discord_http_400` genérico.
  for (const message of ['invalid_discord_response', 'invalid_write_parent', 'thread_archived_edit_refused']) {
    const stable = stateHarness({ patchError: Object.assign(new Error(message), { status: 400 }) });
    assert.equal((await stable.service.setIssueThreadState(stateInput())).error, message);
  }
  // Mensagem fora da allowlist continua sanitizada: nunca vaza o texto cru.
  const unknown = stateHarness({ patchError: Object.assign(new Error('RAW-SECRET'), { status: 400 }) });
  const sanitized = await unknown.service.setIssueThreadState(stateInput());
  assert.equal(sanitized.error, 'discord_http_400');
  assert.ok(!JSON.stringify(sanitized).includes('RAW-SECRET'));
  const bare = stateHarness({ patchError: new Error('brutal') });
  assert.equal((await bare.service.setIssueThreadState(stateInput())).error, 'discord_request_failed');
});

test('human completion update closes once, ignores own closed event and other scopes', async () => {
  const h = gatewayStateHarness({ appliedTags: [DONE_TAG] });
  await handleTaskThreadUpdate(h.event, h.options);
  await handleTaskThreadUpdate(h.event, h.options);
  assert.equal(h.calls.filter(c => c.options.method === 'PATCH').length, 1);
  assert.equal(h.entries[0].outcome, 'ok');
  assert.equal(h.entries.length, 1);
  for (const change of [{ parent_id: MESSAGE }, { guild_id: MESSAGE }, { thread_metadata: { archived: true, locked: true } }]) {
    const ignored = gatewayStateHarness({ appliedTags: [DONE_TAG] });
    await handleTaskThreadUpdate({ ...ignored.event, ...change }, ignored.options);
    assert.equal(ignored.calls.length, 0);
    assert.deepEqual(ignored.entries, []);
  }
});
test('update for other states does not retag or close; failure uses safe audit', async () => {
  const h = gatewayStateHarness({ appliedTags: [OPEN_TAG] });
  await handleTaskThreadUpdate(h.event, h.options);
  assert.ok(h.calls.every(c => c.options.method === 'GET'));
  assert.deepEqual(h.entries, []);
  const failed = gatewayStateHarness({ appliedTags: [DONE_TAG], fail: 'PATCH' });
  await handleTaskThreadUpdate(failed.event, failed.options);
  assert.equal(failed.entries[0].outcome, 'error');
  assert.ok(!JSON.stringify(failed.entries).includes('UNTRUSTED'));
});

test('unconfirmed archive flags fail closed and concurrent completion writes once', async () => {
  const invalid = stateHarness({ updated: { thread_metadata: { archived: true, locked: false } } });
  assert.equal((await invalid.service.setIssueThreadState(stateInput())).error, 'invalid_discord_response');
  const h = stateHarness();
  const results = await Promise.all([h.service.setIssueThreadState(stateInput()), h.service.closeCompletedIssueThread(THREAD)]);
  assert.ok(results.every(result => result.status === 'ok'));
  assert.equal(h.calls.filter(c => c.options.method === 'PATCH').length, 2);
});

test('completed thread already closed in REST emits no closure receipt', async () => {
  const h = gatewayStateHarness({ appliedTags: [DONE_TAG], initialMetadata: { archived: true, locked: true } });
  await handleTaskThreadUpdate({ ...h.event, applied_tags: [DONE_TAG] }, h.options);
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(c => c.options.method === 'GET'));
  assert.deepEqual(h.entries, []);
});
test('empty update tags skip REST; completion in event still requires live recheck', async () => {
  const empty = gatewayStateHarness({ appliedTags: [DONE_TAG] });
  await handleTaskThreadUpdate({ ...empty.event, applied_tags: [] }, empty.options);
  assert.deepEqual(empty.calls, []);
  assert.deepEqual(empty.entries, []);
  const stale = gatewayStateHarness({ appliedTags: [OPEN_TAG] });
  await handleTaskThreadUpdate({ ...stale.event, applied_tags: [DONE_TAG] }, stale.options);
  assert.ok(stale.calls.length > 0);
  assert.ok(stale.calls.every(c => c.options.method === 'GET'));
  assert.deepEqual(stale.entries, []);
});

// ─── Lido-após-resposta (📨 própria → ✅) ──────────────────────────────

const MSG_A = '66666666666666661';
const MSG_B = '66666666666666662';
const SCAN_ENDPOINT = `channels/${THREAD}/messages?limit=${DIRECTOR_READ_MARK_LIMIT}`;

function inboxMessage(id, me = true) {
  return {
    id, channel_id: THREAD, content: 'ping humano', author: { id: '99999999999999999' },
    reactions: [{ emoji: { id: null, name: '📨' }, count: 1, me }],
  };
}

function plainMessage(id) {
  return { id, channel_id: THREAD, content: 'conversa', author: { id: '99999999999999999' }, reactions: [] };
}

function readMarkHarness({ threadMessages = [], channel = {}, failDeleteFor = new Set(), failPutFor = new Set() } = {}) {
  const calls = [];
  const readService = { async findIssueThread() { return found(); } };
  const request = async (endpoint, options) => {
    calls.push({ endpoint, method: options.method });
    assert.equal(options.sensitiveErrors, true);
    if (endpoint === `channels/${THREAD}` && options.method === 'GET') {
      return response({
        id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        thread_metadata: { archived: false, locked: false }, ...channel,
      });
    }
    if (endpoint === `channels/${THREAD}/messages` && options.method === 'POST') {
      return response({ id: MESSAGE, channel_id: THREAD, content: options.body.content, nonce: options.body.nonce });
    }
    if (endpoint === SCAN_ENDPOINT && options.method === 'GET') {
      return response(threadMessages);
    }
    if (endpoint.includes('/reactions/') && endpoint.endsWith('/@me')) {
      const parts = endpoint.split('/');
      assert.equal(parts[0], 'channels');
      assert.equal(parts[1], THREAD);
      assert.equal(parts[2], 'messages');
      assert.equal(parts[4], 'reactions');
      assert.equal(parts[6], '@me');
      const messageId = parts[3];
      const emoji = decodeURIComponent(parts[5]);
      assert.ok(['📨', '✅'].includes(emoji));
      if (options.method === 'DELETE') {
        assert.equal(emoji, '📨');
        if (failDeleteFor.has(messageId)) throw Object.assign(new Error('denied'), { status: 403 });
        return response(null);
      }
      if (options.method === 'PUT') {
        assert.equal(emoji, '✅');
        if (failPutFor.has(messageId)) throw Object.assign(new Error('denied'), { status: 403 });
        return response(null);
      }
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const logger = { entries: [], info(label, fields) { this.entries.push({ label, fields }); } };
  const config = readDiscordWriteConfig(ENV, readDiscordReadConfig(ENV));
  return { service: createDiscordWriteService({ config, readService, request, logger }), calls, logger };
}

const reactionCalls = (calls) => calls.filter((call) => call.endpoint.includes('/reactions/'));

test('post troca a 📨 própria por ✅ sem tocar em mensagem sem 📨', async () => {
  const h = readMarkHarness({ threadMessages: [inboxMessage(MSG_A), plainMessage(MSG_B)] });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-1',
  });
  assert.equal(result.status, 'posted');
  assert.equal(result.read_mark.status, 'ok');
  assert.equal(result.read_mark.marked_read, 1);
  assert.equal(result.read_mark.failed, 0);
  const reacted = reactionCalls(h.calls);
  assert.ok(reacted.some((call) => call.method === 'DELETE' && call.endpoint.includes(MSG_A) && call.endpoint.includes(encodeURIComponent('📨'))));
  assert.ok(reacted.some((call) => call.method === 'PUT' && call.endpoint.includes(MSG_A) && call.endpoint.includes(encodeURIComponent('✅'))));
  assert.ok(!reacted.some((call) => call.endpoint.includes(MSG_B)));
  assert.ok(reacted.every((call) => call.endpoint.endsWith('/@me')));
});

test('mensagem sem 📨 própria fica intacta', async () => {
  const h = readMarkHarness({ threadMessages: [plainMessage(MSG_A), plainMessage(MSG_B)] });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-2',
  });
  assert.equal(result.status, 'posted');
  assert.deepEqual([result.read_mark.marked_read, result.read_mark.failed], [0, 0]);
  assert.equal(reactionCalls(h.calls).length, 0);
});

test('reação 📨 de pessoa nunca é tocada', async () => {
  const h = readMarkHarness({ threadMessages: [inboxMessage(MSG_A, false)] });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-3',
  });
  assert.equal(result.status, 'posted');
  assert.deepEqual([result.read_mark.marked_read, result.read_mark.failed], [0, 0]);
  assert.equal(reactionCalls(h.calls).length, 0);
});

test('tópico fora do fórum allowlisted não posta nem troca reação', async () => {
  const h = readMarkHarness({ threadMessages: [inboxMessage(MSG_A)], channel: { parent_id: '99999999999999999' } });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-4',
  });
  assert.deepEqual([result.status, result.reason], ['blocked', 'outside_write_allowlist']);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(reactionCalls(h.calls).length, 0);
  assert.ok(!h.calls.some((call) => call.endpoint === SCAN_ENDPOINT));
});

test('falha na troca aparece no recibo sem derrubar a postagem', async () => {
  const h = readMarkHarness({ threadMessages: [inboxMessage(MSG_A)], failDeleteFor: new Set([MSG_A]) });
  const result = await h.service.postIssueMessage({
    repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-5',
  });
  assert.equal(result.status, 'posted');
  assert.ok(result.message_id);
  assert.equal(result.read_mark.status, 'partial');
  assert.equal(result.read_mark.failed, 1);
  assert.equal(result.read_mark.marked_read, 0);
  const audit = h.logger.entries.find((entry) => entry.fields.operation === 'post_issue_message');
  assert.equal(audit.fields.result, 'posted_with_read_mark_error');
  assert.equal(audit.fields.read_mark_failed, 1);
  const haystack = JSON.stringify(result) + JSON.stringify(h.logger.entries);
  assert.ok(!haystack.includes('resposta do diretor'));
});

test('repetição do mesmo operation_id não escreve de novo', async () => {
  const h = readMarkHarness({ threadMessages: [inboxMessage(MSG_A)] });
  const input = { repo: 'a/b', issue_number: 42, content: 'resposta do diretor', operation_id: 'lido-6' };
  const first = await h.service.postIssueMessage(input);
  assert.equal(first.status, 'posted');
  assert.equal(first.process_replay, false);
  const writesAfterFirst = h.calls.length;
  const second = await h.service.postIssueMessage(input);
  assert.equal(second.status, 'posted');
  assert.equal(second.process_replay, true);
  assert.equal(h.calls.length, writesAfterFirst);
  assert.deepEqual(second.read_mark, first.read_mark);
});

test('429 seguido de sucesso marca sem contar falha', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let putAttempts = 0;
  const request = async (endpoint, options) => {
    if (endpoint === SCAN_ENDPOINT && options.method === 'GET') return response([inboxMessage(MSG_A)]);
    if (endpoint.includes('/reactions/') && endpoint.endsWith('/@me')) {
      if (options.method === 'DELETE') return response(null);
      if (options.method === 'PUT') {
        putAttempts += 1;
        if (putAttempts === 1) throw Object.assign(new Error('rate limited'), { status: 429, retry_after: 0.2 });
        return response(null);
      }
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const result = await markDirectorPingsReadWith(request, THREAD, MESSAGE, { sleep });
  assert.equal(result.status, 'ok');
  assert.equal(result.marked_read, 1);
  assert.equal(result.failed, 0);
  assert.equal(putAttempts, 2);
  assert.ok(sleeps.includes(DIRECTOR_READ_MARK_PAUSE_MS));
  assert.ok(sleeps.includes(200));
});

test('429 duas vezes conta falha sem terceira tentativa', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let putAttempts = 0;
  const request = async (endpoint, options) => {
    if (endpoint === SCAN_ENDPOINT && options.method === 'GET') return response([inboxMessage(MSG_A)]);
    if (endpoint.includes('/reactions/') && endpoint.endsWith('/@me')) {
      if (options.method === 'DELETE') return response(null);
      if (options.method === 'PUT') {
        putAttempts += 1;
        throw Object.assign(new Error('rate limited'), { status: 429, retry_after: 1 });
      }
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const result = await markDirectorPingsReadWith(request, THREAD, MESSAGE, { sleep });
  assert.equal(result.status, 'partial');
  assert.equal(result.marked_read, 0);
  assert.equal(result.failed, 1);
  assert.equal(putAttempts, 2);
});

test('403 não repete a chamada', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let deleteAttempts = 0;
  let putAttempts = 0;
  const request = async (endpoint, options) => {
    if (endpoint === SCAN_ENDPOINT && options.method === 'GET') return response([inboxMessage(MSG_A)]);
    if (endpoint.includes('/reactions/') && endpoint.endsWith('/@me')) {
      if (options.method === 'DELETE') {
        deleteAttempts += 1;
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      if (options.method === 'PUT') {
        putAttempts += 1;
        return response(null);
      }
    }
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const result = await markDirectorPingsReadWith(request, THREAD, MESSAGE, { sleep });
  assert.equal(result.status, 'partial');
  assert.equal(result.failed, 1);
  assert.equal(deleteAttempts, 1);
  assert.equal(putAttempts, 0);
});

test('pausa de 300 ms acontece entre chamadas de reação', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const request = async (endpoint, options) => {
    if (endpoint === SCAN_ENDPOINT && options.method === 'GET') {
      return response([inboxMessage(MSG_A), inboxMessage(MSG_B)]);
    }
    if (endpoint.includes('/reactions/') && endpoint.endsWith('/@me')) return response(null);
    throw new Error(`unexpected endpoint: ${options.method} ${endpoint}`);
  };
  const result = await markDirectorPingsReadWith(request, THREAD, MESSAGE, { sleep });
  assert.equal(result.status, 'ok');
  assert.equal(result.marked_read, 2);
  assert.deepEqual(sleeps, [
    DIRECTOR_READ_MARK_PAUSE_MS,
    DIRECTOR_READ_MARK_PAUSE_MS,
    DIRECTOR_READ_MARK_PAUSE_MS,
  ]);
});
