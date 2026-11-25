import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { audit, auditDiscordRest, normalizeDiscordEndpoint } from './audit-log.js';

const logDiscordRest = auditDiscordRest(audit);

function protectJoinLogChannel(endpoint, method) {
  // Configured join-log channel is protected from accidental channel deletion or edits.
  const protectedId = String(process.env.LOG_CHANNEL_ID ?? '').trim();
  if (!/^\d{17,20}$/.test(protectedId)) return;
  const pathname = new URL(endpoint, 'https://discord.com/api/v10/').pathname;
  if (pathname === `/api/v10/channels/${protectedId}` || pathname === `/api/v10/channels/${protectedId}/`) {
    if (['DELETE', 'PATCH'].includes(method.toUpperCase())) {
      throw new Error('protected_join_log_channel');
    }
  }
}

export async function DiscordRequest(endpoint, options = {}) {
  protectJoinLogChannel(endpoint, options.method || 'GET');
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  // Stringify JSON bodies only. File uploads use DiscordMultipartRequest.
  const opts = { ...options };
  const sensitiveErrors = opts.sensitiveErrors === true;
  delete opts.sensitiveErrors;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
  }
  const method = opts.method || 'GET';
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json; charset=UTF-8' }),
        'User-Agent': 'DiscordBot (https://github.com/toshiotomikawa/zenbot, 1.0.0)',
      },
      ...opts,
    });
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network';
    logDiscordRest('json', endpoint, method, started, undefined, code);
    throw err;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    logDiscordRest('json', endpoint, method, started, res.status, 'http_error');
    if (!sensitiveErrors) {
      console.error(`Discord API request failed: status=${res.status} endpoint=${normalizeDiscordEndpoint(endpoint)}`);
    }
    const error = new Error('Discord request failed');
    error.status = res.status;
    if (res.status === 429) {
      const raw = res.headers.get('retry-after');
      error.retryAfterMs = /^\d+(?:\.\d+)?$/.test(raw || '')
        ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now()) || 0;
    }
    throw error;
  }
  logDiscordRest('json', endpoint, method, started, res.status);
  return res;
}

/**
 * Multipart Discord REST helper for channel file uploads.
 * Leaves Content-Type to FormData/fetch (boundary). Does not alter JSON callers.
 *
 * @param {string} endpoint e.g. channels/{id}/messages
 * @param {{ method?: string, payloadJson: object, files: Array<{ name: string, buffer: Buffer|Uint8Array, contentType?: string }>, signal?: AbortSignal, token?: string }} options
 */
export async function DiscordMultipartRequest(endpoint, options = {}) {
  protectJoinLogChannel(endpoint, options.method || 'POST');
  const url = 'https://discord.com/api/v10/' + endpoint;
  const form = new FormData();
  form.append('payload_json', JSON.stringify(options.payloadJson ?? {}));
  const files = options.files || [];
  files.forEach((file, index) => {
    const type = file.contentType || 'application/octet-stream';
    const blob = new Blob([file.buffer], { type });
    form.append(`files[${index}]`, blob, file.name || `file${index}`);
  });
  const token = options.token || process.env.DISCORD_TOKEN;
  const method = options.method || 'POST';
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/toshiotomikawa/zenbot, 1.0.0)',
      },
      body: form,
      signal: options.signal,
    });
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network';
    logDiscordRest('multipart', endpoint, method, started, undefined, code);
    throw err;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    logDiscordRest('multipart', endpoint, method, started, res.status, 'http_error');
    console.error(`Discord API request failed: status=${res.status} endpoint=${normalizeDiscordEndpoint(endpoint)}`);
    const error = new Error('Discord request failed');
    error.status = res.status;
    throw error;
  }
  logDiscordRest('multipart', endpoint, method, started, res.status);
  return res;
}

export async function InstallGlobalCommands(appId, commands) {
  // API endpoint to overwrite global commands
  const endpoint = `applications/${appId}/commands`;
  try {
    // This is calling the bulk overwrite endpoint: https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
  } catch (err) {
    console.error(err);
  }
}

// Nova função para instalar comandos de guild (atualização instantânea)
export async function InstallGuildCommands(appId, guildId, commands) {
  // API endpoint to overwrite guild commands
  const endpoint = `applications/${appId}/guilds/${guildId}/commands`;
  try {
    // This is calling the bulk overwrite endpoint for guild commands
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
    console.log(`✅ Comandos instalados no servidor ${guildId}`);
  } catch (err) {
    console.error(err);
  }
}

