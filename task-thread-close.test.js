import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTaskThreadUpdate, reconcileTaskForum, scheduleTaskSweep, stopTaskSweep } from './task-thread-state.js';
import { createDiscordWriteService, readDiscordWriteConfig } from './mcp-discord-write.js';
import { createDiscordReadService, readDiscordReadConfig } from './mcp-discord-read.js';

const GUILD = '11111111111111111';
const PARENT = '22222222222222222';
const THREAD = '33333333333333333';
const OTHER_THREAD = '44444444444444444';
const HUMAN = '99999999999999999';
const BOT = '55555555555555555';
const OTHER_BOT = '55555555555555556';
const OPEN_TAG = '66666666666666666';
const DONE_TAG = '77777777777777777';
const EXTRA_TAG = '88888888888888888';
const DOING_TAG = '88888888888888881';
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
const TAGS = [
  { id: OPEN_TAG, name: 'Aberto' },
  { id: DOING_TAG, name: 'Em andamento' },
  { id: DONE_TAG, name: 'Concluído' },
  { id: EXTRA_TAG, name: 'Prioridade' },
];

const response = (body) => ({ json: async () => body });
// Snowflake cujo timestamp é `ms` (para entradas recentes do audit log).
const snowflakeAt = (ms) => String((BigInt(ms - 1420070400000) << 22n) + 1n);
// `archive_timestamp` do Discord é ISO 8601.
const archivedAgo = (ms, now) => new Date(now - ms).toISOString();
const manualEntry = (ms, userId = HUMAN, threadId = THREAD) => ({
  id: snowflakeAt(ms),
  action_type: 111,
  target_id: threadId,
  user_id: userId,
  changes: [{ key: 'archived', old_value: false, new_value: true }],
});
const reopenEntry = (ms, key = 'archived', userId = HUMAN) => ({
  id: snowflakeAt(ms), action_type: 111, target_id: THREAD, user_id: userId,
  changes: [{ key, old_value: true, new_value: false }],
});

function harness({ thread = {}, extraThreads = [], auditEntries = [], auditUsers, auditForbidden = false,
  activeThreads = null, archivedPages = null, failPatch = null } = {}) {
  const calls = [];
  const entries = [];
  const sleeps = [];
  const threadState = (extra = {}) => ({
    id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    applied_tags: [OPEN_TAG],
    thread_metadata: { archived: false, locked: false },
    ...extra,
  });
  const states = new Map([[THREAD, threadState(thread)]]);
  for (const extra of extraThreads) states.set(extra.id, threadState(extra));
  const snapshot = (state) => ({ ...state, applied_tags: [...state.applied_tags],
    thread_metadata: { ...state.thread_metadata } });
  let patchCount = 0;
  const request = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ endpoint, method, body: options.body });
    if (endpoint === `channels/${PARENT}` && method === 'GET') {
      return response({ id: PARENT, guild_id: GUILD, type: 15, available_tags: TAGS });
    }
    const threadId = /^channels\/(\d+)$/.exec(endpoint)?.[1];
    if (threadId && states.has(threadId)) {
      const current = states.get(threadId);
      if (method === 'PATCH') {
        patchCount += 1;
        if (typeof failPatch === 'function') {
          const failure = failPatch(patchCount, options.body);
          if (failure) throw failure;
        }
        const body = options.body ?? {};
        // Discord recusa (HTTP 400, código 50083) PATCH que edita um tópico já
        // arquivado com qualquer campo além de `archived: false`.
        if (current.thread_metadata.archived && body.archived !== false) {
          throw Object.assign(new Error('Thread is archived'), { status: 400, discord_code: 50083 });
        }
        if ('archived' in body) current.thread_metadata.archived = body.archived;
        if ('locked' in body) current.thread_metadata.locked = body.locked;
        if ('applied_tags' in body) current.applied_tags = [...body.applied_tags];
      }
      return response(snapshot(current));
    }
    if (endpoint === 'users/@me' && method === 'GET') return response({ id: BOT, bot: true });
    if (endpoint.startsWith(`guilds/${GUILD}/audit-logs`) && method === 'GET') {
      if (auditForbidden) throw Object.assign(new Error('forbidden'), { status: 403 });
      return response({ audit_log_entries: auditEntries, users: auditUsers ?? [{ id: HUMAN }] });
    }
    if (endpoint === `guilds/${GUILD}/threads/active` && method === 'GET') {
      return response({ threads: activeThreads ?? [] });
    }
    if (endpoint.startsWith(`channels/${PARENT}/threads/archived/public`) && method === 'GET') {
      if (!archivedPages) return response({ threads: [], has_more: false });
      const url = new URL(endpoint, 'https://discord.com');
      const before = url.searchParams.get('before');
      const page = before ? archivedPages[1] : archivedPages[0];
      return response(page);
    }
    throw new Error(`unexpected endpoint: ${method} ${endpoint}`);
  };
  const readConfig = readDiscordReadConfig(ENV);
  const config = readDiscordWriteConfig(ENV, readConfig);
  const service = createDiscordWriteService({ config, request,
    readService: createDiscordReadService({ config: readConfig, request }), logger: { info() {} } });
  const logger = { info(meta) { entries.push({ level: 'info', ...meta }); }, error(meta) { entries.push({ level: 'error', ...meta }); } };
  const options = { env: ENV, request, logger, sleep: async (ms) => { sleeps.push(ms); } };
  const patches = () => calls.filter((call) => call.method === 'PATCH');
  const callsTo = (needle) => calls.filter((call) => call.endpoint.includes(needle)).length;
  return { service, options, calls, entries, sleeps, patches, callsTo, states,
    get state() { return states.get(THREAD); } };
}

