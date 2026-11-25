import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleMentionReply,
  isMentionDirectorChannel,
  isReplyToDirectorMessage,
  readMentionDirectorConfig,
  resetPresenceBotUserId,
  setPresenceAskModel,
  setPresenceDiscordRequest,
} from './presence.js';
import { DIRECTOR_AUTHOR_NAME } from './mcp-discord-2a3a.js';
import { audit, createAuditLogger } from './audit-log.js';
import { askConversation } from './llm.js';

process.env.NODE_TEST_CONTEXT = '1';

const BOT = '1300000000000000051';
const MEMBER = '1300000000000000001';
const OTHER = '1300000000000000002';
const CATEGORY = '22222222222222222';
const TEXT_IN = '33333333333333333';
const TEXT_OUT = '39999999999999999';
const FORUM = '35555555555555555';
const THREAD_IN = '37777777777777777';
const MSG = '43333333333333333';
const CLA_ROLE = '1300000000000000050';
const APP_ID = '14444444444444444';
const DIRECTOR_WEBHOOK_ID = '55555555555555555';
const DIRECTOR_MSG_ID = '46666666666666666';

function setDirectorEnv(userIds = MEMBER, categoryId = CATEGORY) {
  process.env.MENTION_DIRECTOR_USER_IDS = userIds;
  process.env.MENTION_DIRECTOR_CATEGORY_ID = categoryId;
}

function clearDirectorEnv() {
  delete process.env.MENTION_DIRECTOR_USER_IDS;
  delete process.env.MENTION_DIRECTOR_CATEGORY_ID;
}

function channelFixtures() {
  return {
    [TEXT_IN]: { id: TEXT_IN, guild_id: '1', parent_id: CATEGORY, type: 0 },
    [TEXT_OUT]: { id: TEXT_OUT, guild_id: '1', parent_id: '99999999999999990', type: 0 },
    [THREAD_IN]: { id: THREAD_IN, guild_id: '1', parent_id: FORUM, type: 11 },
    [FORUM]: { id: FORUM, guild_id: '1', parent_id: CATEGORY, type: 15 },
  };
}

function makeDiscord({ channels = channelFixtures(), failChannels = [], failReaction = null } = {}) {
  const calls = { reactions: [], posts: [], typing: 0, appId: 0 };
  const json = async (body) => ({ json: async () => body });
  const request = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    if (endpoint === 'users/@me' && method === 'GET') return json({ id: BOT });
    if (endpoint === 'applications/@me' && method === 'GET') {
      calls.appId += 1;
      return json({ id: APP_ID });
    }
    if (endpoint.startsWith('channels/') && method === 'GET' && !endpoint.includes('/messages')) {
      const id = endpoint.split('/')[1];
      if (failChannels.includes(id)) {
        const err = new Error('boom');
        err.status = 500;
        throw err;
      }
      if (!channels[id]) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return json(channels[id]);
    }
    if (/^channels\/[^/]+\/messages\/[^/]+\/reactions\//.test(endpoint) && method === 'PUT') {
      if (failReaction) throw failReaction;
      calls.reactions.push(endpoint);
      return json({});
    }
    if (/^channels\/[^/]+\/typing$/.test(endpoint) && method === 'POST') {
      calls.typing += 1;
      return json({});
    }
    if (/^channels\/[^/]+\/messages\?/.test(endpoint) && method === 'GET') return json([]);
    if (/^channels\/[^/]+\/messages$/.test(endpoint) && method === 'POST') {
      calls.posts.push({ endpoint, body: options.body });
      return json({ id: '999' });
    }
    throw new Error(`unexpected: ${method} ${endpoint}`);
  };
  return { calls, request };
}

function mentionMessage({ authorId = MEMBER, channelId = TEXT_IN, bot = false, webhook = false } = {}) {
  return {
    id: MSG,
    channel_id: channelId,
    guild_id: '1',
    type: 0,
    content: `<@${BOT}> ajuda aqui`,
    timestamp: new Date().toISOString(),
    mentions: [{ id: BOT }],
    webhook_id: webhook ? '55555555555555555' : undefined,
    author: { id: authorId, username: 'membro', bot },
    member: { roles: [CLA_ROLE] },
  };
}

