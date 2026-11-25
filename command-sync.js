import { ALL_COMMANDS } from './command-definitions.js';
import { audit } from './audit-log.js';

// Best-effort bulk overwrite. Never log response bodies or exception details.
export async function syncCommandsOnBoot({ env = process.env, fetchImpl = globalThis.fetch, logger = audit } = {}) {
  if (env.COMMAND_SYNC_ON_BOOT === '0') return false;
  const meta = { subsystem: 'command_sync', event: 'boot', action: env.GUILD_ID ? 'guild' : 'global' };
  const log = (level, fields) => {
    try { logger[level]({ ...meta, ...fields }); } catch { /* Audit cannot fail startup. */ }
  };
  if (!env.APP_ID || !env.DISCORD_TOKEN) {
    log('error', { outcome: 'failure', error_code: 'missing_configuration' });
    return false;
  }
  const endpoint = env.GUILD_ID
    ? `applications/${env.APP_ID}/guilds/${env.GUILD_ID}/commands`
    : `applications/${env.APP_ID}/commands`;
  try {
    const response = await fetchImpl('https://discord.com/api/v10/' + endpoint, {
      method: 'PUT',
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ALL_COMMANDS),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    log(response.ok ? 'info' : 'error', {
      status: response.status,
      outcome: response.ok ? 'success' : 'failure',
      ...(!response.ok ? { error_code: 'http_error' } : {}),
    });
    return response.ok;
  } catch {
    log('error', { outcome: 'failure', error_code: 'request_failed' });
    return false;
  }
}