test('fechamento manual reabre, etiqueta e fecha em dois PATCH', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG, EXTRA_TAG],
      thread_metadata: { archived: true, locked: false, archive_timestamp: archivedAgo(60_000, now) } },
    auditEntries: [manualEntry(now - 60_000)],
  });
  const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.equal(result.status, 'ok');
  assert.equal(result.changed, true);
  assert.equal(result.action, 'manual_close');
  assert.deepEqual(result.applied_tags, [EXTRA_TAG, DONE_TAG]);
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false, locked: false, applied_tags: [EXTRA_TAG, DONE_TAG] },
    { archived: true, locked: true },
  ]);
  assert.deepEqual(h.state.applied_tags, [EXTRA_TAG, DONE_TAG]);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true, archive_timestamp: archivedAgo(60_000, now) });
  const blob = JSON.stringify(h.calls);
  assert.ok(!blob.includes('Prioridade'));
});

test('falha no fechamento final não desfaz o Concluído e a próxima passada corrige', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    auditEntries: [manualEntry(now - 20_000)],
    failPatch: (count) => (count === 2 ? Object.assign(new Error('forbidden'), { status: 403 }) : null),
  });
  const failed = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.equal(failed.status, 'error');
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false, locked: false, applied_tags: [DONE_TAG] },
    { archived: true, locked: true },
  ]);
  // Estado intermediário recuperável: Concluído aberto, nunca aberto sem Concluído.
  assert.deepEqual(h.state.applied_tags, [DONE_TAG]);
  assert.equal(h.state.thread_metadata.archived, false);
  const retried = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now: now + 1_000 });
  assert.equal(retried.status, 'ok');
  assert.equal(retried.action, 'completed_close');
  assert.equal(h.state.thread_metadata.archived, true);
  assert.equal(h.state.thread_metadata.locked, true);
});