function wire({ discord, modelCalls } = {}) {
  resetPresenceBotUserId();
  const d = discord ?? makeDiscord();
  setPresenceDiscordRequest(d.request);
  const calls = modelCalls ?? [];
  setPresenceAskModel(async () => {
    calls.push(1);
    return { ok: true, text: 'oi' };
  });
  return { calls, discord: d };
}

function directorRef({ username = DIRECTOR_AUTHOR_NAME, authorId = DIRECTOR_WEBHOOK_ID, appId = APP_ID, webhookId = DIRECTOR_WEBHOOK_ID } = {}) {
  return {
    id: DIRECTOR_MSG_ID,
    channel_id: TEXT_IN,
    webhook_id: webhookId,
    author: { id: authorId, username, bot: true },
    application_id: appId,
  };
}

function replyMessage({ authorId = MEMBER, channelId = TEXT_IN, ref = directorRef(), withMention = false } = {}) {
  return {
    id: MSG,
    channel_id: channelId,
    guild_id: '1',
    type: 0,
    content: withMention ? `<@${BOT}> entendido` : 'entendido',
    timestamp: new Date().toISOString(),
    mentions: withMention ? [{ id: BOT }] : [],
    message_reference: { message_id: DIRECTOR_MSG_ID, channel_id: channelId, guild_id: '1' },
    referenced_message: ref,
    author: { id: authorId, username: 'membro' },
    member: { roles: [CLA_ROLE] },
  };
}

test.afterEach(() => {
  clearDirectorEnv();
});

test('config ausente desliga o encaminhamento', () => {
  const cfg = readMentionDirectorConfig({});
  assert.equal(cfg.enabled, false);
});

test('config inválida desliga o encaminhamento', () => {
  assert.equal(readMentionDirectorConfig({ MENTION_DIRECTOR_USER_IDS: 'abc', MENTION_DIRECTOR_CATEGORY_ID: CATEGORY }).enabled, false);
  assert.equal(readMentionDirectorConfig({ MENTION_DIRECTOR_USER_IDS: `${MEMBER},not-a-snowflake`, MENTION_DIRECTOR_CATEGORY_ID: CATEGORY }).enabled, false);
  assert.equal(readMentionDirectorConfig({ MENTION_DIRECTOR_USER_IDS: MEMBER }).enabled, false);
  assert.equal(readMentionDirectorConfig({ MENTION_DIRECTOR_USER_IDS: MEMBER, MENTION_DIRECTOR_CATEGORY_ID: '123' }).enabled, false);
  assert.equal(readMentionDirectorConfig({ MENTION_DIRECTOR_USER_IDS: '', MENTION_DIRECTOR_CATEGORY_ID: CATEGORY }).enabled, false);
});

test('config válida liga o encaminhamento', () => {
  const cfg = readMentionDirectorConfig({
    MENTION_DIRECTOR_USER_IDS: ` ${MEMBER} , ${OTHER} `,
    MENTION_DIRECTOR_CATEGORY_ID: CATEGORY,
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.userIds, [MEMBER, OTHER]);
  assert.equal(cfg.categoryId, CATEGORY);
});

test('sem config, fluxo normal chama o modelo', async () => {
  clearDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ authorId: '1300000000000000011' }));
  assert.equal(calls.length, 1);
  assert.equal(discord.calls.posts.length, 1);
});

