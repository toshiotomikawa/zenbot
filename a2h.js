import { createPrivateKey, sign, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { DISCORD_AGENT_IDENTITIES, matchDiscordAgentIdentity, hasDuplicateDiscordAgentKeys } from './discord-agent-identities.js';
import { validRequest, decisionBytes, REQUEST_FIELDS } from './a2h-protocol.mjs';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const sameKey = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const escapeMarkdown = value => value.replace(/([\\`*_{}\[\]()<>#+.!|~\-])/g, '\\$1');
// Painéis de secrets podem salvar o PEM numa linha só; refaz as quebras antes de ler a chave.
export function normalizePem(raw) {
  const text = String(raw ?? '').trim().replace(/\\n/g, '\n');
  const match = text.match(/^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, '');
  return `-----BEGIN ${match[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${match[1]}-----\n`;
}

export function createA2hService({ env, request, now = Date.now }) {
  if (env.A2H_ENABLED !== '1') return null;
  const approvers = (env.A2H_APPROVER_IDS ?? '').split(',').map(s => s.trim());
  if (!snowflake(env.A2H_GUILD_ID) || !snowflake(env.A2H_CHANNEL_ID)
    || !approvers.length || !approvers.every(snowflake) || !snowflake(env.APP_ID)) throw new Error('invalid_a2h_config');
  const key = createPrivateKey(normalizePem(env.A2H_SIGNING_PRIVATE_KEY));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('invalid_a2h_config');
  const entries = new Map();
  function finish(entry, decision) {
    if (!entry.envelope) {
      const payload = { ...entry.request, decision, decided_at: now() };
      entry.envelope = { payload, signature: sign(null, decisionBytes(payload), key).toString('base64url') };
    }
    return entry.envelope;
  }
  function status(entry) {
    if (entry.failed) throw new Error('delivery_failed');
    if (now() >= entry.request.expires_at) return finish(entry, 'expired');
    return entry.envelope ?? { status: 'pending' };
  }
  async function create(body, identity) {
    if (!validRequest(body) || body.requester !== identity || body.created_at > now() + 5000
      || now() - body.created_at > 30000 || body.expires_at <= now()) throw new Error('invalid_request');
    const previous = entries.get(body.id);
    if (previous) {
      if (!REQUEST_FIELDS.every(k => body[k] === previous.request[k])) throw new Error('request_conflict');
      return status(previous);
    }
    for (const [id, entry] of entries) if (now() > entry.request.expires_at + 60000) entries.delete(id);
    if (entries.size >= 1000 || [...entries.values()].filter(e => e.request.requester === identity
      && e.request.expires_at > now()).length >= 5) throw new Error('rate_limited');
    const entry = { request: Object.freeze({ ...body }) };
    entries.set(body.id, entry); // Reserve before REST; ambiguous sends are never repeated.
    try {
      const channel = await request(`channels/${env.A2H_CHANNEL_ID}`, { method: 'GET', sensitiveErrors: true,
        signal: AbortSignal.timeout(10000) }).then(r => r.json());
      if (channel.id !== env.A2H_CHANNEL_ID || channel.guild_id !== env.A2H_GUILD_ID || channel.type !== 0) throw new Error();
      const message = await request(`channels/${env.A2H_CHANNEL_ID}/messages`, {
        method: 'POST', sensitiveErrors: true, signal: AbortSignal.timeout(10000), body: {
          content: approvers.map(id => `<@${id}>`).join(' '),
          allowed_mentions: { parse: [], users: approvers, roles: [], replied_user: false },
          embeds: [{ title: 'Autorização A2H', fields: [
            { name: 'Quem pede', value: escapeMarkdown(body.requester) },
            { name: 'Resumo exato', value: escapeMarkdown(body.summary) },
            { name: 'Pedido', value: body.id },
            { name: 'Expira (UTC)', value: new Date(body.expires_at).toISOString() },
          ], footer: { text: 'Aprovar autoriza somente este resumo até o prazo indicado.' } }],
          components: [{ type: 1, components: [
            { type: 2, style: 3, label: 'Aprovar', custom_id: `a2h:approved:${body.id}` },
            { type: 2, style: 4, label: 'Recusar', custom_id: `a2h:denied:${body.id}` },
          ] }],
        },
      }).then(r => r.json());
      if (!snowflake(message.id)) throw new Error();
      entry.messageId = message.id;
      return status(entry);
    } catch {
      entry.failed = true;
      throw new Error('delivery_failed');
    }
  }
  function get(id, identity) {
    const entry = entries.get(id);
    if (!entry || entry.request.requester !== identity) throw new Error('not_found');
    return status(entry);
  }
  // Called only AFTER Discord's verifyKeyMiddleware validated the raw HTTP body.
  function interact(interaction) {
    const match = /^a2h:(approved|denied):([a-f0-9]{64})$/.exec(interaction.data?.custom_id ?? '');
    const reply = content => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
    const entry = match && entries.get(match[2]);
    if (interaction.type !== 3 || !entry || entry.failed || !entry.messageId
      || interaction.application_id !== env.APP_ID || interaction.guild_id !== env.A2H_GUILD_ID
      || interaction.channel_id !== env.A2H_CHANNEL_ID || interaction.message?.id !== entry.messageId
      || interaction.member?.user?.bot === true || !approvers.includes(interaction.member?.user?.id)) {
      return reply('Decisão recusada: pedido ou aprovador inválido.');
    }
    if (now() >= entry.request.expires_at) {
      status(entry);
      return reply('Pedido expirado. Nenhuma autorização nova foi concedida.');
    }
    if (entry.envelope) return reply('Este pedido já foi decidido.');
    finish(entry, match[1]); // Synchronous first-writer-wins before responding to Discord.
    return { type: 7, data: { components: [], content: match[1] === 'approved' ? 'Aprovado.' : 'Recusado.',
      allowed_mentions: { parse: [] } } };
  }
  return { create, get, interact };
}

let activeService;
export function handleA2hInteraction(body) {
  if (body.type !== 3 || !body.data?.custom_id?.startsWith('a2h:')) return null;
  return activeService?.interact(body) ?? { type: 4, data: { content: 'A2H indisponível.', flags: 64 } };
}

export function registerA2hRoutes(app, { env = process.env, request, service } = {}) {
  if (env.A2H_ENABLED !== '1') return { registered: false };
  try { service ??= createA2hService({ env, request }); } catch { return { registered: false, reason: 'invalid_a2h_config' }; }
  if (!service) return { registered: false };
  activeService = service;
  function auth(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
    const dedicated = env.A2H_API_KEY;
    const allKeys = [env.GPT_ACTIONS_API_KEY, env.GPT_ACTIONS_READ_API_KEY,
      ...DISCORD_AGENT_IDENTITIES.map(identity => env[identity.apiKeyEnv])];
    const badDedicated = dedicated !== undefined && (typeof dedicated !== 'string' || dedicated.length < 32
      || allKeys.includes(dedicated) || DISCORD_AGENT_IDENTITIES.some(i => i.id === env.A2H_CLIENT_ID)
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(env.A2H_CLIENT_ID ?? ''));
    const identity = match && !badDedicated && !hasDuplicateDiscordAgentKeys(env)
      ? (typeof dedicated === 'string' && sameKey(match[1], dedicated)
        ? env.A2H_CLIENT_ID : matchDiscordAgentIdentity(match[1], env)?.id) : undefined;
    if (!identity) return res.status(401).json({ error: 'unauthorized' });
    res.locals.a2hIdentity = identity;
    next();
  }
  const failure = (res, error) => {
    const codes = { invalid_request: 400, request_conflict: 409, not_found: 404, rate_limited: 429 };
    const code = codes[error?.message] ?? 503;
    return res.status(code).json({ error: code === 503 ? 'a2h_unavailable' : error.message });
  };
  app.post('/actions/a2h/requests', auth, express.json({ limit: '4kb' }), async (req, res) => {
    try { res.json(await service.create(req.body, res.locals.a2hIdentity)); } catch (error) { failure(res, error); }
  });
  app.get('/actions/a2h/requests/:id', auth, (req, res) => {
    try { res.json(service.get(req.params.id, res.locals.a2hIdentity)); } catch (error) { failure(res, error); }
  });
  // Parser errors must not leak the raw body through the default error handler.
  app.use('/actions/a2h', (error, req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.status(400).json({ error: 'invalid_request' });
  });
  return { registered: true };
}
