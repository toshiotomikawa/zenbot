import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubEventsProcessor } from './github-repo-events.js';
import { completionLinks, createTaskPrCompletion, scheduleTaskReport, TASK_REPORT_CHANNEL } from './task-pr-completion.js';

const guild = '11111111111111111', forum = '22222222222222222';
const first = '33333333333333333', second = '44444444444444444';
const done = '77777777777777777', open = '66666666666666666';
const reportChannel = '1300000000000000099';
const repo = 'example/repo';
const link = id => `https://discord.com/channels/${guild}/${id}`;
function harness({ completed = false, stale = false, prs = [], empty = false, foreign = false } = {}) {
  const env = { MCP_DISCORD_READ_ENABLED: '1', MCP_DISCORD_GUILD_IDS: guild,
    MCP_DISCORD_PARENT_CHANNEL_IDS: forum, MCP_DISCORD_WRITE_ENABLED: '1',
    MCP_DISCORD_WRITE_GUILD_IDS: guild, MCP_DISCORD_WRITE_PARENT_CHANNEL_IDS: forum,
    MCP_DISCORD_WRITE_REPOS: repo, TASK_PR_REPO: repo, TASK_REPORT_CHANNEL_ID: reportChannel,
    DISCORD_TOKEN: 'offline-fixture' };
  const calls = [], logs = [];
  const states = new Map([first, second].map(id => [id, { id, guild_id: guild, parent_id: foreign ? second : forum,
    type: 11, applied_tags: [completed ? done : open], thread_metadata: { archived: completed, locked: completed } }]));
  const request = async (endpoint, options = {}) => {
    calls.push({ endpoint, ...options });
    let body;
    if (endpoint === `channels/${forum}`) body = { id: forum, guild_id: guild, type: 15,
      available_tags: [{ id: done, name: 'Concluído' }, { id: open, name: 'Aberto' }] };
    else if (endpoint === `channels/${reportChannel}`) body = { id: reportChannel, guild_id: guild, type: 0 };
    else if (endpoint.endsWith('/threads/active')) body = { threads: empty ? [] : [...states.values()] };
    else if (endpoint.includes('/threads/archived/')) body = { threads: [], has_more: false };
    else if (endpoint.endsWith('/messages?limit=1')) body = [{ timestamp: new Date(Date.now() - (stale ? 8 : 1) * 86400000).toISOString() }];
    else if (endpoint.endsWith('/messages')) body = { id: '99999999999999999' };
    else {
      const state = states.get(endpoint.split('/')[1]);
      assert.ok(state, endpoint);
      if (options.method === 'PATCH') {
        if (options.body.applied_tags) state.applied_tags = options.body.applied_tags;
        for (const flag of ['archived', 'locked']) if (flag in options.body) state.thread_metadata[flag] = options.body[flag];
      }
      body = structuredClone(state);
    }
    return { json: async () => body };
  };
  const service = createTaskPrCompletion({ env, request, logger: { info: entry => logs.push(entry) },
    fetchImpl: async () => ({ ok: true, json: async () => prs }) });
  const event = body => ({ repository: { full_name: repo }, action: 'closed', pull_request: { merged: true, number: 42, body } });
  return { service, calls, logs, states, event, env, request };
}