test('eligible mention uses OpenRouter conversation and preserves reply/mention controls', async (t) => {
  clearDirectorEnv();
  const { discord } = wire();
  setPresenceAskModel(askConversation);
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'synthetic-key-for-presence';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model: 'test/model:free', choices: [{ message: { content: 'Oi, como vai?' } }] }));
  });
  const auditInfo = t.mock.method(audit, 'info', () => {});
  try {
    await handleMentionReply(mentionMessage({ authorId: '1300000000000000091' }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.model, 'openrouter/free');
    assert.match(requests[0].payload.messages[0].content, /Português brasileiro/);
    assert.equal(requests[0].payload.messages[1].content, 'ajuda aqui');
    assert.equal(discord.calls.posts.length, 1);
    assert.equal(discord.calls.posts[0].body.content, 'Oi, como vai?');
    assert.deepEqual(discord.calls.posts[0].body.allowed_mentions, { parse: [] });
    assert.equal(discord.calls.posts[0].body.message_reference.message_id, MSG);
    assert.equal(auditInfo.mock.callCount(), 1);
    await handleMentionReply(mentionMessage({ authorId: '1300000000000000091' }));
    assert.equal(requests.length, 1, 'cooldown prevents another model request');
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('conversation missing key message refers to OpenRouter', async () => {
  clearDirectorEnv();
  const { discord } = wire();
  setPresenceAskModel(async () => ({ ok: false, reason: 'no-key' }));
  await handleMentionReply(mentionMessage({ authorId: '1300000000000000092' }));
  assert.match(discord.calls.posts[0].body.content, /OpenRouter/);
  assert.doesNotMatch(discord.calls.posts[0].body.content, /Gemini/);
});

test('conversation timeout produces one safe user response', async () => {
  clearDirectorEnv();
  const { discord } = wire();
  setPresenceAskModel(async () => ({ ok: false, reason: 'timeout' }));
  await handleMentionReply(mentionMessage({ authorId: '1300000000000000093' }));
  assert.equal(discord.calls.posts.length, 1);
  assert.match(discord.calls.posts[0].body.content, /Tente de novo/);
});

test('config inválida mantém o comportamento atual', async () => {
  setDirectorEnv('not-a-snowflake', CATEGORY);
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ authorId: '1300000000000000012' }));
  assert.equal(calls.length, 1);
  assert.equal(discord.calls.posts.length, 1);
});

test('pessoa da lista dentro da categoria recebe só reação, sem modelo', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage());
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
  assert.ok(discord.calls.reactions[0].includes(encodeURIComponent('📨')));
});

test('pessoa da lista fora da categoria segue o fluxo normal', async () => {
  const listedOutsider = '1300000000000000013';
  setDirectorEnv(listedOutsider);
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ authorId: listedOutsider, channelId: TEXT_OUT }));
  assert.equal(calls.length, 1);
  assert.equal(discord.calls.posts.length, 1);
  assert.equal(discord.calls.reactions.length, 0);
});

test('outra pessoa dentro da categoria segue o fluxo normal', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ authorId: OTHER }));
  assert.equal(calls.length, 1);
  assert.equal(discord.calls.posts.length, 1);
  assert.equal(discord.calls.reactions.length, 0);
});

test('mensagem de bot com ID da lista é ignorada', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ bot: true }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('mensagem de webhook com ID da lista é ignorada', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ webhook: true }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('tópico de fórum da categoria conta como dentro', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(mentionMessage({ channelId: THREAD_IN }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
});

test('isMentionDirectorChannel recusa tipos e pais fora da categoria', async () => {
  const { request } = makeDiscord();
  assert.equal(await isMentionDirectorChannel(TEXT_IN, CATEGORY, request), true);
  assert.equal(await isMentionDirectorChannel(TEXT_OUT, CATEGORY, request), false);
  assert.equal(await isMentionDirectorChannel(THREAD_IN, CATEGORY, request), true);
});

test('falha na consulta do canal resulta em reação, sem modelo', async () => {
  setDirectorEnv();
  const { calls, discord } = wire({ discord: makeDiscord({ failChannels: [TEXT_IN] }) });
  await handleMentionReply(mentionMessage());
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
});

test('falha de permissão na reação registra só o código e não chama o modelo', async () => {
  setDirectorEnv();
  const denied = new Error('forbidden');
  denied.status = 403;
  const { calls, discord } = wire({ discord: makeDiscord({ failReaction: denied }) });
  const errors = [];
  const orig = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await handleMentionReply(mentionMessage());
  } finally {
    console.error = orig;
  }
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.ok(errors.some((args) => args.some((a) => String(a) === '403')));
  assert.ok(!errors.some((args) => args.some((a) => typeof a === 'string' && a.includes('ajuda aqui'))));
});

test('reação com sucesso registra audit ok sem conteúdo nem segredo', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  const infos = [];
  const errors = [];
  const origInfo = audit.info;
  const origError = audit.error;
  audit.info = (meta) => { infos.push(meta); return null; };
  audit.error = (meta) => { errors.push(meta); return null; };
  try {
    await handleMentionReply(mentionMessage());
  } finally {
    audit.info = origInfo;
    audit.error = origError;
  }
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
  const forwarded = infos.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].outcome, 'ok');
  assert.equal(forwarded[0].channel_id, TEXT_IN);
  assert.equal(forwarded[0].message_id, MSG);
  assert.equal(forwarded[0].user_id, MEMBER);
  assert.equal(errors.filter((meta) => meta.event === 'mention_forwarded_to_director').length, 0);
  assert.ok(!JSON.stringify([...infos, ...errors]).includes('ajuda aqui'));
});