test('arquivamento automático reabre e mantém a etiqueta atual', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG],
      thread_metadata: { archived: true, locked: false, archive_timestamp: archivedAgo(30_000, now) } },
    auditEntries: [],
  });
  const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'auto_reopen');
  assert.deepEqual(h.patches().map((call) => call.body), [{ archived: false }]);
  assert.deepEqual(h.state.applied_tags, [OPEN_TAG]);
  assert.equal(h.state.thread_metadata.archived, false);
});

test('evidência manual antiga conta como automático', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [DOING_TAG],
      thread_metadata: { archived: true, locked: false, archive_timestamp: archivedAgo(30_000, now) } },
    auditEntries: [manualEntry(now - 60 * 60 * 1000)],
  });
  const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.equal(result.action, 'auto_reopen');
  assert.deepEqual(h.state.applied_tags, [DOING_TAG]);
});

test('arquivamento antigo sem evidência só registra, nunca reabre no ao vivo', async () => {
  const now = Date.now();
  for (const archive_timestamp of [archivedAgo(60 * 60 * 1000, now), undefined, 'invalido', 0]) {
    const h = harness({
      thread: { applied_tags: [OPEN_TAG],
        thread_metadata: { archived: true, locked: false, archive_timestamp } },
      auditEntries: [],
    });
    const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
    assert.equal(result.status, 'ok');
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'no_manual_evidence');
    assert.equal(h.patches().length, 0);
    assert.equal(h.state.thread_metadata.archived, true);
  }
});

test('arquivamento antigo pelo evento ao vivo registra skipped e não reabre', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG],
      thread_metadata: { archived: true, locked: false, archive_timestamp: archivedAgo(3 * 60 * 60 * 1000, now) } },
    auditEntries: [],
  });
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } };
  await handleTaskThreadUpdate(event, { ...h.options, now });
  assert.equal(h.patches().length, 0);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].event, 'task_thread_auto_reopen');
  assert.equal(h.entries[0].outcome, 'skipped');
  assert.equal(h.entries[0].error_code, 'no_manual_evidence');
  assert.equal(h.state.thread_metadata.archived, true);
});

test('autor bot no audit log conta como arquivamento automático', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG],
      thread_metadata: { archived: true, locked: false, archive_timestamp: archivedAgo(30_000, now) } },
    auditEntries: [manualEntry(now - 20_000, OTHER_BOT)],
    auditUsers: [{ id: OTHER_BOT, bot: true }, { id: HUMAN }],
  });
  const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.equal(result.action, 'auto_reopen');
  assert.deepEqual(h.patches().map((call) => call.body), [{ archived: false }]);
  assert.deepEqual(h.state.applied_tags, [OPEN_TAG]);
});

test('Concluído pela interface fecha e tranca via evento', async () => {
  const h = harness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: false, locked: false } } });
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, applied_tags: [DONE_TAG] };
  await handleTaskThreadUpdate(event, h.options);
  assert.deepEqual(h.patches().map((call) => call.body), [{ archived: true, locked: true }]);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].event, 'task_thread_completed_close');
  assert.equal(h.entries[0].outcome, 'ok');
  assert.equal(h.entries[0].thread_id, THREAD);
});

test('reabertura humana troca a etiqueta e eventos repetidos não fecham', async () => {
  const now = Date.now();
  for (const [key, metadata] of [
    ['archived', { archived: false, locked: true }],
    ['locked', { archived: true, locked: false }],
  ]) {
    const h = harness({ thread: { applied_tags: [DONE_TAG, EXTRA_TAG], thread_metadata: metadata },
      auditEntries: [reopenEntry(now - 1000, key)] });
    const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, applied_tags: [DONE_TAG], thread_metadata: metadata };
    await handleTaskThreadUpdate(event, { ...h.options, now });
    await handleTaskThreadUpdate(event, { ...h.options, now });
    assert.deepEqual(h.patches().map((call) => call.body), [{ archived: false, locked: false, applied_tags: [EXTRA_TAG, DOING_TAG] }]);
    assert.deepEqual(h.state.thread_metadata, { archived: false, locked: false });
    assert.equal(h.entries[0].event, 'task_thread_manual_reopen');
  }
});