test('parser só aceita Conclui: no início exato da linha', () => {
  assert.deepEqual(completionLinks(`Relacionado: ${link(first)}\n Conclui: ${link(first)}\nTópico: nenhum`), []);
  assert.equal(completionLinks(`Conclui: ${link(first)}\r\nConclui: ${link(first)}`).length, 1);
});
for (const count of [1, 2]) test(`merge com ${count} links posta antes de etiquetar e fecha; replay não escreve`, async () => {
  const h = harness();
  const event = h.event([first, second].slice(0, count).map(id => `Conclui: ${link(id)}`).join('\n'));
  await h.service.handleMerge(event);
  const writes = h.calls.filter(c => c.method !== 'GET');
  assert.equal(writes.length, count * 3);
  for (let i = 0; i < count; i++) {
    assert.equal(writes[i * 3].method, 'POST');
    assert.equal(writes[i * 3].body.content, 'Concluído pela PR #42 (https://github.com/example/repo/pull/42).');
    assert.deepEqual(writes[i * 3].body.allowed_mentions, { parse: [] });
    assert.deepEqual(writes[i * 3 + 2].body, { archived: true, locked: true });
  }
  await h.service.handleMerge(event);
  assert.equal(h.calls.filter(c => c.method !== 'GET').length, writes.length);
});
test('fechada sem merge, outro repo e ausência não escrevem', async () => {
  const h = harness();
  const event = h.event(`Conclui: ${link(first)}`); event.pull_request.merged = false;
  await h.service.handleMerge(event);
  await h.service.handleMerge({ ...h.event(`Conclui: ${link(first)}`), repository: { full_name: 'a/b' } });
  await h.service.handleMerge(h.event('Tópico: nenhum'));
  assert.equal(h.calls.length, 0);
});
test('link inválido, outra guild e outro fórum ignorados com audit', async () => {
  const h = harness({ foreign: true });
  await h.service.handleMerge(h.event(`Conclui: inválido\nConclui: https://discord.com/channels/99999999999999999/${first}\nConclui: ${link(first)}`));
  assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(h.logs.length, 3);
  assert.ok(h.logs.every(l => l.outcome === 'ignored'));
});
test('já concluído não escreve', async () => {
  const h = harness({ completed: true });
  await h.service.handleMerge(h.event(`Conclui: ${link(first)}`));
  assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0);
});
test('entregas concorrentes para o mesmo tópico usam a mesma trava e postam uma vez', async () => {
  const h = harness();
  const event = h.event(`Conclui: ${link(first)}`);
  await Promise.all([h.service.handleMerge(event), h.service.handleMerge(event)]);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 2);
});
test('gate desabilitado não cria serviço nem acessa rede', () => {
  assert.equal(createTaskPrCompletion({ env: {}, request: () => assert.fail('rede'), fetchImpl: () => assert.fail('rede') }), null);
});
test('varredura vazia e tópicos recentes não postam', async () => {
  for (const empty of [true, false]) {
    const h = harness({ empty });
    assert.deepEqual(await h.service.report(), { posted: 0, items: 0 });
  }
});
test('varredura lista merge pendente e inatividade, exclui concluídos', async () => {
  const h = harness({ stale: true, prs: [{ merged_at: '2026-10-01', body: `Conclui: ${link(first)}` }] });
  const result = await h.service.report();
  assert.equal(result.items, 2);
  const post = h.calls.find(c => c.method === 'POST');
  assert.match(post.body.content, /PR mergeada pendente/);
  assert.match(post.body.content, /sem mensagem há mais de 7 dias/);
  assert.match(post.body.content, new RegExp(second));
  const completed = harness({ completed: true, stale: true });
  assert.equal((await completed.service.report()).posted, 0);
});
test('PR mergeada pendente aparece mesmo com mensagem recente; PR sem merge e Relacionado não aparecem', async () => {
  const h = harness({ prs: [
    { merged_at: '2026-10-01', body: `Conclui: ${link(first)}\nRelacionado: ${link(second)}` },
    { merged_at: null, body: `Conclui: ${link(second)}` },
  ] });
  assert.equal((await h.service.report()).items, 1);
  const content = h.calls.find(c => c.method === 'POST').body.content;
  assert.ok(content.includes(first));
  assert.ok(!content.includes(second));
  assert.ok(!content.includes('sem mensagem'));
});
test('horário padrão São Paulo, uma execução por dia e horário configurável', async () => {
  let tick, calls = 0;
  let date = new Date('2026-10-06T12:00:00Z');
  scheduleTaskReport({ report: async () => { calls++; } }, { env: {}, now: () => date,
    setIntervalImpl: fn => { tick = fn; return {}; } });
  await tick(); await tick(); assert.equal(calls, 1);
  date = new Date('2026-10-07T12:00:00Z'); await tick(); assert.equal(calls, 2);
  scheduleTaskReport({ report: async () => { calls++; } }, { env: { TASK_REPORT_TIME: '10:00' }, now: () => date, setIntervalImpl: () => ({}) });
  assert.equal(calls, 2);
});

test('webhook conclui tópicos sem feed e replay após redeploy não escreve', async () => {
  const h = harness();
  const delivery = { eventName: 'pull_request', deliveryId: '11111111-2222-4333-8444-555555555555',
    body: h.event(`Conclui: ${link(first)}\nConclui: ${link(second)}`) };
  const processor = () => createGithubEventsProcessor({ env: h.env, discordRequest: h.request,
    taskCompletion: createTaskPrCompletion({ env: h.env, request: h.request, logger: { info() {} } }),
    configOverride: { valid: true, allowlist: [repo.toLowerCase()] } });
  assert.equal((await processor().processDelivery(delivery)).status, 200);
  const writes = h.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 6);
  for (const id of [first, second]) {
    assert.deepEqual(h.states.get(id).applied_tags, [done]);
    assert.deepEqual(h.states.get(id).thread_metadata, { archived: true, locked: true });
  }
  assert.ok(h.calls.every(call => !call.endpoint.includes('1300000000000000098')));
  // A fresh processor and completion service have no local delivery cache.
  assert.equal((await processor().processDelivery(delivery)).status, 200);
  assert.equal(h.calls.filter(call => call.method !== 'GET').length, writes.length);
});