test('rejeição do PUT registra falha segura sem resposta automática nem modelo', async () => {
  setDirectorEnv();
  const denied = new Error('forbidden');
  denied.status = 403;
  const { calls, discord } = wire({ discord: makeDiscord({ failReaction: denied }) });
  const infos = [];
  const errors = [];
  const origInfo = audit.info;
  const origError = audit.error;
  const origConsole = console.error;
  const consoleErrors = [];
  audit.info = (meta) => { infos.push(meta); return null; };
  audit.error = (meta) => { errors.push(meta); return null; };
  console.error = (...args) => { consoleErrors.push(args); };
  try {
    await handleMentionReply(mentionMessage());
  } finally {
    audit.info = origInfo;
    audit.error = origError;
    console.error = origConsole;
  }
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  const okForwards = infos.filter((meta) => meta.event === 'mention_forwarded_to_director' && meta.outcome === 'ok');
  assert.equal(okForwards.length, 0);
  const failed = errors.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].channel_id, TEXT_IN);
  assert.equal(failed[0].message_id, MSG);
  assert.equal(failed[0].user_id, MEMBER);
  assert.equal(String(failed[0].error_code), '403');
  const blob = JSON.stringify([...infos, ...errors, ...consoleErrors]);
  assert.ok(!blob.includes('ajuda aqui'));
  assert.ok(!blob.includes('forbidden'));
});

const FREE_CODE_MARKER = 'SYNTH-FREE-CODE-9X7Q2';
const BAD_STATUS_MARKER = 'SYNTH-BAD-STATUS-9X7Q2';
const ERRMSG_MARKER = 'SYNTH-ERRMSG-9X7Q2';

async function runForwardWithRealSink(failReaction) {
  setDirectorEnv();
  const { calls, discord } = wire({ discord: makeDiscord({ failReaction }) });
  const infos = [];
  const errorMetas = [];
  const consoleErrors = [];
  const sinkLines = [];
  const realLogger = createAuditLogger();
  const origInfo = audit.info;
  const origError = audit.error;
  const origConsole = console.error;
  const origConsoleLog = console.log;
  console.log = (line) => { sinkLines.push(line); };
  audit.info = (meta) => { infos.push(meta); return realLogger.info(meta); };
  audit.error = (meta) => { errorMetas.push(meta); return realLogger.error(meta); };
  console.error = (...args) => { consoleErrors.push(args); sinkLines.push(args.join(' ')); };
  try {
    await handleMentionReply(mentionMessage());
  } finally {
    audit.info = origInfo;
    audit.error = origError;
    console.error = origConsole;
    console.log = origConsoleLog;
  }
  return { calls, discord, infos, errorMetas, consoleErrors, sinkLines };
}

function forwardedLines(sinkLines) {
  return sinkLines.filter((line) => line.includes('mention_forwarded_to_director'));
}

test('PUT 403 registra error_code 403 fechado, sem vazar nada (console + linha audit real)', async () => {
  const denied = new Error('forbidden');
  denied.status = 403;
  const { calls, discord, infos, errorMetas, consoleErrors, sinkLines } = await runForwardWithRealSink(denied);
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  assert.equal(infos.filter((meta) => meta.event === 'mention_forwarded_to_director' && meta.outcome === 'ok').length, 0);
  const failed = errorMetas.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].error_code, '403');
  const flatConsole = consoleErrors.flat().map(String);
  assert.ok(flatConsole.some((text) => text === '403'));
  const lines = forwardedLines(sinkLines);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('403'));
  const blob = JSON.stringify([...infos, ...errorMetas, ...consoleErrors, ...sinkLines]);
  assert.ok(!blob.includes('ajuda aqui'));
  assert.ok(!blob.includes('forbidden'));
});

