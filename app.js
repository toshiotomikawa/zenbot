import { handleA2hInteraction } from './a2h.js';
import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { DiscordRequest } from './utils.js';
import { syncCommandsOnBoot } from './command-sync.js';
import { checkLLMStatus, formatLLMStatus } from './llm.js';
import { startPresenceClient } from './presence.js';
import { startIdentityPresence } from './discord-agent-presence.js';
import { fetchTweetFromUrl, renderTweetScreenshot } from './twitter.js';
import { registerGithubEventsWebhook } from './github-repo-events.js';
import { createTaskPrCompletion, scheduleTaskReport } from './task-pr-completion.js';
import { startFortniteStatusStream } from './fortnite-status-stream.js';
import { registerMcpServer } from './mcp.js';
import { createHttpAuditMiddleware } from './audit-log.js';

// Create an express app
const app = express();
app.use(createHttpAuditMiddleware());
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

// GitHub repository events — opt-in, HMAC-only, route-scoped raw body.
// Registers nothing unless GITHUB_EVENTS_ENABLED=1 and the rest is configured.
registerGithubEventsWebhook(app);
scheduleTaskReport(createTaskPrCompletion());

// MCP (Phase 0) — opt-in via MCP_ENABLED, route-scoped JSON only, no Discord access.
registerMcpServer(app);

// Bot user ID (for /clear message matching). Usually equals APP_ID but we resolve
// from the API so we never rely on interaction.application_id alone.
let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const me = await DiscordRequest('users/@me', { method: 'GET' }).then((r) => r.json());
  cachedBotUserId = me.id;
  return cachedBotUserId;
}

const CLEAR_CHANNEL_ID = String(process.env.CLEAR_CHANNEL_ID ?? '').trim();
const ADMINISTRATOR = 0x8n;

