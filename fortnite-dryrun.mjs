// Read-only verification of the Fortnite shop auto-post dedupe state.
// Posts NOTHING. Compares .last-shop-ids.json against the live
// fortnite-api.com data and the bot's actual messages in SHOP_CHANNEL_ID,
// and checks the channel is private (@everyone denied VIEW_CHANNEL).
// Run: node fortnite-dryrun.mjs
import 'dotenv/config';
import fs from 'fs';
import { DiscordRequest } from './utils.js';

const VIEW_CHANNEL = 1n << 10n;

function readJsonSet(file) {
  try {
    const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function getShopEntryDedupeIds(entry) {
  const itemIds = (entry.brItems ?? []).map((i) => i.id).filter(Boolean);
  return itemIds.length ? itemIds : [entry.offerId].filter(Boolean);
}

async function channelMessages(channelId, limit = 25) {
  const res = await DiscordRequest(`channels/${channelId}/messages?limit=${limit}`, { method: 'GET' });
  return res.json();
}

function messageText(msg) {
  const parts = [msg.content ?? ''];
  for (const c of msg.components ?? []) {
    if (c.content) parts.push(c.content);
    for (const cc of c.components ?? []) if (cc.content) parts.push(cc.content);
  }
  return parts.join('\n');
}

async function checkPrivacy(channelId, label) {
  const res = await DiscordRequest(`channels/${channelId}`, { method: 'GET' });
  const channel = await res.json();
  const everyone = (channel.permission_overwrites ?? []).find((o) => o.id === process.env.GUILD_ID);
  const denied = everyone && (BigInt(everyone.deny) & VIEW_CHANNEL) !== 0n;
  console.log(`${label} (#${channel.name}): @everyone VIEW_CHANNEL denied = ${Boolean(denied)}`);
  return Boolean(denied);
}

const shopChannel = process.env.SHOP_CHANNEL_ID;

// --- privacy ---
await checkPrivacy(shopChannel, 'SHOP_CHANNEL_ID');

// --- shop dry-run ---
const shopJson = await (await fetch('https://fortnite-api.com/v2/shop?language=pt-BR')).json();
const entries = (shopJson.data?.entries ?? [])
  .filter((e) => e.brItems?.length)
  .sort((a, b) => (a.sortPriority ?? 0) - (b.sortPriority ?? 0))
  .slice(0, 10);
const seenShop = readJsonSet('.last-shop-ids.json');
const newShop = entries.filter((e) => {
  const ids = getShopEntryDedupeIds(e);
  if (ids.length && ids.every((id) => seenShop.has(id))) return false;
  return !(e.offerId && seenShop.has(e.offerId));
});
console.log(`\nShop: ${entries.length} entries considered, ${newShop.length} unseen ->` +
  ` would post ${Math.min(newShop.length, 2)} now, ${Math.max(newShop.length - 2, 0)} pending`);
for (const e of newShop) console.log(`  UNSEEN: ${e.brItems[0]?.name} [${getShopEntryDedupeIds(e).join(', ')}]`);

// --- cross-check seen state vs what the bot actually posted ---
const botUser = await (await DiscordRequest('users/@me', { method: 'GET' })).json();
console.log('\n--- Posted shop item names vs seen ids ---');
const shopMsgs = (await channelMessages(shopChannel)).filter((m) => m.author?.id === botUser.id);
const postedShopText = shopMsgs.map(messageText).join('\n');
for (const e of entries) {
  const name = e.brItems[0]?.name;
  const seen = getShopEntryDedupeIds(e).every((id) => seenShop.has(id));
  const posted = name && postedShopText.includes(name);
  if (seen !== posted) console.log(`  MISMATCH: "${name}" seen=${seen} posted-in-channel=${posted}`);
}
console.log('(no MISMATCH lines above = state consistent for current shop)');