test('erro sem status vira reaction_failed, sem vazar nada (console + linha audit real)', async () => {
  const { calls, discord, infos, errorMetas, consoleErrors, sinkLines } = await runForwardWithRealSink(new Error(ERRMSG_MARKER));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  assert.equal(infos.filter((meta) => meta.event === 'mention_forwarded_to_director' && meta.outcome === 'ok').length, 0);
  const failed = errorMetas.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].error_code, 'reaction_failed');
  const lines = forwardedLines(sinkLines);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('reaction_failed'));
  const blob = JSON.stringify([...infos, ...errorMetas, ...consoleErrors, ...sinkLines]);
  assert.ok(!blob.includes('ajuda aqui'));
  assert.ok(!blob.includes(ERRMSG_MARKER));
});

test('err.code com texto livre nunca atravessa o audit (console + linha audit real)', async () => {
  const err = new Error(ERRMSG_MARKER);
  err.code = FREE_CODE_MARKER;
  const { calls, discord, infos, errorMetas, consoleErrors, sinkLines } = await runForwardWithRealSink(err);
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  assert.equal(infos.filter((meta) => meta.event === 'mention_forwarded_to_director' && meta.outcome === 'ok').length, 0);
  const failed = errorMetas.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].error_code, 'reaction_failed');
  const lines = forwardedLines(sinkLines);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('reaction_failed'));
  const blob = JSON.stringify([...infos, ...errorMetas, ...consoleErrors, ...sinkLines]);
  assert.ok(!blob.includes(FREE_CODE_MARKER));
  assert.ok(!blob.includes(ERRMSG_MARKER));
  assert.ok(!blob.includes('ajuda aqui'));
});

test('err.status inválido com marcador vira reaction_failed (console + linha audit real)', async () => {
  const err = new Error(ERRMSG_MARKER);
  err.status = BAD_STATUS_MARKER;
  const { calls, discord, infos, errorMetas, consoleErrors, sinkLines } = await runForwardWithRealSink(err);
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  assert.equal(infos.filter((meta) => meta.event === 'mention_forwarded_to_director' && meta.outcome === 'ok').length, 0);
  const failed = errorMetas.filter((meta) => meta.event === 'mention_forwarded_to_director');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].error_code, 'reaction_failed');
  const lines = forwardedLines(sinkLines);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('reaction_failed'));
  const blob = JSON.stringify([...infos, ...errorMetas, ...consoleErrors, ...sinkLines]);
  assert.ok(!blob.includes(BAD_STATUS_MARKER));
  assert.ok(!blob.includes(ERRMSG_MARKER));
  assert.ok(!blob.includes('ajuda aqui'));
});

test('resposta a mensagem do Diretor conta como chamado (só reação, sem modelo)', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage());
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
  assert.ok(discord.calls.reactions[0].includes(encodeURIComponent('📨')));
});

test('resposta a webhook com outro nome não conta', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage({ ref: directorRef({ username: 'Outro Nome' }) }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('resposta a webhook de outra aplicação com o mesmo nome não conta', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage({
    ref: directorRef({ authorId: '19999999999999999', appId: '18888888888888888' }),
  }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('resposta a mensagem humana não conta', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage({
    ref: { id: DIRECTOR_MSG_ID, channel_id: TEXT_IN, author: { id: OTHER, username: 'humano' } },
  }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('resposta ao Diretor por autor fora da lista não conta', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage({ authorId: OTHER }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
});

test('menção e resposta ao Diretor juntas reagem uma vez só', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  await handleMentionReply(replyMessage({ withMention: true }));
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 1);
  assert.equal(discord.calls.appId, 0);
});

test('sem referenced_message não busca application_id e não conta', async () => {
  setDirectorEnv();
  const { calls, discord } = wire();
  const msg = replyMessage();
  delete msg.referenced_message;
  delete msg.message_reference;
  await handleMentionReply(msg);
  assert.equal(calls.length, 0);
  assert.equal(discord.calls.posts.length, 0);
  assert.equal(discord.calls.reactions.length, 0);
  assert.equal(discord.calls.appId, 0);
});

test('isReplyToDirectorMessage exige webhook, nome e application_id', () => {
  const base = replyMessage();
  assert.equal(isReplyToDirectorMessage(base, { appId: APP_ID }), true);
  assert.equal(isReplyToDirectorMessage(replyMessage({ ref: directorRef({ authorId: '19999999999999999' }) }), { appId: APP_ID }), true);
  assert.equal(isReplyToDirectorMessage(replyMessage({ ref: directorRef({ appId: null }) }), { appId: APP_ID }), false);
  assert.equal(isReplyToDirectorMessage(base, { appId: '18888888888888888' }), false);
});
