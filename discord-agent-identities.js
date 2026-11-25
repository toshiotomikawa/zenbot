import crypto from 'node:crypto';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function parseDiscordAgentIdentities(env = process.env) {
  const raw = env?.DISCORD_AGENT_IDENTITIES_JSON;
  if (typeof raw !== 'string' || !raw.trim()) return Object.freeze([]);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return Object.freeze([]);
    const out = [];
    const seenIds = new Set();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { id, botUserId, tokenEnv, apiKeyEnv } = item;
      if (
        typeof id !== 'string' || !ID_RE.test(id) || seenIds.has(id)
        || typeof botUserId !== 'string' || !SNOWFLAKE_RE.test(botUserId)
        || typeof tokenEnv !== 'string' || !ENV_NAME_RE.test(tokenEnv)
        || typeof apiKeyEnv !== 'string' || !ENV_NAME_RE.test(apiKeyEnv)
      ) continue;
      seenIds.add(id);
      out.push(Object.freeze({ id, botUserId, tokenEnv, apiKeyEnv }));
    }
    return Object.freeze(out);
  } catch {
    return Object.freeze([]);
  }
}

export const DISCORD_AGENT_IDENTITIES = parseDiscordAgentIdentities(process.env);

export function getDiscordAgentIdentities(env = process.env) {
  if (env && typeof env.DISCORD_AGENT_IDENTITIES_JSON === 'string') {
    return parseDiscordAgentIdentities(env);
  }
  return DISCORD_AGENT_IDENTITIES;
}

export function matchDiscordAgentIdentity(key, env = process.env) {
  const identities = getDiscordAgentIdentities(env);
  const actual = crypto.createHash('sha256').update(key).digest();
  let matched;
  let count = 0;
  for (const identity of identities) {
    const configured = env[identity.apiKeyEnv];
    const expected = crypto.createHash('sha256').update(typeof configured === 'string' ? configured : '').digest();
    const equal = crypto.timingSafeEqual(actual, expected);
    if (equal && typeof configured === 'string' && configured.length >= 32) {
      matched = identity;
      count++;
    }
  }
  return count === 1 ? matched : undefined;
}

export function hasDuplicateDiscordAgentKeys(env = process.env, legacyKeys = [env.GPT_ACTIONS_API_KEY, env.GPT_ACTIONS_READ_API_KEY]) {
  const identities = getDiscordAgentIdentities(env);
  const keys = identities.map(identity => env[identity.apiKeyEnv])
    .filter(key => typeof key === 'string' && key.length >= 32);
  return new Set(keys).size !== keys.length || keys.some(key => legacyKeys.includes(key));
}
