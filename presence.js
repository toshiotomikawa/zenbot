/**
 * Minimal Discord Gateway client. Started life for ONE reason: bot custom
 * statuses ("Meditando...", etc.) can only be set via the Gateway's
 * `PRESENCE_UPDATE` op, there is no REST endpoint for it. Everything else
 * in ZenBot is plain HTTP interactions (see app.js / AGENTS.md) and does
 * NOT need a persistent connection. Identity bots use separate, intents-0
 * sockets in discord-agent-presence.js with the same ws transport.
 *
 * It does the bare minimum to keep a custom status visible:
 *   1. Connect + IDENTIFY (with the smallest useful intents).
 *   2. Answer heartbeats on the cadence the gateway tells us to.
 *   3. Send a PRESENCE_UPDATE (type 4 = custom status) once READY fires.
 *   4. Reconnect with backoff on any close/error, and resume sessions when
 *      Discord allows it (avoids a fresh IDENTIFY — and its rate limit —
 *      on every transient drop).
 *
 * It also mirrors #boas-vindas native join messages (type 7) into #log,
 * handles GUILD_MEMBER_ADD as a fast parallel path (deduped), and handles
 * MESSAGE_CREATE for Clã/VIP mention replies (see handleMentionReply below).
 *
 * Join logging was the first of what's meant to grow into a general
 * moderation/activity log over time. (We tried
 * making #boas-vindas itself admin-only first, but Discord refuses to let
 * @everyone lose VIEW_CHANNEL on any channel that was ever an onboarding
 * default channel — a known bug, discord/discord-api-docs#7296 — so #log is
 * a fresh channel instead, and #boas-vindas stays the public System Channel.)
 *
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { askConversation } from './llm.js';
import {
  DiscordRequest,
  formatJoinLogEntry,
  appendJoinLogBackup,
  parseJoinLogLine,
  brtDateTimeToMs,
  readJoinBackupTimestampsByUser,
} from './utils.js';
import { audit } from './audit-log.js';
import { handleTaskThreadCreate, handleTaskThreadUpdate, reconcileTaskForum, scheduleTaskSweep as scheduleTaskForumSweep } from './task-thread-state.js';
import { DIRECTOR_AUTHOR_NAME } from './mcp-discord-2a3a.js';
import { discordAgentMentions } from './discord-agent-mentions.js';

let discordRequest = DiscordRequest;

export function setPresenceDiscordRequest(impl) {
  discordRequest = typeof impl === 'function' ? impl : DiscordRequest;
}

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Custom status text shown under the bot's name. Activity type 4 = CUSTOM_STATUS.
const CUSTOM_STATUS_TEXT = 'Meditando...';

// Admin-only log channel — joins for now, more event types planned as the
// bot grows. Not auto-purged. Synced from #boas-vindas join system messages.
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
// System Channel where Discord posts native GUILD_MEMBER_JOIN (type 7) messages.
const BOAS_VINDAS_CHANNEL_ID = process.env.BOAS_VINDAS_CHANNEL_ID ?? '';
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID ?? '';
const FORUM_REACTION_EMOJI = process.env.FORUM_REACTION_EMOJI ?? '❤️';

// Treat two join records for the same user within this window as one event
// (GUILD_MEMBER_ADD joined_at vs type-7 message.timestamp can differ slightly).
const JOIN_DEDUP_WINDOW_MS = 2 * 60 * 1000;

/** @type {Map<string, number[]> | null} */
let joinTimestampsByUser = null;
let joinLogQueue = Promise.resolve();

// Keep the history load and check → POST → record atomic within this process.
// A failed POST releases the queue so the other source can still log the join.
function enqueueJoinOperation(operation) {
  const pending = joinLogQueue.then(operation);
  joinLogQueue = pending.catch(() => {});
  return pending;
}

const OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// GUILDS (1 << 0) — guild/channel/thread events, including THREAD_CREATE.
// GUILD_MEMBERS (1 << 1) — GUILD_MEMBER_ADD for #log (privileged).
// GUILD_MESSAGES (1 << 9) — MESSAGE_CREATE events.
// MESSAGE_CONTENT (1 << 15) — read message.content for mention replies (privileged).
// Both privileged intents must be enabled in the Developer Portal (Bot →
// Privileged Gateway Intents).
const INTENTS = (1 << 0) | (1 << 1) | (1 << 9) | (1 << 15);