test('reabertura por bot ou evidência humana substituída não muda Concluído', async () => {
  const now = Date.now();
  for (const entries of [
    [reopenEntry(now - 1000, 'archived', OTHER_BOT)],
    [reopenEntry(now - 2000), manualEntry(now - 1000, BOT)],
  ]) {
    const h = harness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: false, locked: false } },
      auditEntries: entries, auditUsers: [{ id: HUMAN }, { id: OTHER_BOT, bot: true }, { id: BOT, bot: true }] });
    const result = await h.service.reconcileTaskThread(THREAD, { now });
    assert.equal(result.action, 'completed_close');
    assert.deepEqual(h.state.applied_tags, [DONE_TAG]);
    assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
  }
});

test('auditoria indisponível fecha Concluído e registra verificação não realizada', async () => {
  for (const mode of ['live', 'sweep']) {
    const h = harness({ thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: false, locked: false } },
      auditForbidden: true, activeThreads: [{ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11 }] });
    if (mode === 'live') {
      await handleTaskThreadUpdate({ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
        applied_tags: [DONE_TAG], thread_metadata: { archived: false, locked: false } }, h.options);
    } else {
      const result = await reconcileTaskForum(h.options);
      assert.equal(result.fixed, 1);
    }
    assert.deepEqual(h.patches().map((call) => call.body), [{ archived: true, locked: true }]);
    assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
    assert.ok(h.entries.some((entry) => entry.event === 'task_thread_reopen_check'
      && entry.outcome === 'skipped' && entry.error_code === 'audit_log_unavailable'));
  }
});

test('fechamento manual via evento aplica etiqueta e registra manual_close', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    auditEntries: [manualEntry(now - 30_000)],
  });
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } };
  await handleTaskThreadUpdate(event, { ...h.options, now });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].event, 'task_thread_manual_close');
  assert.equal(h.entries[0].outcome, 'ok');
  assert.deepEqual(h.state.applied_tags, [DONE_TAG]);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
});

test('evento gerado pela própria Botélia não cria laço', async () => {
  const h = harness({
    thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: true } },
  });
  // Evento terminal com metadados: ignorado antes de qualquer request.
  await handleTaskThreadUpdate({ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    thread_metadata: { archived: true, locked: true } }, h.options);
  assert.equal(h.calls.length, 0);
  // Evento parcial do próprio fechamento: releitura confirma terminal, sem PATCH.
  await handleTaskThreadUpdate({ id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    applied_tags: [DONE_TAG] }, h.options);
  assert.ok(h.patches().length === 0);
  assert.deepEqual(h.entries, []);
});

test('auditoria sem permissão registra audit_log_unavailable sem tocar no tópico', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    auditForbidden: true,
  });
  const result = await h.service.reconcileTaskThread(THREAD, { mode: 'live', now });
  assert.deepEqual([result.status, result.error], ['error', 'audit_log_unavailable']);
  assert.equal(h.patches().length, 0);
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, thread_metadata: { archived: true, locked: false } };
  await handleTaskThreadUpdate(event, { ...h.options, now });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].outcome, 'error');
  assert.equal(h.entries[0].error_code, 'audit_log_unavailable');
  assert.equal(h.patches().length, 0);
});

test('varredura reabre, fecha e tranca tópico antigo Concluído destrancado', async () => {
  const archivedThread = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11 };
  const h = harness({
    thread: { applied_tags: [DONE_TAG, EXTRA_TAG], thread_metadata: { archived: true, locked: false } },
    activeThreads: [],
    archivedPages: [{ threads: [archivedThread], has_more: false }],
  });
  const result = await reconcileTaskForum(h.options);
  assert.equal(result.status, 'ok');
  assert.equal(result.fixed, 1);
  // Reabrir preserva etiquetas; só então o Discord aceita arquivar e trancar.
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false },
    { archived: true, locked: true },
  ]);
  assert.deepEqual(h.state.applied_tags, [DONE_TAG, EXTRA_TAG]);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
  assert.ok(h.entries.some((entry) => entry.thread_id === THREAD && entry.outcome === 'ok'));
});

