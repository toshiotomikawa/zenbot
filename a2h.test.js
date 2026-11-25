import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { sign as discordSign } from 'node:crypto';
import { verifyKeyMiddleware } from 'discord-interactions';
import { createA2hService, registerA2hRoutes, handleA2hInteraction } from './a2h.js';
import { verifyDecision } from './a2h-protocol.mjs';

const sf = n => String(n).repeat(18);
const credential = 'dummy-a2h-test-credential'.repeat(2);
function fixture(approverIds = [sf(3)]) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = { A2H_ENABLED: '1', A2H_GUILD_ID: sf(1), A2H_CHANNEL_ID: sf(2),
    A2H_APPROVER_IDS: approverIds.join(', '), APP_ID: sf(4), A2H_CLIENT_ID: 'test-client', A2H_API_KEY: credential,
    A2H_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let clock = Date.now();
  const calls = [];
  const request = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { json: async () => options.method === 'GET'
      ? { id: sf(2), guild_id: sf(1), type: 0 } : { id: sf(5) } };
  };
  const service = createA2hService({ env, request, now: () => clock });
  const body = { v: 1, id: randomBytes(32).toString('hex'), requester: 'test-client', summary: 'Ação de teste',
    created_at: clock, expires_at: clock + 5000 };
  const click = { type: 3, application_id: sf(4), guild_id: sf(1), channel_id: sf(2),
    member: { user: { id: sf(3) } }, message: { id: sf(5) }, data: { custom_id: `a2h:approved:${body.id}` } };
  return { env, service, body, click, calls, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), advance: ms => clock += ms, now: () => clock };
}
test('aprovação gera assinatura verificável e botões com menções restritas', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.create(f.body, f.body.requester), { status: 'pending' });
  assert.equal(f.service.interact(f.click).type, 7);
  assert.equal(verifyDecision(f.service.get(f.body.id, f.body.requester), f.body, f.publicKey), 'approved');
  assert.deepEqual(f.calls[1].options.body.allowed_mentions, { parse: [], users: [sf(3)], roles: [], replied_user: false });
  assert.equal(f.calls[1].options.body.components[0].components.length, 2);
});
test('recusa é assinada e primeiro clique vence', async () => {
  const f = fixture();
  await f.service.create(f.body, f.body.requester);
  f.service.interact({ ...f.click, data: { custom_id: `a2h:denied:${f.body.id}` } });
  f.service.interact(f.click);
  assert.equal(verifyDecision(f.service.get(f.body.id, f.body.requester), f.body, f.publicKey), 'denied');
});
test('clique de alguém que não é aprovador não decide', async () => {
  const f = fixture();
  await f.service.create(f.body, f.body.requester);
  assert.equal(f.service.interact({ ...f.click, member: { user: { id: sf(9) } } }).data.flags, 64);
  assert.deepEqual(f.service.get(f.body.id, f.body.requester), { status: 'pending' });
});
test('guild, aplicação, canal, mensagem ou bot incorretos não decidem', async () => {
  const f = fixture();
  await f.service.create(f.body, f.body.requester);
  for (const changed of [{ guild_id: sf(9) }, { channel_id: sf(9) }, { application_id: sf(9) },
    { message: { id: sf(9) } }, { member: { user: { id: sf(3), bot: true } } }]) {
    assert.equal(f.service.interact({ ...f.click, ...changed }).data.flags, 64);
    assert.deepEqual(f.service.get(f.body.id, f.body.requester), { status: 'pending' });
  }
});
test('expiração é assinada; clique tardio não aprova', async () => {
  const f = fixture();
  await f.service.create(f.body, f.body.requester);
  f.advance(5000);
  f.service.interact(f.click);
  assert.equal(verifyDecision(f.service.get(f.body.id, f.body.requester), f.body, f.publicKey, f.now()), 'expired');
});
test('pedido idempotente não reposta e alteração conflita', async () => {
  const f = fixture();
  await f.service.create(f.body, f.body.requester);
  await f.service.create({ ...f.body }, f.body.requester);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.service.create({ ...f.body, summary: 'Outra' }, f.body.requester), /request_conflict/);
});
test('identidade alheia não cria nem lê pedido', async () => {
  const f = fixture();
  await assert.rejects(f.service.create(f.body, 'other-client'), /invalid_request/);
  await f.service.create(f.body, f.body.requester);
  assert.throws(() => f.service.get(f.body.id, 'other-client'), /not_found/);
});
test('limite por identidade e reinício falham fechado', async () => {
  const f = fixture();
  for (let n = 0; n < 5; n++) await f.service.create({ ...f.body, id: randomBytes(32).toString('hex') }, f.body.requester);
  await assert.rejects(f.service.create(f.body, f.body.requester), /rate_limited/);
  const fresh = fixture();
  assert.throws(() => fresh.service.get(f.body.id, f.body.requester), /not_found/);
});
test('env desabilitado ou chave de tipo errado não ativa serviço', () => {
  const f = fixture();
  assert.equal(createA2hService({ env: {} }), null);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => createA2hService({ env: { ...f.env, A2H_SIGNING_PRIVATE_KEY: key } }), /invalid_a2h_config/);
});
test('chave PEM salva numa linha só ainda é aceita', () => {
  const f = fixture();
  const pem = f.env.A2H_SIGNING_PRIVATE_KEY;
  for (const flat of [pem.replace(/\n/g, ' '), pem.replace(/\n/g, ''), pem.replace(/\n/g, '\\n')])
    assert.ok(createA2hService({ env: { ...f.env, A2H_SIGNING_PRIVATE_KEY: flat } }));
});
test('envio incerto fica reservado sem nova postagem', async () => {
  const f = fixture();
  let calls = 0;
  const service = createA2hService({ env: f.env, request: async () => { calls++; throw new Error('transport_error'); } });
  await assert.rejects(service.create(f.body, f.body.requester), /delivery_failed/);
  await assert.rejects(service.create(f.body, f.body.requester), /delivery_failed/);
  assert.equal(calls, 1);
});
async function http(t, f) {
  const app = express();
  registerA2hRoutes(app, { env: f.env, service: f.service });
  const discordKeys = generateKeyPairSync('ed25519');
  const publicHex = discordKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  app.post('/interactions', verifyKeyMiddleware(publicHex), (req, res) => res.json(handleA2hInteraction(req.body)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, discordKeys };
}
test('HTTP autenticado + interação assinada pelo Discord + verificação local', async t => {
  const f = fixture();
  const { base, discordKeys } = await http(t, f);
  const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/actions/a2h/requests', { method: 'POST', headers, body: JSON.stringify(f.body) })).status, 200);
  const body = JSON.stringify(f.click);
  // A forged HTTP click fails before reaching the A2H approver check.
  assert.equal((await fetch(base + '/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  assert.deepEqual(f.service.get(f.body.id, f.body.requester), { status: 'pending' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = discordSign(null, Buffer.from(timestamp + body), discordKeys.privateKey).toString('hex');
  assert.equal((await fetch(base + '/interactions', { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp,
  } })).status, 200);
  const envelope = await fetch(base + `/actions/a2h/requests/${f.body.id}`, { headers }).then(r => r.json());
  assert.equal(verifyDecision(envelope, f.body, f.publicKey), 'approved');
});
test('HTTP sem credencial, duplicata, READ-only e corpo inválido falham sem vazamento', async t => {
  const f = fixture();
  const { base } = await http(t, f);
  const post = (token, body) => fetch(base + '/actions/a2h/requests', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body });
  assert.equal((await post('wrong', JSON.stringify(f.body))).status, 401);
  f.env.GPT_ACTIONS_READ_API_KEY = 'dummy-read-only'.repeat(4);
  assert.equal((await post(f.env.GPT_ACTIONS_READ_API_KEY, JSON.stringify(f.body))).status, 401);
  const malformed = await post(credential, '{"dummy":"private-input"');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes('private-input'), false);
  f.env.GPT_ACTIONS_READ_API_KEY = credential;
  assert.equal((await post(credential, JSON.stringify(f.body))).status, 401);
});

test('pedido notifica somente os aprovadores configurados, sem cargos ou everyone', async () => {
  const ids = [sf(3), sf(6)];
  const f = fixture(ids);
  f.body.summary = `Teste <@${sf(9)}> <@&${sf(8)}> @everyone`;
  await f.service.create(f.body, f.body.requester);
  const message = f.calls[1].options.body;
  assert.equal(message.content, ids.map(id => `<@${id}>`).join(' '));
  assert.deepEqual(message.allowed_mentions, { parse: [], users: ids, roles: [], replied_user: false });
});
test('decisão com servidor 3 segundos à frente é aceita', async () => {
  const f = fixture();
  const clientNow = f.now();
  f.body.expires_at = clientNow + 30000;
  await f.service.create(f.body, f.body.requester);
  f.advance(3000);
  f.service.interact(f.click);
  assert.equal(verifyDecision(f.service.get(f.body.id, f.body.requester), f.body, f.publicKey, clientNow), 'approved');
});
test('decisão com servidor 10 segundos à frente é recusada', async () => {
  const f = fixture();
  const clientNow = f.now();
  f.body.expires_at = clientNow + 30000;
  await f.service.create(f.body, f.body.requester);
  f.advance(10000);
  f.service.interact(f.click);
  assert.throws(() => verifyDecision(f.service.get(f.body.id, f.body.requester), f.body, f.publicKey, clientNow), /invalid_decision/);
});