// Roles allowed to get a conversational reply when they @mention the bot.
const MENTION_REPLY_ROLE_IDS = [
  process.env.CLA_ROLE_ID,
  process.env.VIP_ROLE_ID,
].filter(Boolean);

const MENTION_REPLY_COOLDOWN_MS = 10_000;
const mentionReplyCooldowns = new Map();

// Pings da equipe que vão para o Diretor (fora da Botélia) em vez do modelo.
// Desligado por padrão: exige MENTION_DIRECTOR_USER_IDS (CSV de snowflakes) e
// MENTION_DIRECTOR_CATEGORY_ID (snowflake único) válidos. Qualquer ausência ou
// valor inválido desliga o encaminhamento e nada muda no fluxo atual.
const MENTION_DIRECTOR_SNOWFLAKE = /^\d{17,20}$/;
export const MENTION_DIRECTOR_REACTION = '📨';

export function readMentionDirectorConfig(env = process.env) {
  const rawIds = String(env.MENTION_DIRECTOR_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const categoryId = String(env.MENTION_DIRECTOR_CATEGORY_ID ?? '').trim();
  if (rawIds.length === 0 || !MENTION_DIRECTOR_SNOWFLAKE.test(categoryId)) {
    return { enabled: false, userIds: [], categoryId: null };
  }
  if (!rawIds.every((id) => MENTION_DIRECTOR_SNOWFLAKE.test(id))) {
    return { enabled: false, userIds: [], categoryId: null };
  }
  return { enabled: true, userIds: rawIds, categoryId };
}

// Mesmo critério de mcp-discord-2a3a.js (inspectTarget): canal de texto/anúncio
// filho direto da categoria, ou tópico público cujo fórum pai está nela.
export async function isMentionDirectorChannel(channelId, categoryId, request = discordRequest) {
  const channel = await request(`channels/${channelId}`, { method: 'GET' }).then((r) => r.json());
  if (channel?.type === 0 || channel?.type === 5) {
    return channel.parent_id === categoryId;
  }
  if (channel?.type === 11 && channel?.parent_id) {
    const parent = await request(`channels/${channel.parent_id}`, { method: 'GET' }).then((r) => r.json());
    return parent?.type === 15 && parent?.parent_id === categoryId;
  }
  return false;
}

// Lightweight context for follow-ups — enough to feel continuous, not a full log.
const MENTION_CONTEXT_MAX_PRIOR = 5;
const MENTION_CONTEXT_MAX_CHARS = 200;
const MENTION_CONTEXT_MAX_AGE_MS = 15 * 60 * 1000;
const forumThreadParents = new Map();

// Reconciliação do fórum de tarefas: uma passada a cada READY (também nas
// reconexões) mais uma a cada 6 h. O timer é criado uma única vez; a passada
// roda sempre. Só metadados no audit; nunca propaga erro para o dispatcher.
function scheduleTaskSweep() {
  return scheduleTaskForumSweep(() => reconcileTaskForum({ request: discordRequest, logger: audit }));
}

const MENTION_SYSTEM_INSTRUCTION = process.env.MENTION_SYSTEM_INSTRUCTION || `Você é o ZenBot, um bot de servidor Discord. \
Responda como num chat de Discord: curta, natural, direta — no máximo 1–3 frases. Tom leve e calmo, sem discurso nem elaboração. \
Você pode receber algumas mensagens recentes do canal como contexto — use só o que for relevante para a última mensagem, ignore o resto. \
Responda só ao que foi dito; se for só uma menção sem texto, um "oi" ou "e aí?" basta. \
Português brasileiro. Não invente fatos. Se não souber, diga em uma linha. Sem listas longas.`;

let cachedBotUserId = null;
let cachedAppId = null;
let askMentionModel = askConversation;

export function setPresenceAskModel(impl) {
  if (typeof impl === 'function') askMentionModel = impl;
}

export function resetPresenceBotUserId() {
  cachedBotUserId = null;
  cachedAppId = null;
}

async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const me = await discordRequest('users/@me', { method: 'GET' }).then((r) => r.json());
  cachedBotUserId = me.id;
  return cachedBotUserId;
}

async function getBotApplicationId() {
  if (cachedAppId) return cachedAppId;
  const app = await discordRequest('applications/@me', { method: 'GET' }).then((r) => r.json());
  cachedAppId = app.id;
  return cachedAppId;
}