test('o request simulado recusa PATCH em tópico arquivado como o Discord (50083)', async () => {
  const h = harness({ thread: { thread_metadata: { archived: true, locked: false } } });
  const patch = (body) => h.options.request(`channels/${THREAD}`, { method: 'PATCH', body, sensitiveErrors: true });
  for (const body of [{ archived: true, locked: true }, { applied_tags: [DONE_TAG] }, { archived: true, locked: false }]) {
    await assert.rejects(patch(body), (error) => error.status === 400 && error.discord_code === 50083, JSON.stringify(body));
  }
  // Desarquivar é a única edição aceita, mesmo acompanhada de outras.
  await patch({ archived: false });
  await patch({ archived: false, locked: false, applied_tags: [DONE_TAG] });
  assert.equal(h.state.thread_metadata.archived, false);
});

test('Concluído arquivado e destrancado reabre, fecha e tranca ao vivo, idempotente', async () => {
  const h = harness({
    thread: { applied_tags: [DONE_TAG, EXTRA_TAG], thread_metadata: { archived: true, locked: false } },
  });
  const first = await h.service.reconcileTaskThread(THREAD, { mode: 'live' });
  assert.equal(first.status, 'ok');
  assert.equal(first.action, 'completed_close');
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false },
    { archived: true, locked: true },
  ]);
  assert.deepEqual(h.state.applied_tags, [DONE_TAG, EXTRA_TAG]);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
  // Terminal: nova passada não escreve (nem pelo evento que a própria
  // Botélia gera ao arquivar).
  const again = await h.service.reconcileTaskThread(THREAD, { mode: 'live' });
  assert.deepEqual([again.status, again.action, again.changed], ['ok', 'noop', false]);
  assert.equal(h.patches().length, 2);
});

test('recusa do Discord no fechamento vira código estável e a próxima passada corrige', async () => {
  const h = harness({
    thread: { applied_tags: [DONE_TAG, EXTRA_TAG], thread_metadata: { archived: true, locked: false } },
    failPatch: (count, body) => (count === 2 && body.archived === true
      ? Object.assign(new Error('Thread is archived'), { status: 400, discord_code: 50083 }) : null),
  });
  const refused = await h.service.reconcileTaskThread(THREAD, { mode: 'live' });
  assert.deepEqual([refused.status, refused.error], ['error', 'thread_archived_edit_refused']);
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false },
    { archived: true, locked: true },
  ]);
  // Estado recuperável: Concluído aberto, etiquetas intactas.
  assert.deepEqual(h.state.applied_tags, [DONE_TAG, EXTRA_TAG]);
  assert.deepEqual(h.state.thread_metadata, { archived: false, locked: false });
  const retried = await h.service.reconcileTaskThread(THREAD, { mode: 'sweep' });
  assert.deepEqual([retried.status, retried.action], ['ok', 'completed_close']);
  assert.deepEqual(h.patches().slice(2).map((call) => call.body), [{ archived: true, locked: true }]);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
});

test('varredura sem evidência manual só registra, sem reabrir tópico antigo', async () => {
  const archivedThread = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11 };
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    auditEntries: [],
    activeThreads: [],
    archivedPages: [{ threads: [archivedThread], has_more: false }],
  });
  const result = await reconcileTaskForum(h.options);
  assert.equal(result.fixed, 0);
  assert.equal(h.patches().length, 0);
  assert.ok(h.entries.some((entry) => entry.thread_id === THREAD && entry.outcome === 'skipped'));
  assert.equal(h.state.thread_metadata.archived, true);
});