// Simple method that returns a random emoji from list
export function getRandomEmoji() {
  const emojiList = ['😭','😄','😌','🤓','😎','😤','🤖','😶‍🌫️','🌏','📸','💿','👋','🌊','✨'];
  return emojiList[Math.floor(Math.random() * emojiList.length)];
}

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Brazil has used UTC-3 year-round (no DST) since 2019, so
// America/Sao_Paulo always renders as BRT. Shared by formatJoinLogEntry and
// appendJoinLogBackup so the #log message and the local backup always agree.
export function formatBrtDateAndTime(date) {
  const dateStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
  const timeStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return { dateStr, timeStr };
}

// #log entry for member joins — shared by the live GUILD_MEMBER_ADD logger
// (presence.js) and the one-time historical backfill, so both produce
// identical formatting: "**JOINED**: <@userId>, Display Name, userId,
// DD/MM/AAAA, HH:MM BRT". "JOINED" is the only Markdown used (bold, as a
// label/heading); everything else is plain text. The <@userId> is a real
// Discord mention — renders as a highlighted, clickable profile tag (sent
// with allowed_mentions suppressed so it doesn't actually ping anyone).
export function formatJoinLogEntry({ displayName, userId, joinedAt }) {
  const { dateStr, timeStr } = formatBrtDateAndTime(new Date(joinedAt));
  return `**JOINED**: <@${userId}>, ${displayName}, ${userId}, ${dateStr}, ${timeStr} BRT`;
}

const LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
const JOIN_BACKUP_PATH = path.join(LOGS_DIR, 'join-log-backup.txt');
const JOIN_BACKUP_HEADER = 'user_id, display_name, date, time_brt\n';

// Local on-disk mirror of #log's join entries — plain text, comma-separated
// columns (CSV-ish layout, but without quoting/escaping since none of the
// fields need it; just easier to skim/grep than real CSV). Appended to
// every time postJoinLogEntry fires, so it stays in sync with #log without
// needing a Discord round-trip to read history back.
export function appendJoinLogBackup({ displayName, userId, joinedAt }) {
  const { dateStr, timeStr } = formatBrtDateAndTime(new Date(joinedAt));
  const row = `${userId}, ${displayName}, ${dateStr}, ${timeStr} BRT\n`;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    if (!fs.existsSync(JOIN_BACKUP_PATH)) fs.writeFileSync(JOIN_BACKUP_PATH, JOIN_BACKUP_HEADER, 'utf8');
    fs.appendFileSync(JOIN_BACKUP_PATH, row, 'utf8');
  } catch (err) {
    console.error('Erro ao gravar backup local do log de entradas:', err);
  }
}

/** Stable key for deduping join rows (user + BRT date + BRT time). */
export function getJoinLogKey({ userId, joinedAt }) {
  const { dateStr, timeStr } = formatBrtDateAndTime(new Date(joinedAt));
  return `${userId}|${dateStr}|${timeStr}`;
}

/** Parse a #log JOINED line back into fields, or null if not a join entry. */
export function parseJoinLogLine(content) {
  const m = content?.match(
    /^\*\*JOINED\*\*: <@(\d+)>, (.+), (\d+), (\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2}) BRT$/,
  );
  if (!m) return null;
  return { userId: m[1], displayName: m[2], dateStr: m[4], timeStr: m[5] };
}

/** BRT wall-clock (DD/MM/YYYY + HH:MM) to UTC epoch ms. */
export function brtDateTimeToMs(dateStr, timeStr) {
  const [day, month, year] = dateStr.split('/').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour + 3, minute);
}

/** Read join timestamps already mirrored locally (one ms per backup row). */
export function readJoinBackupTimestampsByUser() {
  const byUser = new Map();
  if (!fs.existsSync(JOIN_BACKUP_PATH)) return byUser;
  const lines = fs.readFileSync(JOIN_BACKUP_PATH, 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = line.match(/^(\d+), (.+), (\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2}) BRT$/);
    if (!m) continue;
    const userId = m[1];
    const ms = brtDateTimeToMs(m[3], m[4]);
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(ms);
  }
  return byUser;
}