// Resposta ao Diretor: MESSAGE_CREATE com referenced_message resolvida que tem
// webhook_id, author.username exatamente DIRECTOR_AUTHOR_NAME e é webhook da
// própria Botélia. Em mensagem de webhook, author.id é o id do webhook,
// nunca o do bot, então o único critério é referenced_message.application_id
// igual ao id da aplicação do bot (GET applications/@me). Ausente ou
// diferente, não conta (falha fechada). Sem referenced_message resolvida
// não conta e nada é buscado na rede.
export function isReplyToDirectorMessage(message, identity = {}) {
  const ref = message?.referenced_message;
  if (!ref) return false;
  if (!ref.webhook_id) return false;
  if (ref.author?.username !== DIRECTOR_AUTHOR_NAME) return false;
  const { appId } = identity;
  return Boolean(appId && ref.application_id === appId);
}

function rememberForumThread(channel) {
  if (!channel?.id || !channel?.parent_id) return;
  forumThreadParents.set(channel.id, channel.parent_id);
}

async function isForumPostChannel(channelId) {
  if (!FORUM_CHANNEL_ID || !channelId) return false;
  if (channelId === FORUM_CHANNEL_ID) return true;

  if (forumThreadParents.get(channelId) === FORUM_CHANNEL_ID) return true;
  if (forumThreadParents.has(channelId)) return false;

  try {
    const channel = await discordRequest(`channels/${channelId}`, { method: 'GET' }).then((r) => r.json());
    rememberForumThread(channel);
    return channel.parent_id === FORUM_CHANNEL_ID;
  } catch (err) {
    console.error('[forum-react] Falha ao verificar canal/thread:', err.message);
    return false;
  }
}

async function reactToForumPost(message) {
  if (!message?.id || !message.channel_id) return false;
  if (message.type !== 0 && message.type !== 19) return false;
  if (!(await isForumPostChannel(message.channel_id))) return false;

  const emoji = encodeURIComponent(FORUM_REACTION_EMOJI);
  await discordRequest(`channels/${message.channel_id}/messages/${message.id}/reactions/${emoji}/@me`, {
    method: 'PUT',
  });
  console.log(`[forum-react] Reagi com ${FORUM_REACTION_EMOJI} em ${message.id}.`);
  return true;
}

let ws = null;
let heartbeatInterval = null;
let heartbeatAckReceived = true;
let sequence = null;
let sessionId = null;
let resumeGatewayUrl = null;
let reconnectAttempt = 0;
let manuallyClosed = false;

function buildPresencePayload() {
  return {
    op: OPCODES.PRESENCE_UPDATE,
    d: {
      since: null,
      activities: [
        {
          name: 'Custom Status',
          type: 4, // CUSTOM_STATUS
          state: CUSTOM_STATUS_TEXT,
        },
      ],
      status: 'online',
      afk: false,
    },
  };
}

function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatAckReceived = true;
  heartbeatInterval = setInterval(() => {
    if (!heartbeatAckReceived) {
      // Discord didn't ack our last heartbeat — connection is stale.
      // Closing with a non-1000 code makes us reconnect+resume.
      console.warn('[presence] Heartbeat não confirmado, reconectando...');
      audit.error({ subsystem: 'gateway', event: 'heartbeat_timeout', outcome: 'error', error_code: 'timeout' });
      ws?.close(4000);
      return;
    }
    heartbeatAckReceived = false;
    send({ op: OPCODES.HEARTBEAT, d: sequence });
  }, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function identify() {
  send({
    op: OPCODES.IDENTIFY,
    d: {
      token: process.env.DISCORD_TOKEN,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: 'zenbot',
        device: 'zenbot',
      },
      presence: buildPresencePayload().d,
    },
  });
}

function resume() {
  send({
    op: OPCODES.RESUME,
    d: {
      token: process.env.DISCORD_TOKEN,
      session_id: sessionId,
      seq: sequence,
    },
  });
}

function scheduleReconnect() {
  if (manuallyClosed) return;
  stopHeartbeat();
  const delayMs = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  console.warn(`[presence] Reconectando em ${Math.round(delayMs / 1000)}s...`);
  audit.info({ subsystem: 'gateway', event: 'reconnect_scheduled', outcome: 'ok' });
  setTimeout(connect, delayMs);
}

