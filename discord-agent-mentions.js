import { randomUUID } from 'node:crypto';
import { DISCORD_AGENT_IDENTITIES, matchDiscordAgentIdentity, hasDuplicateDiscordAgentKeys } from './discord-agent-identities.js';

export const MENTION_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MANAGED_ROLES_TTL_MS = 60 * 60 * 1000;
const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value) && !/\s/.test(value);

export function createDiscordAgentMentions({ now = Date.now, bootId = randomUUID() } = {}) {
  let cursor = 0;
  const managedRolesByGuild = new Map();
  const queues = new Map(DISCORD_AGENT_IDENTITIES.map(({ id }) => [id, []]));
  const waiters = new Map(DISCORD_AGENT_IDENTITIES.map(({ id }) => [id, new Set()]));
  const lastPolls = new Map();
  const pollListeners = new Set();
  function prune(identity) {
    const retained = queues.get(identity).filter(item => Date.parse(item.created_at) >= now() - MENTION_MAX_AGE_MS);
    queues.set(identity, retained.slice(-200));
  }
  function snapshot(identity, after, clientBootId) {
    prune(identity);
    // A future cursor cannot belong to this process either.
    const reset = (clientBootId !== undefined && clientBootId !== bootId) || after > cursor;
    return { identity, boot_id: bootId, cursor,
      mentions: queues.get(identity).filter(item => reset || item.cursor > after).map(item => ({ ...item })) };
  }
  function enqueue(identity, message, channel, parent) {
    prune(identity);
    if (queues.get(identity).some(item => item.message_id === message.id)) return;
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < now() - MENTION_MAX_AGE_MS) return;
    const content = message.content ?? '';
    queues.get(identity).push({ cursor: ++cursor, message_id: message.id,
      channel_id: message.channel_id, channel_name: channel?.name ?? '',
      parent_id: channel?.parent_id ?? null, parent_name: parent?.name ?? null,
      guild_id: message.guild_id, author_id: message.author.id,
      author_name: message.member?.nick ?? message.author.global_name ?? message.author.username ?? '',
      content: content.slice(0, 1500), ...(content.length > 1500 ? { truncated: true } : {}),
      url: `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`,
      created_at: new Date(timestamp).toISOString() });
    prune(identity);
    for (const wake of [...waiters.get(identity)]) wake();
  }
  async function ingest(message, { env = process.env, request } = {}) {
    const guildId = env.MCP_DISCORD_2A3A_GUILD_ID;
    if (!snowflake(guildId) || message?.guild_id !== guildId || (message.author?.bot
      && !DISCORD_AGENT_IDENTITIES.some(identity => identity.botUserId === message.author.id))
      || message.webhook_id || !snowflake(message.author?.id) || !snowflake(message.id)
      || !snowflake(message.channel_id)) return;
    const users = new Set((message.mentions ?? []).map(user => user.id));
    const roleIds = new Set(message.mention_roles ?? []);
    let identities = DISCORD_AGENT_IDENTITIES.filter(identity => users.has(identity.botUserId));
    if (roleIds.size && identities.length < DISCORD_AGENT_IDENTITIES.length) {
      try {
        let cached = managedRolesByGuild.get(guildId);
        if (!cached || now() >= cached.expiresAt) {
          const roles = await request(`guilds/${guildId}/roles`, { method: 'GET' }).then(res => res.json());
          if (Array.isArray(roles)) {
            cached = { expiresAt: now() + MANAGED_ROLES_TTL_MS,
              byBot: new Map(DISCORD_AGENT_IDENTITIES.map(identity => [identity.botUserId,
                new Set(roles.filter(role => role?.managed === true && role.tags?.bot_id === identity.botUserId)
                  .map(role => role.id))])) };
            managedRolesByGuild.set(guildId, cached);
          } else {
            cached = undefined;
          }
        }
        if (cached) {
          identities = DISCORD_AGENT_IDENTITIES.filter(identity => users.has(identity.botUserId)
            || [...cached.byBot.get(identity.botUserId)].some(id => roleIds.has(id)));
        }
      } catch {
        // Role lookup failures must preserve identities recognized by direct mention.
      }
    }
    // mention_everyone alone never selects an identity.
    identities = identities.filter(identity => identity.botUserId !== message.author.id);
    if (!identities.length) return;
    const channel = await request(`channels/${message.channel_id}`, { method: 'GET' }).then(res => res.json());
    if (channel?.id !== message.channel_id || channel.guild_id !== guildId) return;
    const parent = channel.parent_id
      ? await request(`channels/${channel.parent_id}`, { method: 'GET' }).then(res => res.json()) : null;
    if (parent && (parent.id !== channel.parent_id || parent.guild_id !== guildId)) return;
    for (const identity of identities) enqueue(identity.id, message, channel, parent);
  }
  function poll(identity, { after = 0, wait = 0, boot_id: clientBootId } = {}, signal) {
    const result = snapshot(identity, after, clientBootId);
    if (wait > 0 && !signal?.aborted) {
      lastPolls.set(identity, now());
      for (const listener of pollListeners) {
        try { listener(identity); } catch { /* Presence cannot break the queue. */ }
      }
    }
    if (result.mentions.length || wait === 0 || signal?.aborted) return Promise.resolve(result);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        waiters.get(identity).delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(snapshot(identity, after, clientBootId));
      };
      const timer = setTimeout(finish, wait * 1000);
      waiters.get(identity).add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
  return { ingest, poll, lastPollAt: identity => lastPolls.get(identity),
    onPoll(listener) { pollListeners.add(listener); return () => pollListeners.delete(listener); } };
}

export const discordAgentMentions = createDiscordAgentMentions();

export function registerDiscordAgentMentionsRoute(app, { env = process.env, legacyKeys, queue = discordAgentMentions, logger = console } = {}) {
  app.get('/actions/2a3a-mentions', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const match = /^Bearer ([^\s]+)$/.exec(req.headers?.authorization ?? '');
    const identity = match && !hasDuplicateDiscordAgentKeys(env, legacyKeys) ? matchDiscordAgentIdentity(match[1], env) : undefined;
    if (!identity) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ status: 'forbidden', error: 'unauthorized' });
    }
    const query = req.query ?? {};
    const integer = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && !/\s/.test(value) && Number.isSafeInteger(Number(value));
    if (Object.keys(query).some(key => !['after', 'wait', 'boot_id'].includes(key))
      || (query.after !== undefined && !integer(query.after))
      || (query.wait !== undefined && (!integer(query.wait) || Number(query.wait) > 25))
      || (query.boot_id !== undefined && (typeof query.boot_id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(query.boot_id) || /\s/.test(query.boot_id)))) {
      return res.status(400).json({ status: 'invalid_input', error: 'invalid_mentions_query' });
    }
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      const result = await queue.poll(identity.id, { after: Number(query.after ?? 0), wait: Number(query.wait ?? 0), boot_id: query.boot_id }, controller.signal);
      if (controller.signal.aborted) return;
      logger.info({ identity: result.identity, quantity: result.mentions.length, cursor: result.cursor });
      return res.json(result);
    } finally {
      res.removeListener?.('close', close);
    }
  });
}