async function isInteractionAdmin(req) {
  const perms = req.body.member?.permissions;
  if (perms != null && (BigInt(perms) & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id ?? req.body.user?.id;
  if (!guildId || !userId) return false;

  const guild = await DiscordRequest(`guilds/${guildId}`, { method: 'GET' }).then((r) => r.json());
  return guild.owner_id === userId;
}

/**
 * Fetches the current Fortnite item shop (in pt-BR) and builds the
 * Components V2 message body shared by the "/loja" command and the
 * daily auto-post. Returns null if the shop can't be loaded.
 */
async function fetchFortniteShop() {
  try {
    const shopRes = await fetch('https://fortnite-api.com/v2/shop?language=pt-BR');
    if (!shopRes.ok) throw new Error(`status ${shopRes.status}`);
    const shopJson = await shopRes.json();

    const entries = (shopJson.data?.entries ?? [])
      .filter((entry) => entry.brItems?.length)
      .sort((a, b) => (a.sortPriority ?? 0) - (b.sortPriority ?? 0))
      .slice(0, 10);

    if (!entries.length) return null;

    const lines = entries.map((entry) => {
      const item = entry.brItems[0];
      const rarity = item.rarity?.displayValue ?? 'Desconhecida';
      return `• **${item.name}** — 💰 ${entry.finalPrice} V-Bucks (${rarity})`;
    });

    const date = shopJson.data?.date ? new Date(shopJson.data.date).toLocaleDateString('pt-BR') : null;
    const header = `🛒 **Loja de Itens do Fortnite**${date ? ` — ${date}` : ''}`;

    const galleryItems = entries
      .map((entry) => entry.brItems[0]?.images?.icon)
      .filter(Boolean)
      .slice(0, 5)
      .map((url) => ({ media: { url } }));

    const components = [
      {
        type: MessageComponentTypes.TEXT_DISPLAY,
        content: `${header}\n\n${lines.join('\n')}`
      }
    ];

    if (galleryItems.length) {
      components.push({
        type: MessageComponentTypes.MEDIA_GALLERY,
        items: galleryItems,
      });
    }

    return {
      hash: shopJson.data?.hash,
      ids: entries.flatMap((entry) => getShopEntryDedupeIds(entry)),
      entries,
      date,
      components,
    };
  } catch (err) {
    console.error('Erro ao buscar loja do Fortnite:', err);
    return null;
  }
}

/**
 * Fetches free-to-play games from the FreeToGame API (no auth required),
 * applying optional category/platform/sort filters, and builds the
 * Components V2 message body for "/gratis". Returns null if the request
 * fails or no games match the filters.
 */
async function fetchFreeToGame({ category, platform, sortBy } = {}) {
  try {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (platform && platform !== 'all') params.set('platform', platform === 'pc' ? 'windows' : platform);
    if (sortBy) params.set('sort-by', sortBy);

    const url = `https://www.freetogame.com/api/games${params.size ? `?${params}` : ''}`;
    const gamesRes = await fetch(url);
    if (!gamesRes.ok) throw new Error(`status ${gamesRes.status}`);
    const games = await gamesRes.json();

    if (!Array.isArray(games) || !games.length) return null;

    const entries = games.slice(0, 10);

    const lines = entries.map((game) =>
      `[**${game.title}**](${game.game_url}) — ${game.genre} · ${game.platform}`
    );

    const footer = `Fonte: [FreeToGame](https://www.freetogame.com/)`;

    const galleryItems = entries
      .map((game) => game.thumbnail)
      .filter(Boolean)
      .slice(0, 5)
      .map((thumbUrl) => ({ media: { url: thumbUrl } }));

    const components = [
      {
        type: MessageComponentTypes.TEXT_DISPLAY,
        content: `${lines.join('\n')}\n\n${footer}`
      }
    ];

    if (galleryItems.length) {
      components.push({
        type: MessageComponentTypes.MEDIA_GALLERY,
        items: galleryItems,
      });
    }

    return { components };
  } catch (err) {
    console.error('Erro ao buscar jogos do FreeToGame:', err);
    return null;
  }
}

const FISHFISH_BASE = 'https://api.fishfish.gg/v1';
const FISHFISH_CATEGORY_LABELS = {
  phishing: 'Phishing',
  malware: 'Malware',
  safe: 'Seguro',
};

/**
 * Normalizes user input for "/verificar" into a domain (and, if the input
 * looks like a full URL, the URL itself). Returns null if the input isn't a
 * usable domain/URL (e.g. contains spaces or has no dot in the hostname).
 */
function normalizeFishFishInput(raw) {
  const trimmed = (raw ?? '').trim().replace(/^<|>$/g, '');
  if (!trimmed || /\s/.test(trimmed)) return null;

  const hadScheme = /^https?:\/\//i.test(trimmed);
  let url;
  try {
    url = new URL(hadScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol)) return null;
  if (!url.hostname.includes('.')) return null;

  const hasPath = url.pathname !== '/' || url.search || url.hash;
  return {
    domain: url.hostname.toLowerCase(),
    fullUrl: hadScheme ? trimmed : url.href,
    isUrl: hadScheme || hasPath,
  };
}

async function fishfishGet(path) {
  const res = await fetch(`${FISHFISH_BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/**
 * Looks up a URL or domain against the FishFish anti-phishing database
 * (public read-only endpoints, no auth required). Full URLs are checked via
 * GET /urls/:url first, falling back to GET /domains/:domain if the exact
 * URL isn't listed but the domain might be.
 */
async function fetchFishFish(rawInput) {
  const normalized = normalizeFishFishInput(rawInput);
  if (!normalized) return { ok: false, reason: 'invalid-input' };

  try {
    let record;
    let lookup;
    let queried;

    if (normalized.isUrl) {
      record = await fishfishGet(`/urls/${encodeURIComponent(normalized.fullUrl)}`);
      lookup = 'url';
      queried = normalized.fullUrl;

      if (!record) {
        const domainRecord = await fishfishGet(`/domains/${encodeURIComponent(normalized.domain)}`);
        if (domainRecord) {
          record = domainRecord;
          lookup = 'domain';
          queried = normalized.domain;
        }
      }
    } else {
      record = await fishfishGet(`/domains/${encodeURIComponent(normalized.domain)}`);
      lookup = 'domain';
      queried = normalized.domain;
    }

    return { ok: true, queried, lookup, record };
  } catch (err) {
    console.error('Erro ao consultar FishFish:', err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Builds the Components V2 message body for "/verificar" from a
 * fetchFishFish() result.
 */
function buildFishFishComponents({ queried, record }) {
  let content;

  if (!record) {
    content = `**${queried}** — Não consta na base do FishFish.\nIsso não garante que o link seja seguro.`;
  } else {
    const label = FISHFISH_CATEGORY_LABELS[record.category] ?? record.category;
    const lines = [`**${queried}** — ${label}`];

    if (record.description) lines.push(record.description);
    if (record.target) lines.push(`Alvo: ${record.target}`);
    if (record.checked) {
      const checkedDate = new Date(record.checked * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      lines.push(`Verificado: ${checkedDate}`);
    }

    lines.push('Fonte: [FishFish](https://fishfish.gg/)');
    content = lines.join('\n');
  }

  return [
    {
      type: MessageComponentTypes.TEXT_DISPLAY,
      content,
    },
  ];
}

/**
 * Projects a POI's in-world position onto a pixel position on its minimap
 * image, given the map's center location and size (in cm). The minimap is
 * a simple orthographic top-down projection: world coordinates map linearly
 * onto image coordinates around the center, with no rotation needed.
 */
function projectPoiToPixel(position, center, sizeCm, imageWidth, imageHeight) {
  const dx = position.x - center.x;
  const dy = position.y - center.y;
  return {
    x: imageWidth / 2 + (dx / sizeCm) * imageWidth,
    y: imageHeight / 2 + (dy / sizeCm) * imageHeight,
  };
}

/**
 * Fetches the current Fortnite map for the given mode (in pt-BR) from the
 * Osirion API, renders the named POIs as labeled markers on top of the
 * minimap image, and builds the Components V2 message body for "/mapa".
 * Returns null if the map can't be loaded.
 */
async function fetchFortniteMap(modeId = 'br') {
  try {
    const mapRes = await fetch(`https://fnapi.osirion.gg/v1/maps/mode?id=${encodeURIComponent(modeId)}&lang=pt-BR`);
    if (!mapRes.ok) throw new Error(`status ${mapRes.status}`);
    const mapJson = await mapRes.json();

    const map = mapJson.map;
    if (!mapJson.success || !map?.minimapUrl) return null;

    const image = await loadImage(map.minimapUrl);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    const namedPois = (map.pois ?? []).filter((poi) => !poi.locationTag?.includes('UnNamedPOI'));

    ctx.font = 'bold 26px sans-serif';
    ctx.lineWidth = 3;
    for (const poi of namedPois) {
      const { x, y } = projectPoiToPixel(poi.position, map.minimapCenterLocation, map.sizeCm, image.width, image.height);

      ctx.fillStyle = 'red';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'black';
      ctx.strokeText(poi.name, x + 10, y - 10);
      ctx.fillStyle = 'white';
      ctx.fillText(poi.name, x + 10, y - 10);
    }

    const buffer = await canvas.encode('png');

    const components = [
      {
        type: MessageComponentTypes.TEXT_DISPLAY,
        content: `🗺️ **Mapa Atual do Fortnite — ${map.mode}**`
      },
      {
        type: MessageComponentTypes.MEDIA_GALLERY,
        items: [{ media: { url: 'attachment://mapa.png' } }],
      }
    ];

    return { components, buffer };
  } catch (err) {
    console.error('Erro ao buscar mapa do Fortnite:', err);
    return null;
  }
}

/**
 * Fetches a player's Fortnite Battle Royale stats by Epic username and
 * builds the Components V2 message body for the "/stats" command.
 *
 * Unlike the shop/map endpoints, this one requires an API key
 * (FORTNITE_API_KEY in .env — see fortnite-api.com's dashboard) sent via
 * the `Authorization` header. Returns a tagged result so the caller can
 * tell "player not found" apart from "something went wrong" and reply
 * with an appropriate message either way.
 */
async function fetchFortniteStats(playerName) {
  const apiKey = process.env.FORTNITE_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no-key' };

  try {
    const url = `https://fortnite-api.com/v2/stats/br/v2?name=${encodeURIComponent(playerName)}&image=all`;
    const statsRes = await fetch(url, { headers: { Authorization: apiKey } });

    if (statsRes.status === 404) return { ok: false, reason: 'not-found' };
    if (!statsRes.ok) throw new Error(`status ${statsRes.status}`);

    const statsJson = await statsRes.json();
    const data = statsJson.data;
    const overall = data?.stats?.all?.overall;
    if (!overall) return { ok: false, reason: 'no-stats' };

    const header = `🏆 **Estatísticas de ${data.account?.name ?? playerName}** (Battle Royale)`;
    const lines = [
      `🎮 Partidas: **${overall.matches.toLocaleString('pt-BR')}**`,
      `🥇 Vitórias: **${overall.wins.toLocaleString('pt-BR')}** (taxa de vitória: ${overall.winRate.toFixed(2)}%)`,
      `💀 Eliminações: **${overall.kills.toLocaleString('pt-BR')}** (K/D: ${overall.kd.toFixed(2)})`,
      `⏱️ Tempo de jogo: **${Math.round(overall.minutesPlayed / 60).toLocaleString('pt-BR')} horas**`,
    ];

    const components = [
      {
        type: MessageComponentTypes.TEXT_DISPLAY,
        content: `${header}\n\n${lines.join('\n')}`
      }
    ];

    if (data.image) {
      components.push({
        type: MessageComponentTypes.MEDIA_GALLERY,
        items: [{ media: { url: data.image } }],
      });
    }

    return { ok: true, components };
  } catch (err) {
    console.error('Erro ao buscar estatísticas do Fortnite:', err);
    return { ok: false, reason: 'error' };
  }
}

const LAST_SHOP_HASH_FILE = '.last-shop-hash';
const LAST_SHOP_IDS_FILE = '.last-shop-ids.json';
// A loja reseta diariamente às 00:00 UTC (21h00 BRT). Em vez de checar
// eternamente a cada 5 minutos, o agendador roda uma checagem na
// inicialização (recuperação pós-downtime) e depois só numa janela de 1h após
// cada reset, tentando a cada 5 minutos (a API pode demorar a refletir o
// reset). Para testes, defina FORTNITE_TEST_INTERVAL_MS no .env (ex.: 30000)
// — vira um setInterval rápido.
const FORTNITE_TEST_INTERVAL_MS = Number(process.env.FORTNITE_TEST_INTERVAL_MS) || 0;
const FORTNITE_RESET_RETRY_MS = 5 * 60 * 1000;
const FORTNITE_RESET_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTO_SHOP_ITEMS = 10; // limite do MEDIA_GALLERY do Discord

function readLastPostedShopHash() {
  try {
    return fs.readFileSync(LAST_SHOP_HASH_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeLastPostedShopHash(hash) {
  try {
    fs.writeFileSync(LAST_SHOP_HASH_FILE, hash, 'utf8');
  } catch (err) {
    console.error('Erro ao salvar hash da loja:', err);
  }
}

function getShopEntryDedupeIds(entry) {
  const itemIds = (entry.brItems ?? [])
    .map((item) => item.id)
    .filter(Boolean);
  return itemIds.length ? itemIds : [entry.offerId].filter(Boolean);
}

function isShopEntrySeen(entry, seenIds) {
  const ids = getShopEntryDedupeIds(entry);
  if (ids.length && ids.every((id) => seenIds.has(id))) return true;
  return Boolean(entry.offerId && seenIds.has(entry.offerId));
}

function rememberShopEntries(seenIds, entries) {
  for (const entry of entries) {
    if (entry.offerId) seenIds.add(entry.offerId);
    for (const id of getShopEntryDedupeIds(entry)) seenIds.add(id);
  }
}

function buildFortniteShopComponents(entries, date) {
  const lines = entries.map((entry) => `**${entry.brItems[0].name}**: ${entry.finalPrice} V-Bucks`);

  const header = `**LOJA${date ? ` ${date}` : ''}**`;
  const components = [
    {
      type: MessageComponentTypes.TEXT_DISPLAY,
      content: `${header}\n\n${lines.join('\n')}`
    }
  ];

  const galleryItems = entries
    .map((entry) => entry.brItems[0]?.images?.icon)
    .filter(Boolean)
    .slice(0, MAX_AUTO_SHOP_ITEMS)
    .map((url) => ({ media: { url } }));

  if (galleryItems.length) {
    components.push({
      type: MessageComponentTypes.MEDIA_GALLERY,
      items: galleryItems,
    });
  }

  return components;
}

function readSeenShopIds() {
  try {
    const ids = JSON.parse(fs.readFileSync(LAST_SHOP_IDS_FILE, 'utf8'));
    if (Array.isArray(ids)) {
      return new Set(ids.filter((id) => typeof id === 'string' && id));
    }
  } catch {}
  return new Set();
}

function writeSeenShopIds(ids) {
  try {
    fs.writeFileSync(LAST_SHOP_IDS_FILE, JSON.stringify([...ids].sort(), null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar IDs da loja:', err);
  }
}

async function getRecentBotMessageText(channelId, limit = 50) {
  const botUserId = await getBotUserId();
  const response = await DiscordRequest(`channels/${channelId}/messages?limit=${limit}`, { method: 'GET' });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const messages = await response.json();
  if (!Array.isArray(messages)) throw new Error('resposta inválida do Discord');

  return messages
    .filter((message) => message.author?.id === botUserId)
    .flatMap((message) => [
      message.content ?? '',
      ...(message.components ?? []).flatMap((component) => [
        component.content ?? '',
        ...(component.components ?? []).map((child) => child.content ?? ''),
      ]),
    ])
    .join('\n');
}

async function restoreSeenShopIdsFromDiscord(channelId, entries, seenIds) {
  if (fs.existsSync(LAST_SHOP_IDS_FILE)) return true;

  // O storage do container é efêmero: recupere do Discord e falhe fechado
  // se a consulta não for confiável, em vez de arriscar uma postagem duplicada.
  try {
    const postedText = await getRecentBotMessageText(channelId);
    const postedEntries = entries.filter((entry) => {
      const name = entry.brItems?.[0]?.name;
      return name && postedText.includes(`**${name}**:`);
    });
    rememberShopEntries(seenIds, postedEntries);
    if (postedEntries.length) writeSeenShopIds(seenIds);
    return true;
  } catch (err) {
    console.error('Erro ao reconstruir deduplicação da loja pelo Discord:', err);
    return false;
  }
}

/**
 * Posts the Fortnite shop to SHOP_CHANNEL_ID whenever it changes
 * (the shop refreshes daily around 21h00 BRT / 00h00 UTC). Tracks the
 * last posted shop "hash" on disk so restarts don't cause double-posts.
 */
async function checkAndPostDailyShop() {
  const channelId = process.env.SHOP_CHANNEL_ID;
  if (!channelId) return;

  const shop = await fetchFortniteShop();
  if (!shop?.hash || !shop?.ids?.length) return;

  const seenIds = readSeenShopIds();
  if (!(await restoreSeenShopIdsFromDiscord(channelId, shop.entries, seenIds))) return;
  const newEntries = shop.entries
    .filter((entry) => !isShopEntrySeen(entry, seenIds))
    .slice(0, MAX_AUTO_SHOP_ITEMS);
  if (!newEntries.length) {
    if (shop.hash !== readLastPostedShopHash()) writeLastPostedShopHash(shop.hash);
    return;
  }

  try {
    await DiscordRequest(`channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: buildFortniteShopComponents(newEntries, shop.date),
      },
    });
    rememberShopEntries(seenIds, newEntries);
    writeSeenShopIds(seenIds);
    writeLastPostedShopHash(shop.hash);
    console.log('✅ Loja do Fortnite postada automaticamente no canal', channelId);
  } catch (err) {
    console.error('Erro ao postar loja do Fortnite automaticamente:', err);
  }
}

async function runFortniteChecks() {
  await checkAndPostDailyShop();
}

function msUntilNextFortniteReset() {
  const now = new Date();
  // 00:01 UTC do próximo dia (1 min de folga após o reset)
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0);
  return next - now.getTime();
}

async function startFortniteScheduler() {
  await runFortniteChecks(); // recuperação na inicialização (downtime perdeu o reset?)

  if (FORTNITE_TEST_INTERVAL_MS) {
    console.log(`[fortnite] MODO TESTE: checando a cada ${FORTNITE_TEST_INTERVAL_MS}ms`);
    setInterval(runFortniteChecks, FORTNITE_TEST_INTERVAL_MS);
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextFortniteReset();
    console.log(`[fortnite] Próxima checagem em ${Math.round(delay / 60000)} min (reset diário 00:00 UTC)`);
    setTimeout(async () => {
      const windowEnd = Date.now() + FORTNITE_RESET_WINDOW_MS;
      while (Date.now() < windowEnd) {
        await runFortniteChecks();
        await new Promise((resolve) => setTimeout(resolve, FORTNITE_RESET_RETRY_MS));
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

startFortniteScheduler();

const GERAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // ~3 meses
const GERAL_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // verifica 1x por dia

/**
 * Apaga mensagens de #geral com mais de ~3 meses (qualquer autor — privacidade).
 * Mensagens com mais de 14 dias não podem ser excluídas em lote pela API, por
 * isso apagamos uma a uma com um pequeno intervalo entre elas (rate limit).
 * #log não é purgado — é o registro permanente de atividade do servidor.
 */
async function checkAndPurgeOldGeral() {
  const channelId = process.env.GERAL_CHANNEL_ID;
  if (!channelId) return;

  const cutoff = Date.now() - GERAL_RETENTION_MS;
  const toDelete = [];

  try {
    let before;
    while (true) {
      const query = before ? `?limit=100&before=${before}` : '?limit=100';
      const page = await DiscordRequest(`channels/${channelId}/messages${query}`, { method: 'GET' }).then((r) => r.json());
      if (!page.length) break;

      for (const msg of page) {
        if (new Date(msg.timestamp).getTime() < cutoff) toDelete.push(msg.id);
      }

      before = page[page.length - 1].id;
      if (page.length < 100) break;
    }

    for (const id of toDelete) {
      await DiscordRequest(`channels/${channelId}/messages/${id}`, { method: 'DELETE' });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (toDelete.length) {
      console.log(`🧹 Limpeza do #geral: ${toDelete.length} mensagem(ns) com mais de 3 meses removida(s).`);
    }
  } catch (err) {
    console.error('Erro ao limpar mensagens antigas do #geral:', err);
  }
}

setInterval(checkAndPurgeOldGeral, GERAL_PURGE_INTERVAL_MS);
checkAndPurgeOldGeral();

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
// Express 4 does not catch rejected async handlers; route them to next() so a
// failing command answers 500 instead of crashing the process.
const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), catchAsync(async function (req, res) {
  // Interaction type and data
  const { type, data } = req.body;
  const a2hReply = handleA2hInteraction(req.body);
  if (a2hReply) return res.send(a2hReply);

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    // "rolar" command (dice roller)
    if (name === 'rolar') {
      const diceInput = req.body.data.options[0].value.toLowerCase();
      const reason = req.body.data.options[1]?.value;

      // Parse dice notation (e.g., 2d6+3)
      const match = diceInput.match(/^(\d+)d(\d+)(([+-]\d+)?)$/);
      
      if (!match) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ Notação de dados inválida! Use o formato: `2d6`, `1d20+5`, ou `3d8-2`'
              }
            ]
          },
        });
      }

      const numDice = parseInt(match[1]);
      const numSides = parseInt(match[2]);
      const modifier = match[3] ? parseInt(match[3]) : 0;

      // Validation
      if (numDice < 1 || numDice > 100) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ O número de dados deve estar entre 1 e 100!'
              }
            ]
          },
        });
      }

      if (numSides < 2 || numSides > 1000) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ O número de lados deve estar entre 2 e 1000!'
              }
            ]
          },
        });
      }

      // Roll the dice
      const rolls = [];
      for (let i = 0; i < numDice; i++) {
        rolls.push(Math.floor(Math.random() * numSides) + 1);
      }

      const rollSum = rolls.reduce((a, b) => a + b, 0);
      const total = rollSum + modifier;

      // Build response
      let response = `🎲 **Rolando ${numDice}d${numSides}${modifier !== 0 ? (modifier > 0 ? '+' + modifier : modifier) : ''}**`;
      
      if (reason) {
        response += ` para *${reason}*`;
      }
      
      response += '\n\n';
      
      // Show individual rolls
      if (numDice <= 20) {
        response += `**Dados:** [${rolls.join(', ')}]`;
        if (modifier !== 0) {
          response += ` ${modifier > 0 ? '+' : ''}${modifier}`;
        }
      }
      
      // Critical success/failure for d20
      if (numDice === 1 && numSides === 20) {
        if (rolls[0] === 20) {
          response += ' 🌟 **ACERTO CRÍTICO!**';
        } else if (rolls[0] === 1) {
          response += ' 💀 **FALHA CRÍTICA!**';
        }
      }
      
      response += `\n**Total:** ${total}`;

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: response
            }
          ]
        },
      });
    }

    // "condicao" command (D&D conditions lookup)
    if (name === 'condicao') {
      const condicao = req.body.data.options[0].value;
      
      const condicoes = {
        agarrado: {
          emoji: '🤜',
          nome: 'Agarrado',
          efeitos: [
            '• O deslocamento da criatura se torna 0 e ela não pode se beneficiar de bônus de deslocamento',
            '• A condição termina se o responsável ficar incapacitado',
            '• A condição também termina se a criatura for removida do alcance do responsável'
          ]
        },
        amedrontado: {
          emoji: '😱',
          nome: 'Amedrontado',
          efeitos: [
            '• Tem desvantagem em testes de atributo e jogadas de ataque enquanto a fonte do medo estiver na linha de visão',
            '• A criatura não pode voluntariamente se mover para mais perto da fonte do medo'
          ]
        },
        atordoado: {
          emoji: '💫',
          nome: 'Atordoado',
          efeitos: [
            '• A criatura está incapacitada, não pode se mover e fala de forma incompreensível',
            '• Falha automaticamente em testes de resistência de Força e Destreza',
            '• Jogadas de ataque contra ela têm vantagem'
          ]
        },
        caido: {
          emoji: '🤕',
          nome: 'Caído',
          efeitos: [
            '• A única opção de movimento é rastejar, a menos que se levante encerrando a condição',
            '• Tem desvantagem em jogadas de ataque',
            '• Um atacante tem vantagem se estiver a 1,5m da criatura. Caso contrário, tem desvantagem'
          ]
        },
        cego: {
          emoji: '🙈',
          nome: 'Cego',
          efeitos: [
            '• Falha automaticamente em qualquer teste de atributo que requeira visão',
            '• Jogadas de ataque contra a criatura têm vantagem',
            '• As jogadas de ataque da criatura têm desvantagem'
          ]
        },
        enfeiticado: {
          emoji: '💖',
          nome: 'Enfeitiçado',
          efeitos: [
            '• Não pode atacar quem a enfeitiçou ou ter essa criatura como alvo de habilidades ou efeitos mágicos nocivos',
            '• Quem a enfeitiçou tem vantagem em testes de atributo para interagir socialmente com a criatura'
          ]
        },
        envenenado: {
          emoji: '🤢',
          nome: 'Envenenado',
          efeitos: [
            '• Tem desvantagem em jogadas de ataque',
            '• Tem desvantagem em testes de atributo'
          ]
        },
        incapacitado: {
          emoji: '😵',
          nome: 'Incapacitado',
          efeitos: [
            '• A criatura não pode realizar ações ou reações'
          ]
        },
        inconsciente: {
          emoji: '😴',
          nome: 'Inconsciente',
          efeitos: [
            '• A criatura está incapacitada, não pode se mover ou falar e não tem consciência do que acontece ao redor',
            '• Solta o que estiver segurando e cai',
            '• Falha automaticamente em testes de resistência de Força e Destreza',
            '• Jogadas de ataque contra ela têm vantagem',
            '• Qualquer ataque que acerte a criatura é um acerto crítico se o atacante estiver a 1,5m dela'
          ]
        },
        invisivel: {
          emoji: '👻',
          nome: 'Invisível',
          efeitos: [
            '• A criatura é impossível de ser vista sem ajuda de magia ou sentido especial',
            '• É considerada fortemente obscurecida para propósitos de se esconder',
            '• A localização pode ser detectada por sons ou rastros deixados',
            '• Jogadas de ataque contra ela têm desvantagem',
            '• As jogadas de ataque dela têm vantagem'
          ]
        },
        paralisado: {
          emoji: '🧊',
          nome: 'Paralisado',
          efeitos: [
            '• A criatura está incapacitada e não pode se mover ou falar',
            '• Falha automaticamente em testes de resistência de Força e Destreza',
            '• Jogadas de ataque contra ela têm vantagem',
            '• Qualquer ataque que acerte a criatura é um acerto crítico se o atacante estiver a 1,5m dela'
          ]
        },
        petrificado: {
          emoji: '🗿',
          nome: 'Petrificado',
          efeitos: [
            '• A criatura é transformada em substância sólida inanimada (geralmente pedra), junto com objetos não-mágicos que esteja vestindo ou carregando',
            '• Seu peso é multiplicado por dez e para de envelhecer',
            '• Está incapacitada, não pode se mover ou falar e não tem consciência do que acontece',
            '• Jogadas de ataque contra ela têm vantagem',
            '• Falha automaticamente em testes de resistência de Força e Destreza',
            '• Tem resistência a todo dano',
            '• É imune a veneno e doença (venenos e doenças já no sistema são suspensos)'
          ]
        },
        surdo: {
          emoji: '🙉',
          nome: 'Surdo',
          efeitos: [
            '• A criatura não pode ouvir e falha automaticamente em qualquer teste de atributo que requeira audição'
          ]
        },
        impedido: {
          emoji: '🪢',
          nome: 'Impedido',
          efeitos: [
            '• O deslocamento da criatura se torna 0 e ela não pode se beneficiar de bônus de deslocamento',
            '• Jogadas de ataque contra ela têm vantagem',
            '• As jogadas de ataque dela têm desvantagem',
            '• Tem desvantagem em testes de resistência de Destreza'
          ]
        }
      };

      const info = condicoes[condicao];
      
      if (!info) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ Condição não encontrada!'
              }
            ]
          },
        });
      }

      const response = `${info.emoji} **${info.nome.toUpperCase()}**\n\n${info.efeitos.join('\n')}`;

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: response
            }
          ]
        },
      });
    }

    // "loja" command (Fortnite item shop)
    if (name === 'loja') {
      const shop = await fetchFortniteShop();

      if (!shop) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ Não foi possível carregar a loja do Fortnite agora. Tente novamente mais tarde.'
              }
            ]
          },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: shop.components,
        },
      });
    }

    // "gratis" command (FreeToGame free-to-play games list)
    if (name === 'gratis') {
      const options = req.body.data.options ?? [];
      const category = options.find((opt) => opt.name === 'categoria')?.value;
      const platform = options.find((opt) => opt.name === 'plataforma')?.value;
      const sortBy = options.find((opt) => opt.name === 'ordenar')?.value;

      const games = await fetchFreeToGame({ category, platform, sortBy });

      if (!games) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: '❌ Não foi possível carregar a lista de jogos agora. Tente novamente mais tarde.'
              }
            ]
          },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: games.components,
        },
      });
    }

    // "verificar" command (FishFish anti-phishing lookup)
    if (name === 'verificar') {
      const options = req.body.data.options ?? [];
      const link = options.find((opt) => opt.name === 'link')?.value;
      const isPublic = options.find((opt) => opt.name === 'publico')?.value === true;

      const result = await fetchFishFish(link);

      if (!result.ok) {
        const messages = {
          'invalid-input': 'Informe uma URL ou domínio válido (ex.: `discord.gift` ou `https://exemplo.com/pagina`).',
          'error': '❌ Não foi possível consultar o FishFish agora. Tente novamente mais tarde.',
        };
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: messages[result.reason] ?? messages.error,
              }
            ]
          },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2 | (isPublic ? 0 : InteractionResponseFlags.EPHEMERAL),
          components: buildFishFishComponents(result),
        },
      });
    }

    // "mapa" command (Fortnite current map)
    if (name === 'mapa') {
      const modeId = req.body.data.options?.[0]?.value ?? 'br';
      const { application_id: appId, token } = req.body;

      // Gerar a imagem do mapa demora (download + render), então respondemos
      // de forma adiada e editamos a resposta original quando terminar.
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      (async () => {
        const map = await fetchFortniteMap(modeId);
        const editEndpoint = `webhooks/${appId}/${token}/messages/@original`;

        if (!map) {
          await DiscordRequest(editEndpoint, {
            method: 'PATCH',
            body: {
              flags: InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: '❌ Não foi possível carregar o mapa do Fortnite agora. Tente novamente mais tarde.'
                }
              ]
            },
          });
          return;
        }

        const form = new FormData();
        form.append('payload_json', JSON.stringify({
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: map.components,
          attachments: [{ id: 0, filename: 'mapa.png' }],
        }));
        form.append('files[0]', new Blob([map.buffer], { type: 'image/png' }), 'mapa.png');

        await fetch(`https://discord.com/api/v10/${editEndpoint}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
          },
          body: form,
        });
      })().catch((err) => console.error('Erro ao processar comando /mapa:', err));

      return;
    }

    // "twitter" command — renders a tweet link as a styled screenshot image
    if (name === 'twitter') {
      const tweetUrl = req.body.data.options?.[0]?.value ?? '';
      const { application_id: appId, token } = req.body;

      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      (async () => {
        const editEndpoint = `webhooks/${appId}/${token}/messages/@original`;

        const fetched = await fetchTweetFromUrl(tweetUrl);
        if (!fetched.ok) {
          const messages = {
            'invalid-url': '❌ Envie um link válido do X/Twitter (ex: `https://x.com/usuario/status/123…`).',
            'not-found': '❌ Post não encontrado. Verifique se o link está correto e se o post é público.',
            error: '❌ Não foi possível carregar o post agora. Tente novamente mais tarde.',
          };
          await DiscordRequest(editEndpoint, {
            method: 'PATCH',
            body: { content: messages[fetched.reason] ?? messages.error },
          });
          return;
        }

        try {
          const buffer = await renderTweetScreenshot(fetched.tweet);
          const form = new FormData();
          form.append('payload_json', JSON.stringify({
            attachments: [{ id: 0, filename: 'tweet.png' }],
          }));
          form.append('files[0]', new Blob([buffer], { type: 'image/png' }), 'tweet.png');

          await fetch(`https://discord.com/api/v10/${editEndpoint}`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
            },
            body: form,
          });
        } catch (err) {
          console.error('[twitter] render failed:', err);
          await DiscordRequest(editEndpoint, {
            method: 'PATCH',
            body: { content: '❌ Não foi possível gerar a imagem do post. Tente novamente mais tarde.' },
          });
        }
      })().catch((err) => console.error('Erro ao processar comando /twitter:', err));

      return;
    }

    // "clear" command — Administrator-only, deletes ZEN Botélia's own messages
    // plus the invoking admin's own messages, and ONLY inside CLEAR_CHANNEL_ID.
    // The slash command itself is gated by
    // default_member_permissions (commands.js), but we re-check at runtime
    // since a server admin can override per-command permissions in Discord's
    // Integrations settings — this is the actual "Administrator privilege",
    // not a role, the user asked to gate on.
    if (name === 'clear') {
      const { application_id: appId, token } = req.body;
      const channelId = String(req.body.channel_id ?? req.body.channel?.id ?? '');
      const invokerId = String(req.body.member?.user?.id ?? req.body.user?.id ?? '');

      console.log('[clear] invoked', {
        channelId,
        userId: req.body.member?.user?.id ?? req.body.user?.id,
        permissions: req.body.member?.permissions,
      });

      if (!(await isInteractionAdmin(req))) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: InteractionResponseFlags.EPHEMERAL, content: '❌ Este comando é exclusivo para Administradores.' },
        });
      }

      if (!CLEAR_CHANNEL_ID || channelId !== CLEAR_CHANNEL_ID) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: InteractionResponseFlags.EPHEMERAL, content: '❌ Este comando só pode ser usado no canal designado.' },
        });
      }

      // A varredura do histórico + exclusão pode demorar, então respondemos
      // de forma adiada (e só para o autor — flag ephemeral).
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      (async () => {
        const editEndpoint = `webhooks/${appId}/${token}/messages/@original`;
        const patchEphemeral = async (content) => {
          try {
            await DiscordRequest(editEndpoint, {
              method: 'PATCH',
              // Deferred ephemeral replies must keep the EPHEMERAL flag on PATCH
              // or Discord rejects the edit and the interaction hangs on "thinking".
              body: { content, flags: InteractionResponseFlags.EPHEMERAL },
            });
          } catch (patchErr) {
            console.error('[clear] PATCH @original failed, trying follow-up:', patchErr);
            await DiscordRequest(`webhooks/${appId}/${token}`, {
              method: 'POST',
              body: { content, flags: InteractionResponseFlags.EPHEMERAL },
            });
          }
        };

        const botUserId = await getBotUserId();

        // Bulk-delete only accepts messages younger than 14 days; older ones
        // must go one by one (see checkAndPurgeOldGeral above for the same split).
        const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - TWO_WEEKS_MS;
        const recent = [];
        const old = [];

        try {
          let before;
          while (true) {
            const query = before ? `?limit=100&before=${before}` : '?limit=100';
            const page = await DiscordRequest(`channels/${channelId}/messages${query}`, { method: 'GET' }).then((r) => r.json());
            if (!page.length) break;

            for (const msg of page) {
              const authorId = String(msg.author?.id);
              if (authorId !== String(botUserId) && authorId !== invokerId) continue;
              if (new Date(msg.timestamp).getTime() < cutoff) old.push(msg.id);
              else recent.push(msg.id);
            }

            before = page[page.length - 1].id;
            if (page.length < 100) break;
          }

          recent.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

          for (let i = 0; i < recent.length; i += 100) {
            const batch = recent.slice(i, i + 100);
            if (batch.length === 1) {
              await DiscordRequest(`channels/${channelId}/messages/${batch[0]}`, { method: 'DELETE' });
            } else if (batch.length > 1) {
              await DiscordRequest(`channels/${channelId}/messages/bulk-delete`, { method: 'POST', body: { messages: batch } });
              if (i + 100 < recent.length) await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          }

          for (const msgId of old) {
            await DiscordRequest(`channels/${channelId}/messages/${msgId}`, { method: 'DELETE' });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          const total = recent.length + old.length;
          console.log(`[clear] done: recent=${recent.length} old=${old.length}`);
          await patchEphemeral(
            total ? `🧹 ${total} mensagem(ns) removida(s).` : 'Nenhuma mensagem sua ou minha encontrada para remover aqui.',
          );
        } catch (err) {
          console.error('Erro ao processar comando /clear:', err);
          await patchEphemeral('❌ Ocorreu um erro ao tentar remover as mensagens.');
        }
      })().catch((err) => console.error('Erro ao processar comando /clear:', err));

      return;
    }

    // "perfil" command (Fortnite player stats)
    if (name === 'perfil') {
      const playerName = req.body.data.options[0].value;
      const result = await fetchFortniteStats(playerName);

      if (!result.ok) {
        const messages = {
          'no-key': '⚠️ A integração de estatísticas do Fortnite não está configurada (faltando chave de API).',
          'not-found': `❌ Não encontrei nenhum jogador chamado **${playerName}**. Verifique se o nome de usuário Epic Games está correto.`,
          'no-stats': `❌ Não há estatísticas disponíveis para **${playerName}** no momento.`,
          error: '❌ Não foi possível carregar as estatísticas agora. Tente novamente mais tarde.',
        };

        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: messages[result.reason] ?? messages.error,
              }
            ]
          },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: result.components,
        },
      });
    }

    // "api" command — Admin-only LLM provider health check (no quota consumed)
    if (name === 'api') {
      if (!(await isInteractionAdmin(req))) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: InteractionResponseFlags.EPHEMERAL, content: '❌ Este comando é exclusivo para Administradores.' },
        });
      }

      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      (async () => {
        const { application_id: appId, token } = req.body;
        const editEndpoint = `webhooks/${appId}/${token}/messages/@original`;

        const s = await checkLLMStatus();

        const lines = formatLLMStatus(s);

        await DiscordRequest(editEndpoint, {
          method: 'PATCH',
          body: { content: lines, flags: InteractionResponseFlags.EPHEMERAL },
        });
      })().catch((err) => console.error('Erro ao processar comando /status:', err));

      return;
    }

    // "status" command — Epic Games / Fortnite server status via Statuspage API
    if (name === 'status') {
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      (async () => {
        const { application_id: appId, token } = req.body;
        const editEndpoint = `webhooks/${appId}/${token}/messages/@original`;

        try {
          const apiRes = await fetch('https://status.epicgames.com/api/v2/summary.json');
          if (!apiRes.ok) throw new Error(`status ${apiRes.status}`);
          const { components } = await apiRes.json();

          // Find the Fortnite group and its children
          const fortniteGroup = components.find(
            (c) => c.group && c.name.toLowerCase() === 'fortnite',
          );

          let rows;
          if (fortniteGroup) {
            const childIds = new Set(fortniteGroup.components ?? []);
            const children = components.filter((c) => childIds.has(c.id));
            rows = children.length ? children : [fortniteGroup];
          } else {
            // Fallback: any component with Fortnite in the name
            rows = components.filter((c) => c.name.toLowerCase().includes('fortnite'));
          }

          if (!rows.length) {
            await DiscordRequest(editEndpoint, {
              method: 'PATCH',
              body: { content: 'Nenhum componente de Fortnite encontrado na página de status.' },
            });
            return;
          }

          const nameMap = {
            'Clubs': 'Clube',
            'Crew': 'Clube',
            'Friends': 'Amigos',
            'Game Services': 'Serviço',
            'Login': 'Login',
            'Matchmaking': 'Matchmaking',
            'Party': 'Serviço',
            'Stats': 'Estatísticas',
            'Item Shop': 'Loja',
            'Store': 'Loja',
            'Voice': 'Voz',
            'Website': 'Site',
          };
          const ptName = (name) => {
            for (const [en, pt] of Object.entries(nameMap)) {
              if (name.toLowerCase().includes(en.toLowerCase())) return pt;
            }
            return name;
          };

          const statusSymbol = (s) => {
            if (s === 'operational') return '✔';
            if (s === 'under_maintenance') return '▲';
            return '✘';
          };
          const statusLabel = (s) => ({
            degraded_performance: 'Degradado',
            partial_outage: 'Instabilidade parcial',
            major_outage: 'Fora do ar',
            under_maintenance: 'Manutenção',
          }[s] ?? (s === 'operational' ? '' : s));

          const lines = rows
            .map((c) => ({ label: ptName(c.name), status: c.status }))
            .sort((a, b) => a.label.localeCompare(b.label, 'pt'))
            .map(({ label, status }) => {
              const extra = statusLabel(status);
              return `**${label}**: ${statusSymbol(status)}${extra ? ` ${extra}` : ''}`;
            });

          await DiscordRequest(editEndpoint, {
            method: 'PATCH',
            body: { content: lines.join('\n') },
          });
        } catch (err) {
          console.error('Erro ao processar comando /status:', err);
          await DiscordRequest(editEndpoint, {
            method: 'PATCH',
            body: { content: 'Não foi possível obter o status dos servidores agora. Tente novamente mais tarde.' },
          }).catch((editErr) => console.error('Erro ao responder /status:', editErr));
        }
      })();

      return;
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
}));

app.listen(PORT, () => {
  console.log('Listening on port', PORT);

  // One best-effort attempt; does not delay Gateway startup.
  void syncCommandsOnBoot();

  // Opens a (separate, minimal) Gateway connection purely so the bot can
  // show a custom status — that's a Gateway-only feature, REST has no
  // endpoint for it. See presence.js for why this is its own module.
  startPresenceClient();
  startIdentityPresence();

  // FortniteStatus Filtered Stream (X API v2). Off unless
  // FORTNITE_STATUS_STREAM_ENABLED=1. Non-blocking; never uses XAA webhooks.
  startFortniteStatusStream();

});