async function memberHasMentionRole(guildId, userId, member) {
  let roles = member?.roles;
  if (!roles?.length) {
    try {
      const res = await discordRequest(`guilds/${guildId}/members/${userId}`, { method: 'GET' });
      roles = (await res.json()).roles ?? [];
    } catch {
      return false;
    }
  }
  return MENTION_REPLY_ROLE_IDS.some((id) => roles.includes(id));
}

function stripBotMention(content, botId) {
  return (content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactMessageText(content, maxChars = MENTION_CONTEXT_MAX_CHARS) {
  const text = (content ?? '')
    .replace(/<@!?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function formatContextLine(msg, botUserId) {
  const text = compactMessageText(msg.content);
  if (!text) return null;
  const name = msg.author?.id === botUserId
    ? 'Botélia'
    : (msg.author?.global_name ?? msg.author?.username ?? 'Membro');
  return `${name}: ${text}`;
}

async function fetchPriorMessages(channelId, beforeMessageId, limit) {
  const res = await discordRequest(
    `channels/${channelId}/messages?limit=${limit}&before=${beforeMessageId}`,
    { method: 'GET' },
  );
  return res.json();
}

function buildMentionPrompt(priorMessages, triggerMessage, botUserId) {
  const triggerTime = new Date(triggerMessage.timestamp).getTime();
  const lines = priorMessages
    .filter((msg) => {
      if (!msg.content?.trim()) return false;
      if (msg.author?.bot && msg.author.id !== botUserId) return false;
      return triggerTime - new Date(msg.timestamp).getTime() <= MENTION_CONTEXT_MAX_AGE_MS;
    })
    .map((msg) => formatContextLine(msg, botUserId))
    .filter(Boolean)
    .reverse();

  const latest = compactMessageText(
    stripBotMention(triggerMessage.content, botUserId),
    MENTION_CONTEXT_MAX_CHARS,
  ) || '[mentioned without text]';

  if (!lines.length) return latest;
  return `Recent messages (oldest first):\n${lines.join('\n')}\n\nReply to the member's latest message:\n${latest}`;
}

function messageMentionsBot(message, botUserId) {
  if (message.mentions?.some((user) => user.id === botUserId)) return true;
  const content = message.content ?? '';
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

async function forwardMentionToDirector(message) {
  const director = readMentionDirectorConfig();
  if (!director.enabled) return false;
  if (!director.userIds.includes(message.author?.id)) return false;
  // Bot ou webhook com ID da lista: ignorado, sem reação e sem modelo.
  if (message.author?.bot || message.webhook_id) return true;

  let inside = false;
  try {
    inside = await isMentionDirectorChannel(message.channel_id, director.categoryId);
  } catch (err) {
    // Sem o canal, o pedido não pode se perder: reage e registra só o erro.
    console.error('[mention-director] Falha ao verificar categoria:', err?.message ?? err);
    audit.error({
      subsystem: 'gateway',
      event: 'mention_director_lookup_failed',
      channel_id: message.channel_id,
      message_id: message.id,
      outcome: 'error',
      error_code: String(err?.status ?? 'lookup_failed'),
    });
    inside = true;
  }
  if (!inside) return false;

  let reactionErrorCode = null;
  try {
    await discordRequest(
      `channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(MENTION_DIRECTOR_REACTION)}/@me`,
      { method: 'PUT' },
    );
  } catch (err) {
    const status = err?.status;
    reactionErrorCode = (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
      ? String(status)
      : 'reaction_failed';
    console.error('[mention-director] Falha ao reagir:', reactionErrorCode);
  }
  console.log(`[mention-director] Ping de ${message.author.id} encaminhado ao Diretor.`);
  if (reactionErrorCode === null) {
    audit.info({
      subsystem: 'gateway',
      event: 'mention_forwarded_to_director',
      channel_id: message.channel_id,
      message_id: message.id,
      user_id: message.author.id,
      outcome: 'ok',
    });
  } else {
    audit.error({
      subsystem: 'gateway',
      event: 'mention_forwarded_to_director',
      channel_id: message.channel_id,
      message_id: message.id,
      user_id: message.author.id,
      outcome: 'error',
      error_code: reactionErrorCode,
    });
  }
  return true;
}

export async function handleMentionReply(message) {
  let botUserId;
  try {
    botUserId = await getBotUserId();
  } catch (err) {
    console.error('[mention] Falha ao resolver bot user id:', err.message);
    return;
  }

  if (message.author?.bot || !message.guild_id || message.type === 7) return;

  const mentionsBot = messageMentionsBot(message, botUserId);
  let replyToDirector = false;
  if (!mentionsBot && message.referenced_message) {
    let appId = null;
    try {
      appId = await getBotApplicationId();
    } catch {
      appId = null;
    }
    replyToDirector = isReplyToDirectorMessage(message, { appId });
  }
  if (!mentionsBot && !replyToDirector) return;

  const userId = message.author.id;
  if (await forwardMentionToDirector(message)) return;
  if (!mentionsBot) return;
  if (!(await memberHasMentionRole(message.guild_id, userId, message.member))) {
    console.log(`[mention] Ignorado — usuário ${userId} sem cargo Clã/VIP.`);
    return;
  }
  const now = Date.now();
  const lastReply = mentionReplyCooldowns.get(userId) ?? 0;
  if (now - lastReply < MENTION_REPLY_COOLDOWN_MS) return;
  mentionReplyCooldowns.set(userId, now);

  console.log(`[mention] Respondendo a ${userId} no canal ${message.channel_id}`);

  let prompt;
  try {
    const prior = await fetchPriorMessages(
      message.channel_id,
      message.id,
      MENTION_CONTEXT_MAX_PRIOR,
    );
    prompt = buildMentionPrompt(prior, message, botUserId);
  } catch (err) {
    console.warn('[presence] Context fetch failed, replying without history:', err.message);
    prompt = stripBotMention(message.content, botUserId) || '[mentioned without text]';
  }

  discordRequest(`channels/${message.channel_id}/typing`, { method: 'POST' }).catch(() => {});

  const result = await askMentionModel(prompt, MENTION_SYSTEM_INSTRUCTION);

  let content;
  if (result.ok) {
    content = result.text.trim();
  } else if (result.reason === 'no-key') {
    content = 'Minha chave do OpenRouter não está configurada — avise um administrador.';
  } else {
    content = 'Desculpe, não consegui pensar numa resposta agora. Tente de novo em instantes.';
  }

  if (content.length > 2000) {
    content = `${content.slice(0, 1997)}...`;
  }

  try {
    await discordRequest(`channels/${message.channel_id}/messages`, {
      method: 'POST',
      body: {
        content,
        message_reference: {
          message_id: message.id,
          channel_id: message.channel_id,
          guild_id: message.guild_id,
        },
        allowed_mentions: { parse: [] },
      },
    });
  } catch (err) {
    console.error('[mention] Erro ao postar resposta:', err);
  }
}

function recordJoinAccounted({ userId, joinedAt }) {
  if (!joinTimestampsByUser) joinTimestampsByUser = new Map();
  const ms = new Date(joinedAt).getTime();
  if (!joinTimestampsByUser.has(userId)) joinTimestampsByUser.set(userId, []);
  joinTimestampsByUser.get(userId).push(ms);
}

function isJoinAccountedFor({ userId, joinedAt }) {
  if (!joinTimestampsByUser) return false;
  const target = new Date(joinedAt).getTime();
  const stamps = joinTimestampsByUser.get(userId);
  if (!stamps) return false;
  return stamps.some((ms) => Math.abs(ms - target) < JOIN_DEDUP_WINDOW_MS);
}

export function loadJoinAccountIndex() {
  return enqueueJoinOperation(loadJoinAccountIndexNow);
}

async function loadJoinAccountIndexNow() {
  joinTimestampsByUser = readJoinBackupTimestampsByUser();

  if (!LOG_CHANNEL_ID) return;

  let before;
  while (true) {
    const query = before ? `?limit=100&before=${before}` : '?limit=100';
    const page = await discordRequest(`channels/${LOG_CHANNEL_ID}/messages${query}`, {
      method: 'GET',
    }).then((r) => r.json());
    if (!page.length) break;

    for (const msg of page) {
      const parsed = parseJoinLogLine(msg.content);
      if (!parsed) continue;
      recordJoinAccounted({
        userId: parsed.userId,
        joinedAt: brtDateTimeToMs(parsed.dateStr, parsed.timeStr),
      });
    }

    before = page[page.length - 1].id;
    if (page.length < 100) break;
  }
}

function entryFromMember(member) {
  const user = member.user;
  if (!user) return null;
  return {
    displayName: user.global_name ?? user.username,
    userId: user.id,
    joinedAt: member.joined_at ?? Date.now(),
  };
}

function entryFromBoasVindasMessage(message) {
  const user = message.author;
  if (!user) return null;
  return {
    displayName: user.global_name ?? user.username,
    userId: user.id,
    joinedAt: message.timestamp,
  };
}

export function postJoinLogEntry(entryData) {
  return enqueueJoinOperation(() => postJoinLogEntryNow(entryData));
}

async function postJoinLogEntryNow(entryData) {
  if (!LOG_CHANNEL_ID || !entryData?.userId) return false;

  if (isJoinAccountedFor(entryData)) {
    console.log(`[join-log] Já registrado: ${entryData.userId} (${entryData.joinedAt})`);
    return false;
  }

  const content = formatJoinLogEntry(entryData);

  try {
    await discordRequest(`channels/${LOG_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: { content, allowed_mentions: { parse: [] } },
    });
    appendJoinLogBackup(entryData);
    recordJoinAccounted(entryData);
    console.log(`[join-log] Registrado: ${entryData.userId} (${entryData.displayName})`);
    return true;
  } catch (err) {
    console.error('[presence] Erro ao registrar entrada no canal de log:', err);
    return false;
  }
}

async function fetchAllChannelMessages(channelId) {
  const all = [];
  let before;
  while (true) {
    const query = before ? `?limit=100&before=${before}` : '?limit=100';
    const page = await discordRequest(`channels/${channelId}/messages${query}`, {
      method: 'GET',
    }).then((r) => r.json());
    if (!page.length) break;
    all.push(...page);
    before = page[page.length - 1].id;
    if (page.length < 100) break;
  }
  return all;
}

/** On startup, post any #boas-vindas join messages missing from #log. */
export async function reconcileBoasVindasJoins() {
  if (!LOG_CHANNEL_ID || !BOAS_VINDAS_CHANNEL_ID) return;

  try {
    const messages = await fetchAllChannelMessages(BOAS_VINDAS_CHANNEL_ID);
    const joins = messages.filter((m) => m.type === 7);
    let posted = 0;

    for (const msg of joins) {
      const entry = entryFromBoasVindasMessage(msg);
      if (!entry) continue;
      if (await postJoinLogEntry(entry)) posted++;
    }

    if (posted) {
      console.log(`[join-log] Reconciliação #boas-vindas: ${posted} entrada(s) adicionada(s) ao #log.`);
    }
  } catch (err) {
    console.error('[join-log] Erro na reconciliação com #boas-vindas:', err);
  }
}

function handleBoasVindasJoinMessage(message) {
  if (message.channel_id !== BOAS_VINDAS_CHANNEL_ID) return false;
  if (message.type !== 7) return false; // GUILD_MEMBER_JOIN

  const entry = entryFromBoasVindasMessage(message);
  if (!entry) return false;

  postJoinLogEntry(entry).catch((err) => {
    console.error('[join-log] Erro ao processar entrada do #boas-vindas:', err);
  });
  return true;
}

export function auditGatewayEvent(eventName, data, logger = audit) {
  const meta = { subsystem: 'gateway', event: eventName };
  if (data?.guild_id) meta.guild_id = data.guild_id;
  if (eventName === 'THREAD_CREATE' || eventName === 'THREAD_DELETE' || eventName === 'THREAD_UPDATE') {
    if (data?.id) meta.thread_id = data.id;
    if (data?.parent_id) meta.channel_id = data.parent_id;
  } else if (data?.channel_id) {
    meta.channel_id = data.channel_id;
  }
  if (data?.id && eventName === 'MESSAGE_CREATE') meta.message_id = data.id;
  const userId = data?.user?.id || data?.author?.id;
  if (userId) meta.user_id = userId;
  logger.info(meta);
}

export function handleDispatch(eventName, data, logger = audit) {
  auditGatewayEvent(eventName, data, logger);
  if (eventName === 'GUILD_MEMBER_ADD') {
    const entry = entryFromMember(data);
    if (entry) {
      postJoinLogEntry(entry).catch((err) => {
        console.error('[join-log] Erro ao processar GUILD_MEMBER_ADD:', err);
      });
    }
  } else if (eventName === 'THREAD_CREATE') {
    rememberForumThread(data);
    void handleTaskThreadCreate(data, { request: discordRequest, logger });
  } else if (eventName === 'THREAD_UPDATE') {
    void handleTaskThreadUpdate(data, { request: discordRequest, logger });
  } else if (eventName === 'MESSAGE_CREATE') {
    // Keep queue failures isolated; never log raw message content or errors.
    void discordAgentMentions.ingest(data, { request: discordRequest }).catch(() => {});
    reactToForumPost(data).catch((err) => {
      console.error('[forum-react] Erro ao reagir no #forum:', err);
    });

    if (!handleBoasVindasJoinMessage(data)) {
      handleMentionReply(data).catch((err) => {
        console.error('[mention] Erro não tratado no handler:', err);
      });
    }
  } else if (eventName === 'READY') {
    sessionId = data.session_id;
    resumeGatewayUrl = data.resume_gateway_url ?? GATEWAY_URL;
    reconnectAttempt = 0;
    console.log(`[presence] Conectado ao Gateway como ${data.user?.username ?? 'ZEN Bot\u00E9lia'} — status "${CUSTOM_STATUS_TEXT}" definido.`);
    getBotUserId().catch((err) => {
      console.error('[mention] Falha ao pré-carregar bot user id:', err.message);
    });
    getBotApplicationId().catch((err) => {
      console.error('[mention] Falha ao pré-carregar application id:', err.message);
    });
    loadJoinAccountIndex()
      .then(() => reconcileBoasVindasJoins())
      .catch((err) => {
        console.error('[join-log] Falha ao carregar índice / reconciliar:', err);
      });
    scheduleTaskSweep();
    // Presence is also sent in IDENTIFY, but some clients need an explicit
    // PRESENCE_UPDATE after READY for it to actually display. Cheap to send both.
    send(buildPresencePayload());
  } else if (eventName === 'RESUMED') {
    reconnectAttempt = 0;
    console.log('[presence] Sessão retomada.');
    send(buildPresencePayload());
  }
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const { op, d, s, t } = msg;
  if (s != null) sequence = s;

  switch (op) {
    case OPCODES.HELLO:
      startHeartbeat(d.heartbeat_interval);
      if (sessionId && sequence != null) {
        resume();
      } else {
        identify();
      }
      break;
    case OPCODES.HEARTBEAT_ACK:
      heartbeatAckReceived = true;
      break;
    case OPCODES.HEARTBEAT:
      // Discord is asking for an immediate heartbeat.
      send({ op: OPCODES.HEARTBEAT, d: sequence });
      break;
    case OPCODES.DISPATCH:
      handleDispatch(t, d);
      break;
    case OPCODES.INVALID_SESSION:
      // d === true means we *can* resume; otherwise start fresh.
      sessionId = null;
      sequence = null;
      setTimeout(() => (d ? resume() : identify()), 1000 + Math.random() * 4000);
      break;
    case OPCODES.RECONNECT:
      console.log('[presence] Gateway pediu reconexão.');
      ws?.close(4000);
      break;
    default:
      break;
  }
}

function connect() {
  if (manuallyClosed) return;

  const url = resumeGatewayUrl && sessionId ? `${resumeGatewayUrl}/?v=10&encoding=json` : GATEWAY_URL;
  ws = new WebSocket(url);

  ws.on('message', handleMessage);

  ws.on('close', (code) => {
    stopHeartbeat();
    console.warn(`[presence] Conexão com o Gateway encerrada (code ${code}).`);
    audit.info({ subsystem: 'gateway', event: 'close', status: code, outcome: code === 4004 ? 'error' : 'ok' });
    // 4004 = authentication failed — don't retry, the token is wrong.
    if (code === 4004) {
      console.error('[presence] Token inválido — encerrando o cliente de presença.');
      audit.error({ subsystem: 'gateway', event: 'auth_failed', outcome: 'error', error_code: 'invalid_token' });
      manuallyClosed = true;
      return;
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[presence] Erro na conexão com o Gateway:', err.message);
    audit.error({ subsystem: 'gateway', event: 'connection_error', outcome: 'error', error_code: 'network' });
  });
}

/**
 * Starts the Gateway presence client. Safe to call once at app startup;
 * runs alongside the Express server without affecting it.
 */
export function startPresenceClient() {
  if (!process.env.DISCORD_TOKEN) {
    console.warn('[presence] DISCORD_TOKEN ausente — pulando conexão com o Gateway (status customizado não será exibido).');
    return;
  }
  manuallyClosed = false;
  connect();
}

export function stopPresenceClient() {
  manuallyClosed = true;
  stopHeartbeat();
  ws?.close(1000);
}