test('varredura pagina os arquivados', async () => {
  const first = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11,
    thread_metadata: { archive_timestamp: '2026-09-01T00:00:00.000Z' } };
  const h = harness({
    thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: true } },
    activeThreads: [],
    archivedPages: [
      { threads: [first], has_more: true },
      { threads: [], has_more: false },
    ],
  });
  await reconcileTaskForum(h.options);
  const archivedCalls = h.calls.filter((call) => call.endpoint.includes('/archived/public'));
  assert.equal(archivedCalls.length, 2);
  assert.ok(archivedCalls[1].endpoint.includes('before='));
});

test('varredura pausa em 429 e repete uma vez', async () => {
  const archivedThread = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11 };
  const h = harness({
    thread: { applied_tags: [DONE_TAG], thread_metadata: { archived: true, locked: false } },
    activeThreads: [],
    archivedPages: [{ threads: [archivedThread], has_more: false }],
    failPatch: (count) => (count === 1 ? Object.assign(new Error('rate limited'), { status: 429, retry_after: 0 }) : null),
  });
  const result = await reconcileTaskForum(h.options);
  assert.equal(result.fixed, 1);
  assert.deepEqual(h.patches().map((call) => call.body), [
    { archived: false },
    { archived: false },
    { archived: true, locked: true },
  ]);
  assert.ok(h.sleeps.length >= 1);
  assert.deepEqual(h.state.thread_metadata, { archived: true, locked: true });
});

test('users/@me é buscado uma vez por varredura, mesmo com vários tópicos', async () => {
  const archived = [OTHER_THREAD, THREAD].map((id) => ({ id, guild_id: GUILD, parent_id: PARENT, type: 11 }));
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    extraThreads: [{ id: OTHER_THREAD, applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } }],
    activeThreads: [],
    archivedPages: [{ threads: archived, has_more: false }],
  });
  const result = await reconcileTaskForum(h.options);
  assert.equal(result.checked, 2);
  assert.equal(h.callsTo('users/@me'), 1);
});

test('cada READY roda uma varredura e o timer nunca duplica', async () => {
  let intervals = 0;
  const cleared = [];
  const setIntervalImpl = (fn, ms) => { intervals += 1; return { fn, ms, unref() {} }; };
  const runs = [];
  const runner = () => { runs.push(runs.length); return Promise.resolve(); };
  const options = { setIntervalImpl, clearIntervalImpl: (timer) => cleared.push(timer) };
  for (let i = 0; i < 3; i += 1) scheduleTaskSweep(runner, options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 3);
  assert.equal(intervals, 1);
  assert.equal(stopTaskSweep(options), true);
  assert.equal(stopTaskSweep(options), false);
  assert.equal(cleared.length, 1);
  scheduleTaskSweep(runner, options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 4);
  assert.equal(intervals, 2);
  assert.equal(stopTaskSweep(options), true);
});

test('falha da varredura agendada não sobe nem derruba o processo', async () => {
  const setIntervalImpl = () => ({ unref() {} });
  scheduleTaskSweep(() => Promise.reject(new Error('UNTRUSTED')), { setIntervalImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopTaskSweep({ clearIntervalImpl: () => {} }), true);
});

test('logs contêm só metadados', async () => {
  const now = Date.now();
  const h = harness({
    thread: { applied_tags: [OPEN_TAG], thread_metadata: { archived: true, locked: false } },
    auditEntries: [manualEntry(now - 10_000)],
  });
  const event = { id: THREAD, guild_id: GUILD, parent_id: PARENT, type: 11, thread_metadata: { archived: true, locked: false } };
  await handleTaskThreadUpdate(event, { ...h.options, now });
  const blob = JSON.stringify(h.entries);
  assert.ok(!blob.includes('Prioridade'));
  for (const entry of h.entries) {
    assert.ok(entry.thread_id === THREAD);
    assert.ok(['ok', 'error', 'skipped', 'capped'].includes(entry.outcome));
  }
});
