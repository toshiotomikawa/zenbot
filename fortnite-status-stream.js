/**
 * FortniteStatus Filtered Stream → Discord (inactive unless explicitly enabled).
 *
 * Ingestion: GET /2/tweets/search/stream (X API v2 Filtered Stream, pay-per-use).
 * Recovery:  GET /2/users/:id/tweets?since_id=… (self-serve; no stream backfill).
 * Default:   FORTNITE_STATUS_STREAM_ENABLED is off — no live X/Discord traffic.
 *
 * Reliability:
 * - single serial queue worker (no concurrent drains)
 * - fatal pauses pipeline until recovery completes
 * - one publish path (worker only); recovery enqueues then drains via worker
 * - ordered processing; cursor advances only after successful publish
 * - limited retries; exhausted retries → pause + reconnect + recovery
 * - queue/hold overflow aborts connection (no silent drop)
 * - recovery must fully succeed before live/hold buffer is released
 * - backlog > RECOVERY_MAX does not partial-publish or advance cursor
 * - backoff counters reset only after a stable stream period
 *
 * Not X Activity API / post.create webhooks.
 * Does not register process signal handlers (preserves default process exit).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DiscordRequest, DiscordMultipartRequest, formatBrtDateAndTime } from './utils.js';
import { renderTweetScreenshot } from './twitter.js';

export const CACHE_FILE_NAME = '.last-fortnite-status-ids.json';
export const EVENT_FOOTER_PREFIX = 'FortniteStatus · Botélia · post:';
export const CANONICAL_SCREEN_NAME = 'FortniteStatus';
export const DEFAULT_RULE_VALUE = 'from:FortniteStatus';
export const DEFAULT_RULE_TAG = 'fortnitestatus-all';
export const DEFAULT_RECOVERY_MAX = 50;
export const DEFAULT_QUEUE_MAX = 100;
export const DEFAULT_HOLD_BUFFER_MAX = 100;
export const DEFAULT_WATCHDOG_MS = 30_000;
export const DEFAULT_STABLE_MS = 30_000;
export const DISCORD_TIMEOUT_MS = 20_000;
export const HISTORY_TIMEOUT_MS = 15_000;
export const TIMELINE_TIMEOUT_MS = 20_000;
export const RENDER_TIMEOUT_MS = 15_000;
export const PUBLISH_MAX_ATTEMPTS = 3;
export const MAX_SEEN_IDS = 500;
export const HISTORY_LIMIT = 50;
export const STREAM_USER_AGENT = 'ZenBot/1.0 (fortnite-status-stream)';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_PATH = path.join(MODULE_DIR, CACHE_FILE_NAME);

/** Official field pack for stream + timeline recovery. */
export const STREAM_QUERY = {
  'tweet.fields': [
    'id', 'text', 'author_id', 'created_at', 'entities', 'attachments',
    'referenced_tweets', 'conversation_id', 'in_reply_to_user_id',
    'public_metrics', 'edit_history_tweet_ids', 'edit_controls', 'note_tweet',
    'possibly_sensitive', 'lang', 'display_text_range',
  ].join(','),
  expansions: [
    'author_id', 'attachments.media_keys', 'referenced_tweets.id',
    'referenced_tweets.id.author_id', 'referenced_tweets.id.attachments.media_keys',
  ].join(','),
  'media.fields': [
    'media_key', 'type', 'url', 'preview_image_url', 'width', 'height',
    'alt_text', 'duration_ms', 'variants',
  ].join(','),
  'user.fields': [
    'id', 'name', 'username', 'profile_image_url', 'verified', 'verified_type', 'protected',
  ].join(','),
};

// ─── Timeouts ────────────────────────────────────────────────────────────────

export function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

/**
 * Combine abort signals. Uses AbortSignal.any when available.
 * @param {...(AbortSignal|null|undefined)} signals
 */
export function combineAbortSignals(...signals) {
  const list = signals.filter((s) => s && typeof s === 'object');
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const controller = new AbortController();
  const onAbort = () => {
    try { controller.abort(); } catch { /* ignore */ }
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Classify recovery/timeline HTTP failures for reconnect backoff.
 */
export function classifyRecoveryHttpError(status) {
  const s = Number(status);
  if (s === 429) return 'rate_limit';
  if (s === 500 || s === 502 || s === 503 || s === 504) return 'http';
  if (s === 400 || s === 401 || s === 403 || s === 404) return 'permanent';
  if (s >= 500) return 'http';
  if (s >= 400) return 'permanent';
  return 'network';
}

/**
 * Wait duration for rate-limit responses. Never less than safe backoff.
 * @param {number} attempt 0-based
 * @param {string|null} resetHeader unix seconds string from x-rate-limit-reset
 * @param {() => number} now
 */
export function rateLimitWaitMs(attempt, resetHeader, now = () => Date.now()) {
  const floor = computeBackoffMs('rate_limit', attempt);
  const resetUnix = Number(resetHeader);
  if (Number.isFinite(resetUnix) && resetUnix > 0) {
    const until = resetUnix * 1000 - now();
    return Math.max(floor, until, 1000);
  }
  return floor;
}

export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label}_timeout`);
          err.code = 'TIMEOUT';
          reject(err);
        }, ms);
        if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function readFortniteStatusStreamConfig(env = process.env) {
  const enabledRaw = env.FORTNITE_STATUS_STREAM_ENABLED;
  const enabled = enabledRaw === '1' || String(enabledRaw || '').toLowerCase() === 'true';
  const recoveryMax = Math.max(
    1,
    Number.parseInt(env.FORTNITE_STATUS_RECOVERY_MAX || String(DEFAULT_RECOVERY_MAX), 10) || DEFAULT_RECOVERY_MAX,
  );
  const queueMax = Math.max(
    1,
    Number.parseInt(env.FORTNITE_STATUS_QUEUE_MAX || String(DEFAULT_QUEUE_MAX), 10) || DEFAULT_QUEUE_MAX,
  );
  const holdBufferMax = Math.max(
    1,
    Number.parseInt(env.FORTNITE_STATUS_HOLD_BUFFER_MAX || String(DEFAULT_HOLD_BUFFER_MAX), 10)
      || DEFAULT_HOLD_BUFFER_MAX,
  );
  let renderMode = String(env.FORTNITE_STATUS_RENDER_MODE || 'auto').toLowerCase();
  if (!['png', 'embed', 'auto'].includes(renderMode)) renderMode = 'auto';

  return {
    enabled,
    bearerToken: env.X_API_BEARER_TOKEN || '',
    channelId: env.FORTNITE_STATUS_CHANNEL_ID || '',
    userId: env.FORTNITE_STATUS_USER_ID || '',
    ruleValue: env.FORTNITE_STATUS_RULE_VALUE || DEFAULT_RULE_VALUE,
    ruleTag: env.FORTNITE_STATUS_RULE_TAG || DEFAULT_RULE_TAG,
    cachePath: env.FORTNITE_STATUS_CACHE_PATH || DEFAULT_CACHE_PATH,
    renderMode,
    recoveryMax,
    queueMax,
    holdBufferMax,
    watchdogMs: DEFAULT_WATCHDOG_MS,
    stableMs: DEFAULT_STABLE_MS,
    discordToken: env.DISCORD_TOKEN || '',
    publishMaxAttempts: PUBLISH_MAX_ATTEMPTS,
  };
}

export function configReadyForLive(config) {
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  if (!config.bearerToken) return { ok: false, reason: 'missing_bearer' };
  if (!config.channelId) return { ok: false, reason: 'missing_channel' };
  if (!config.userId) return { ok: false, reason: 'missing_user_id' };
  if (!config.discordToken) return { ok: false, reason: 'missing_discord_token' };
  return { ok: true };
}

// ─── NDJSON ──────────────────────────────────────────────────────────────────

export function createNdjsonBuffer() {
  let buf = '';
  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      buf += text;
      const out = [];
      while (true) {
        const crlf = buf.indexOf('\r\n');
        const lf = buf.indexOf('\n');
        let idx = -1;
        let sepLen = 1;
        if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
          idx = crlf;
          sepLen = 2;
        } else if (lf !== -1) {
          idx = lf;
          sepLen = 1;
        }
        if (idx === -1) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + sepLen);
        out.push(line === '' ? { kind: 'keepalive' } : { kind: 'line', text: line });
      }
      return out;
    },
    /**
     * On stream close: drop incomplete trailing fragment (do NOT parse as event).
     * Complete lines are already emitted by push().
     */
    flushIncomplete() {
      const discarded = buf.length;
      buf = '';
      return { discarded };
    },
    /** @deprecated use flushIncomplete — incomplete remainder is never a valid event */
    flushRemainder() {
      return this.flushIncomplete();
    },
    get pending() {
      return buf;
    },
  };
}

export function parseStreamLine(text) {
  if (text == null || text === '') return { kind: 'keepalive' };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'invalid_json', rawLength: text.length };
  }
  if (json?.errors) return { kind: 'error', errors: json.errors, body: json };
  if (json?.data?.id) {
    return {
      kind: 'post',
      data: json.data,
      includes: json.includes || {},
      matchingRules: json.matching_rules || [],
    };
  }
  return { kind: 'unknown', body: json };
}

// ─── Normalize / adapter ─────────────────────────────────────────────────────

export function logicalPostId(post) {
  if (!post || typeof post !== 'object') return null;
  const hist = post.edit_history_tweet_ids;
  if (Array.isArray(hist) && hist.length && typeof hist[0] === 'string' && hist[0]) {
    return hist[0];
  }
  return typeof post.id === 'string' && post.id ? post.id : null;
}

export function isPostFromUser(post, userId) {
  if (!post || !userId) return false;
  return String(post.author_id) === String(userId);
}

export function normalizeV2Post(data, includes = {}, { userId } = {}) {
  if (!data || typeof data !== 'object' || !data.id) {
    return { ok: false, reason: 'missing_post' };
  }
  if (userId && !isPostFromUser(data, userId)) {
    return { ok: false, reason: 'wrong_author', authorId: data.author_id };
  }
  const logicalId = logicalPostId(data);
  if (!logicalId) return { ok: false, reason: 'missing_logical_id' };

  const refTypes = new Set((data.referenced_tweets || []).map((r) => r?.type).filter(Boolean));
  return {
    ok: true,
    post: data,
    includes: includes || {},
    logicalId,
    postId: data.id,
    isEdit: Array.isArray(data.edit_history_tweet_ids)
      && data.edit_history_tweet_ids.length > 1
      && data.edit_history_tweet_ids[data.edit_history_tweet_ids.length - 1] === data.id
      && data.edit_history_tweet_ids[0] !== data.id,
    isRetweet: refTypes.has('retweeted'),
    isReply: refTypes.has('replied_to') || !!data.in_reply_to_user_id,
    isQuote: refTypes.has('quoted'),
    createdAt: data.created_at || null,
  };
}

function indexById(list, idKey = 'id') {
  const map = new Map();
  for (const item of list || []) {
    if (item && item[idKey] != null) map.set(String(item[idKey]), item);
  }
  return map;
}

function indexMedia(list) {
  const map = new Map();
  for (const item of list || []) {
    if (item?.media_key) map.set(item.media_key, item);
  }
  return map;
}

function mediaFromKeys(keys, mediaMap) {
  const photos = [];
  const videos = [];
  for (const key of keys || []) {
    const m = mediaMap.get(key);
    if (!m) continue;
    if (m.type === 'photo') {
      photos.push({
        url: m.url || m.preview_image_url,
        width: m.width,
        height: m.height,
        altText: m.alt_text,
      });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const mp4 = (m.variants || [])
        .filter((v) => v.content_type === 'video/mp4' && v.url)
        .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
      videos.push({
        url: m.preview_image_url || mp4?.url,
        thumbnail_url: m.preview_image_url,
        duration: m.duration_ms,
        width: m.width,
        height: m.height,
      });
    }
  }
  return { photos, videos };
}

function adaptUser(user) {
  if (!user) {
    return { name: 'Unknown', screen_name: 'unknown', avatar_url: '', verification: null };
  }
  const verifiedType = user.verified_type || (user.verified ? 'blue' : null);
  return {
    name: user.name || user.username || 'Unknown',
    screen_name: user.username || 'unknown',
    avatar_url: user.profile_image_url || '',
    verification: user.verified || verifiedType
      ? { verified: true, type: verifiedType === 'none' ? null : verifiedType }
      : null,
  };
}

function postText(post) {
  if (post?.note_tweet?.text) return post.note_tweet.text;
  return post?.text || '';
}

function adaptOnePost(post, users, tweets, mediaMap, { asRetweetOf = null } = {}) {
  if (!post) return null;
  const author = adaptUser(users.get(String(post.author_id)));
  const keys = post.attachments?.media_keys || [];
  const media = mediaFromKeys(keys, mediaMap);
  const metrics = post.public_metrics || {};
  const created = post.created_at ? new Date(post.created_at) : new Date();
  const createdTs = Number.isFinite(created.getTime())
    ? Math.floor(created.getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  let quote = null;
  let replying_to = null;
  let text = postText(post);
  let retweeted_by = asRetweetOf || null;
  let displayAuthor = author;

  for (const ref of post.referenced_tweets || []) {
    if (ref.type === 'quoted') {
      const q = tweets.get(String(ref.id));
      if (q) {
        const qMedia = mediaFromKeys(q.attachments?.media_keys || [], mediaMap);
        quote = {
          text: postText(q),
          author: adaptUser(users.get(String(q.author_id))),
          media: qMedia.photos.length || qMedia.videos.length ? qMedia : undefined,
        };
      }
    }
    if (ref.type === 'replied_to') {
      const parent = tweets.get(String(ref.id));
      const parentUser = parent ? users.get(String(parent.author_id)) : null;
      replying_to = parentUser?.username || post.in_reply_to_user_id || 'user';
    }
    if (ref.type === 'retweeted') {
      const orig = tweets.get(String(ref.id));
      const reposter = author;
      if (orig) {
        const inner = adaptOnePost(orig, users, tweets, mediaMap);
        if (inner) {
          const origHandle = inner.author?.screen_name || 'user';
          return {
            ...inner,
            id: post.id,
            retweeted_by: reposter,
            // Keep original author on the card; flag repost clearly in text.
            text: `↻ @${reposter.screen_name} repostou @${origHandle}:\n${inner.text || ''}`.trim(),
            is_retweet_presentation: true,
          };
        }
      }
      text = `↻ @${reposter.screen_name} repostou:\n${postText(post)}`.trim();
      retweeted_by = reposter;
    }
  }

  return {
    id: post.id,
    text,
    created_at: post.created_at || created.toISOString(),
    created_timestamp: createdTs,
    author: displayAuthor,
    likes: metrics.like_count ?? 0,
    retweets: metrics.retweet_count ?? 0,
    replies: metrics.reply_count ?? 0,
    views: metrics.impression_count ?? 0,
    media: media.photos.length || media.videos.length ? media : undefined,
    quote: quote || undefined,
    replying_to: replying_to || undefined,
    retweeted_by: retweeted_by || undefined,
    is_retweet_presentation: !!retweeted_by,
  };
}

export function adaptV2PostToTweet(post, includes = {}) {
  const users = indexById(includes.users);
  const tweets = indexById(includes.tweets);
  tweets.set(String(post.id), post);
  const mediaMap = indexMedia(includes.media);
  return adaptOnePost(post, users, tweets, mediaMap);
}

/** Always FortniteStatus — never swap for includes/reposted authors. */
export function canonicalStatusUrl(postId) {
  return `https://x.com/${CANONICAL_SCREEN_NAME}/status/${postId}`;
}

export function buildEventFooter(logicalId) {
  return `${EVENT_FOOTER_PREFIX}${logicalId}`;
}

export function parseLogicalIdFromFooter(footerText) {
  if (typeof footerText !== 'string' || !footerText) return null;
  if (footerText.startsWith(EVENT_FOOTER_PREFIX)) {
    const id = footerText.slice(EVENT_FOOTER_PREFIX.length).trim();
    if (/^\d{1,25}$/.test(id)) return id;
  }
  const m = footerText.match(/post:(\d{1,25})\s*$/);
  return m ? m[1] : null;
}

// ─── Discord builders ────────────────────────────────────────────────────────

export function buildEmbedMessage(normalized, tweetLike, { formatBrt = formatBrtDateAndTime } = {}) {
  const post = normalized.post;
  const logicalId = normalized.logicalId;
  const url = canonicalStatusUrl(post.id);
  let text = (tweetLike?.text || postText(post) || '_Sem texto._').slice(0, 3900);

  const isRepost = !!(normalized.isRetweet || tweetLike?.is_retweet_presentation || tweetLike?.retweeted_by);
  const authorName = isRepost && tweetLike?.author
    ? tweetLike.author.name
    : (tweetLike?.author?.name || 'Fortnite Status');
  const authorUser = isRepost && tweetLike?.author
    ? tweetLike.author.screen_name
    : (tweetLike?.author?.screen_name || CANONICAL_SCREEN_NAME);

  const created = post.created_at ? new Date(post.created_at) : new Date();
  const { dateStr, timeStr } = formatBrt(created);
  const photo = tweetLike?.media?.photos?.[0]?.url
    || tweetLike?.media?.videos?.[0]?.thumbnail_url
    || tweetLike?.media?.videos?.[0]?.url;

  const embed = {
    author: {
      name: isRepost
        ? `Fortnite Status repostou · ${authorName} (@${authorUser})`
        : `${authorName} (@${authorUser})`,
      url,
      icon_url: tweetLike?.author?.avatar_url || undefined,
    },
    description: text,
    color: 0x1d9bf0,
    timestamp: created.toISOString(),
    fields: [
      { name: 'Link', value: `[Abrir no X](${url})`, inline: false },
      { name: 'Horário (BRT)', value: `${dateStr}, ${timeStr} BRT`, inline: true },
    ],
    footer: { text: buildEventFooter(logicalId) },
    url,
  };
  if (isRepost) {
    embed.fields.unshift({
      name: 'Tipo',
      value: 'Repost de @FortniteStatus',
      inline: true,
    });
  }
  if (photo && /^https?:\/\//i.test(photo)) {
    embed.image = { url: photo };
  }

  return {
    content: url,
    embeds: [embed],
    // Clear attachments on edit so stale PNG cannot remain.
    attachments: [],
    allowed_mentions: { parse: [] },
  };
}

export function buildPngPayloadJson(normalized) {
  const url = canonicalStatusUrl(normalized.post.id);
  return {
    content: url,
    embeds: [
      {
        footer: { text: buildEventFooter(normalized.logicalId) },
        color: 0x1d9bf0,
        description: normalized.isRetweet ? 'Repost de @FortniteStatus' : undefined,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// ─── Bounded FIFO queue ──────────────────────────────────────────────────────

export function createBoundedQueue(max = DEFAULT_QUEUE_MAX) {
  /** @type {any[]} */
  const items = [];
  let overflowCount = 0;
  return {
    get size() { return items.length; },
    get overflowCount() { return overflowCount; },
    get dropped() { return overflowCount; },
    get max() { return max; },
    peek() { return items[0]; },
    /**
     * @returns {{ ok: true } | { ok: false, reason: 'full' }}
     * Full queue does NOT drop the item — caller must abort stream/recovery.
     */
    push(item) {
      if (items.length >= max) {
        overflowCount += 1;
        return { ok: false, reason: 'full' };
      }
      items.push(item);
      return { ok: true };
    },
    shift() { return items.shift(); },
    unshift(item) {
      items.unshift(item);
    },
    clear() { items.length = 0; },
    toArray() { return [...items]; },
  };
}

/**
 * Serial worker: at most one active processItem at a time.
 * - retry: keep head, backoff
 * - fatal: remove head (cursor not advanced by processor), pause pipeline —
 *   never process later items until resume()
 * - success/skip/duplicate: dequeue and continue
 */
export function createSerialQueueWorker({
  queue,
  processItem,
  onOverflow,
  onFatal,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let busy = false;
  let stopped = false;
  let paused = false;
  let wake = null;
  let activeCount = 0;
  let concurrentPeaks = 0;
  let processCalls = 0;

  function notify() {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  }

  function waitForWork() {
    if (stopped) return Promise.resolve();
    if (!paused && queue.size > 0) return Promise.resolve();
    return new Promise((resolve) => { wake = resolve; });
  }

  async function run() {
    while (!stopped) {
      await waitForWork();
      if (stopped) break;
      if (paused || queue.size === 0) continue;
      if (busy) continue;
      busy = true;
      activeCount += 1;
      concurrentPeaks = Math.max(concurrentPeaks, activeCount);
      try {
        const item = queue.peek();
        if (!item) continue;
        processCalls += 1;
        const result = await processItem(item);
        if (result?.action === 'overflow') {
          onOverflow?.(result);
          continue;
        }
        if (result?.action === 'retry') {
          await sleep(result.delayMs || 500);
          continue;
        }
        if (result?.action === 'fatal') {
          // Remove failed head so recovery can re-fetch; do NOT process tail.
          if (queue.peek() === item) queue.shift();
          paused = true;
          onFatal?.(result);
          // Stay paused until resume() or stop()
          continue;
        }
        if (queue.peek() === item) queue.shift();
      } finally {
        activeCount -= 1;
        busy = false;
        notify();
      }
    }
  }

  async function waitUntilIdle({ timeoutMs = 60_000 } = {}) {
    const start = Date.now();
    // Always use real timer for idle wait so test doubles for process sleep
    // cannot starve the event loop.
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    while (busy || activeCount > 0) {
      if (Date.now() - start > timeoutMs) {
        const err = new Error('worker_idle_timeout');
        err.code = 'TIMEOUT';
        throw err;
      }
      await pause(10);
    }
  }

  return {
    push(item) {
      if (paused && !stopped) {
        // Allow enqueue while paused (recovery fill) but do not run until resume.
      }
      const r = queue.push(item);
      if (!r.ok) {
        onOverflow?.({ action: 'overflow', reason: 'full' });
        return r;
      }
      notify();
      return r;
    },
    notify,
    start() {
      stopped = false;
      paused = false;
      return run();
    },
    stop() {
      stopped = true;
      paused = false;
      notify();
    },
    pause() {
      paused = true;
      notify();
    },
    resume() {
      paused = false;
      notify();
    },
    waitUntilIdle,
    get busy() { return busy; },
    get paused() { return paused; },
    get concurrentPeaks() { return concurrentPeaks; },
    get activeCount() { return activeCount; },
    get processCalls() { return processCalls; },
  };
}

// ─── Seen store ──────────────────────────────────────────────────────────────

export function compareSnowflake(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a > b ? 1 : -1;
}

export function createFortniteStatusSeenStore({
  cachePath = DEFAULT_CACHE_PATH,
  maxIds = MAX_SEEN_IDS,
  fsImpl = fs,
} = {}) {
  const seen = new Set();
  /** @type {Map<string, { messageId: string, latestPostId: string }>} */
  const messages = new Map();
  let lastSinceId = null;
  let ready = false;
  let hadPriorState = false;

  function readDisk() {
    try {
      if (!fsImpl.existsSync(cachePath)) return { ok: true, source: 'missing' };
      const data = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
      for (const id of Array.isArray(data?.ids) ? data.ids : []) {
        if (typeof id === 'string' && id) seen.add(id);
      }
      if (data?.messages && typeof data.messages === 'object') {
        for (const [k, v] of Object.entries(data.messages)) {
          if (v?.messageId) {
            messages.set(k, {
              messageId: String(v.messageId),
              latestPostId: String(v.latestPostId || k),
            });
          }
        }
      }
      if (typeof data?.lastSinceId === 'string' && data.lastSinceId) {
        lastSinceId = data.lastSinceId;
      }
      if (seen.size || lastSinceId || messages.size) hadPriorState = true;
      return { ok: true, source: 'file' };
    } catch (err) {
      return { ok: false, source: 'error', error: err };
    }
  }

  function persist() {
    const ids = [...seen].slice(-maxIds);
    if (ids.length < seen.size) {
      seen.clear();
      for (const id of ids) seen.add(id);
    }
    const msgObj = {};
    for (const [k, v] of messages) msgObj[k] = v;
    const msgKeys = Object.keys(msgObj);
    if (msgKeys.length > maxIds) {
      for (const k of msgKeys.slice(0, msgKeys.length - maxIds)) {
        delete msgObj[k];
        messages.delete(k);
      }
    }
    const payload = `${JSON.stringify({
      ids,
      messages: msgObj,
      lastSinceId,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    const dir = path.dirname(cachePath);
    const tmp = path.join(dir, `${path.basename(cachePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.writeFileSync(tmp, payload, 'utf8');
      try {
        fsImpl.renameSync(tmp, cachePath);
      } catch {
        try { fsImpl.unlinkSync(cachePath); } catch { /* ignore */ }
        fsImpl.renameSync(tmp, cachePath);
      }
    } catch (err) {
      try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
      console.error('[fortnite-status-stream] Erro ao persistir cache:', err?.message || err);
    }
  }

  return {
    get ready() { return ready; },
    get hadPriorState() { return hadPriorState; },
    get lastSinceId() { return lastSinceId; },
    get size() { return seen.size; },
    markReady() { ready = true; },
    loadFromDisk() {
      const r = readDisk();
      ready = true;
      return r;
    },
    hasLogical(id) { return seen.has(id); },
    getMessage(logicalId) { return messages.get(logicalId) || null; },
    /**
     * Only call after successful Discord publish/update.
     */
    remember(logicalId, { messageId, latestPostId }) {
      if (!logicalId) return;
      seen.add(logicalId);
      if (messageId) {
        messages.set(logicalId, {
          messageId: String(messageId),
          latestPostId: String(latestPostId || logicalId),
        });
      }
      if (latestPostId) {
        if (!lastSinceId || compareSnowflake(String(latestPostId), lastSinceId) > 0) {
          lastSinceId = String(latestPostId);
        }
      }
      hadPriorState = true;
      persist();
    },
    importLogicalIds(ids) {
      for (const id of ids || []) {
        if (typeof id === 'string' && id) {
          seen.add(id);
          hadPriorState = true;
        }
      }
    },
    setLastSinceId(id) {
      if (id) {
        lastSinceId = String(id);
        hadPriorState = true;
      }
    },
    persist,
  };
}

// ─── Backoff / watchdog ──────────────────────────────────────────────────────

export function computeBackoffMs(kind, attempt) {
  const n = Math.max(0, attempt);
  if (kind === 'network') return Math.min(16_000, 250 * (n + 1));
  if (kind === 'rate_limit') return Math.min(3_600_000, 60_000 * (2 ** n));
  if (kind === 'publish') return Math.min(30_000, 500 * (2 ** n));
  return Math.min(320_000, 5_000 * (2 ** n));
}

export function classifyStreamHttpError(status) {
  return classifyRecoveryHttpError(status);
}

export function createWatchdog({ timeoutMs = DEFAULT_WATCHDOG_MS, onTimeout, now = () => Date.now() } = {}) {
  let last = now();
  let timer = null;
  return {
    touch() { last = now(); },
    start() {
      if (timer) clearInterval(timer);
      const intervalMs = Math.min(5_000, Math.max(25, Math.floor(timeoutMs / 3)));
      timer = setInterval(() => {
        if (now() - last >= timeoutMs) onTimeout?.({ lastActivityAt: last, timeoutMs });
      }, intervalMs);
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get lastActivityAt() { return last; },
  };
}

// ─── Discord history ─────────────────────────────────────────────────────────

export async function restoreSeenFromDiscord({
  channelId,
  discordRequest = DiscordRequest,
  limit = HISTORY_LIMIT,
  signal,
} = {}) {
  const keys = [];
  const messageMap = new Map();
  const res = await discordRequest(
    `channels/${channelId}/messages?limit=${Math.min(100, limit)}`,
    { method: 'GET', signal: signal || createTimeoutSignal(HISTORY_TIMEOUT_MS) },
  );
  const list = await res.json();
  if (!Array.isArray(list)) return { ok: true, keys, messageMap };
  for (const msg of list) {
    for (const emb of msg.embeds || []) {
      const id = parseLogicalIdFromFooter(emb.footer?.text || '');
      if (id) {
        keys.push(id);
        if (msg.id) messageMap.set(id, { messageId: msg.id, latestPostId: id });
      }
    }
  }
  return { ok: true, keys, messageMap };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

export async function publishNormalizedPost(normalized, {
  config,
  renderTweet = renderTweetScreenshot,
  discordRequest = DiscordRequest,
  discordMultipart = DiscordMultipartRequest,
  existingMessageId = null,
  signal,
  renderTimeoutMs = RENDER_TIMEOUT_MS,
} = {}) {
  const tweetLike = adaptV2PostToTweet(normalized.post, normalized.includes);
  const mode = config.renderMode || 'auto';
  const wantPng = mode === 'png' || mode === 'auto';

  // Edits always use embed + clear attachments (no stale PNG left behind).
  if (existingMessageId) {
    const embedBody = buildEmbedMessage(normalized, tweetLike);
    try {
      const res = await discordRequest(
        `channels/${config.channelId}/messages/${existingMessageId}`,
        { method: 'PATCH', body: embedBody, signal },
      );
      const json = await res.json().catch(() => ({}));
      return {
        ok: true,
        mode: 'embed_edit',
        messageId: json.id || existingMessageId,
        clearedAttachments: true,
      };
    } catch (err) {
      return { ok: false, reason: 'discord_failed', error: err };
    }
  }

  if (wantPng && tweetLike) {
    try {
      const buffer = await withTimeout(renderTweet(tweetLike), renderTimeoutMs, 'render');
      const payload = buildPngPayloadJson(normalized, tweetLike);
      const res = await discordMultipart(
        `channels/${config.channelId}/messages`,
        {
          method: 'POST',
          payloadJson: payload,
          files: [{ name: 'fortnitestatus.png', buffer, contentType: 'image/png' }],
          signal,
        },
      );
      const json = await res.json();
      return { ok: true, mode: 'png', messageId: json.id };
    } catch (err) {
      if (mode === 'png') return { ok: false, reason: 'png_failed', error: err };
      console.error('[fortnite-status-stream] PNG falhou, usando embed:', err?.message || err);
    }
  }

  const embedBody = buildEmbedMessage(normalized, tweetLike);
  try {
    const res = await discordRequest(
      `channels/${config.channelId}/messages`,
      { method: 'POST', body: embedBody, signal },
    );
    const json = await res.json();
    return { ok: true, mode: 'embed', messageId: json.id };
  } catch (err) {
    return { ok: false, reason: 'discord_failed', error: err };
  }
}

// ─── Timeline recovery ───────────────────────────────────────────────────────

/** Clamp requested page size to X user-timeline limits (5–100). */
export function clampTimelineMaxResults(remaining) {
  const n = Math.max(1, Number(remaining) || 1);
  return Math.min(100, Math.max(5, n));
}

export function buildUserTimelineUrl(userId, { sinceId, paginationToken, maxResults = 100 } = {}) {
  const params = new URLSearchParams({
    max_results: String(clampTimelineMaxResults(maxResults)),
    ...STREAM_QUERY,
  });
  if (sinceId) params.set('since_id', sinceId);
  if (paginationToken) params.set('pagination_token', paginationToken);
  return `https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?${params}`;
}

export function buildStreamUrl() {
  return `https://api.x.com/2/tweets/search/stream?${new URLSearchParams(STREAM_QUERY)}`;
}

export async function fetchRecoveryPosts({
  userId,
  sinceId,
  recoveryMax = DEFAULT_RECOVERY_MAX,
  bearerToken,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!sinceId) {
    return {
      ok: true,
      skipped: true,
      complete: true,
      reason: 'no_since_id',
      posts: [],
      requests: [],
      capped: false,
    };
  }
  // Collect up to recoveryMax + 1 to detect backlog beyond the safe limit.
  const hardCap = recoveryMax + 1;
  const collected = [];
  const requests = [];
  let token = null;
  let pages = 0;
  const maxPages = 20;
  let sawNextTokenAtLimit = false;

  while (collected.length < hardCap && pages < maxPages) {
    pages += 1;
    const remaining = hardCap - collected.length;
    const maxResults = clampTimelineMaxResults(remaining);
    const url = buildUserTimelineUrl(userId, {
      sinceId,
      paginationToken: token,
      maxResults,
    });
    requests.push({ maxResults, remaining });
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'User-Agent': STREAM_USER_AGENT,
      },
      signal: signal || createTimeoutSignal(TIMELINE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const backoffKind = classifyRecoveryHttpError(res.status);
      let rateLimitReset = null;
      try {
        rateLimitReset = res.headers?.get?.('x-rate-limit-reset')
          ?? res.headers?.get?.('X-Rate-Limit-Reset')
          ?? null;
      } catch { /* ignore */ }
      return {
        ok: false,
        complete: false,
        reason: backoffKind === 'permanent' ? 'timeline_permanent' : 'timeline_http',
        status: res.status,
        backoffKind,
        rateLimitReset,
        posts: [],
        capped: false,
        requests,
      };
    }
    const body = await res.json();
    const batch = Array.isArray(body.data) ? body.data : [];
    const includes = body.includes || {};
    for (const post of batch) {
      collected.push({ post, includes });
      if (collected.length >= hardCap) break;
    }
    token = body.meta?.next_token || null;
    if (collected.length >= recoveryMax && token) {
      sawNextTokenAtLimit = true;
      // Stop without extra billable pages — backlog already exceeds the safe limit.
      break;
    }
    if (!token || batch.length === 0) break;
    if (collected.length >= hardCap) break;
  }

  const sorted = sortPostsChronological(collected);
  const capped = sorted.length > recoveryMax || sawNextTokenAtLimit;
  if (capped) {
    // Do not return publishable posts — incomplete backlog must not advance cursor.
    return {
      ok: false,
      complete: false,
      reason: 'backlog_exceeded',
      backoffKind: 'blocked',
      capped: true,
      posts: [],
      requests,
      collectedCount: sorted.length,
    };
  }
  return {
    ok: true,
    complete: true,
    posts: sorted.slice(0, recoveryMax),
    capped: false,
    skipped: false,
    requests,
  };
}

function sortPostsChronological(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.post.created_at || 0) || 0;
    const tb = Date.parse(b.post.created_at || 0) || 0;
    if (ta !== tb) return ta - tb;
    const ida = a.post.id || '';
    const idb = b.post.id || '';
    if (ida.length !== idb.length) return ida.length - idb.length;
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
}

// ─── Processor (single item, ordered by worker) ──────────────────────────────

export function createPostProcessor({
  config,
  seenStore,
  publish = publishNormalizedPost,
  createTimeout = createTimeoutSignal,
  maxAttempts = PUBLISH_MAX_ATTEMPTS,
} = {}) {
  /** Defense: concurrent handleNormalized for same logical id. */
  const inFlightLogical = new Set();
  let concurrentPublish = 0;
  let concurrentPublishPeak = 0;

  /**
   * Process one normalized post. Does not manage queue position.
   * @returns {Promise<{ action: string, ... }>}
   */
  async function handleNormalized(normalized, { source = 'stream', attempt = 0 } = {}) {
    if (!normalized?.ok) {
      return { action: 'skip', reason: normalized?.reason || 'invalid' };
    }
    const { logicalId, postId } = normalized;
    if (inFlightLogical.has(logicalId)) {
      return { action: 'duplicate_inflight', logicalId, postId };
    }
    inFlightLogical.add(logicalId);
    concurrentPublish += 1;
    concurrentPublishPeak = Math.max(concurrentPublishPeak, concurrentPublish);
    try {
      const existing = seenStore.getMessage(logicalId);
      const alreadySeen = seenStore.hasLogical(logicalId);

      if (existing?.latestPostId === postId) {
        return { action: 'duplicate', logicalId, postId };
      }

      if (alreadySeen && existing?.messageId) {
        const published = await publish(normalized, {
          config,
          existingMessageId: existing.messageId,
          signal: createTimeout(DISCORD_TIMEOUT_MS),
        });
        if (!published.ok) {
          if (attempt + 1 < maxAttempts) {
            return {
              action: 'retry',
              reason: published.reason,
              logicalId,
              attempt: attempt + 1,
              delayMs: computeBackoffMs('publish', attempt),
            };
          }
          return {
            action: 'fatal',
            reason: published.reason || 'publish_exhausted',
            logicalId,
            postId,
          };
        }
        seenStore.remember(logicalId, {
          messageId: published.messageId,
          latestPostId: postId,
        });
        console.log(`[fortnite-status-stream] Atualizado ${logicalId} (post ${postId}) via ${source}`);
        return { action: 'updated', logicalId, postId, messageId: published.messageId };
      }

      if (alreadySeen && !existing?.messageId) {
        seenStore.remember(logicalId, { messageId: null, latestPostId: postId });
        return { action: 'duplicate_logical', logicalId, postId };
      }

      const published = await publish(normalized, {
        config,
        signal: createTimeout(DISCORD_TIMEOUT_MS),
      });
      if (!published.ok) {
        if (attempt + 1 < maxAttempts) {
          return {
            action: 'retry',
            reason: published.reason,
            logicalId,
            attempt: attempt + 1,
            delayMs: computeBackoffMs('publish', attempt),
          };
        }
        return {
          action: 'fatal',
          reason: published.reason || 'publish_exhausted',
          logicalId,
          postId,
        };
      }
      seenStore.remember(logicalId, {
        messageId: published.messageId,
        latestPostId: postId,
      });
      console.log(
        `[fortnite-status-stream] Publicado ${logicalId} (post ${postId}) mode=${published.mode} via ${source}`,
      );
      return {
        action: 'posted',
        logicalId,
        postId,
        messageId: published.messageId,
        mode: published.mode,
      };
    } finally {
      concurrentPublish -= 1;
      inFlightLogical.delete(logicalId);
    }
  }

  return {
    handleNormalized,
    get concurrentPublishPeak() { return concurrentPublishPeak; },
    get inFlightSize() { return inFlightLogical.size; },
  };
}

// ─── Client lifecycle ────────────────────────────────────────────────────────

export function createFortniteStatusStreamClient(options = {}) {
  const config = options.config || readFortniteStatusStreamConfig(options.env || process.env);
  const seenStore = options.seenStore || createFortniteStatusSeenStore({
    cachePath: config.cachePath,
  });
  const queue = options.queue || createBoundedQueue(config.queueMax);
  const processor = options.processor || createPostProcessor({
    config,
    seenStore,
    maxAttempts: config.publishMaxAttempts || PUBLISH_MAX_ATTEMPTS,
  });
  const fetchImpl = options.fetchImpl || fetch;
  const discordRequest = options.discordRequest || DiscordRequest;
  const allowDiscordHistory = options.allowDiscordHistory !== false;
  const sleepFn = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const holdBufferMax = config.holdBufferMax || DEFAULT_HOLD_BUFFER_MAX;
  const stableMs = config.stableMs || DEFAULT_STABLE_MS;
  const nowFn = options.now || (() => Date.now());

  let running = false;
  let stopping = false;
  /** Monotonic connection attempt id. Only the current attempt may release live mode. */
  let attemptGeneration = 0;
  /** @type {AbortController|null} */
  let abortController = null;
  let networkAttempt = 0;
  let httpAttempt = 0;
  let rateAttempt = 0;
  let loopPromise = null;
  let workerPromise = null;
  /** Stream posts go to holdBuffer until recovery completes successfully. */
  let holdingStream = true;
  /** Live mode only after successful recovery phase. */
  let liveMode = false;
  /** @type {any[]} */
  let holdBuffer = [];
  let needRecovery = true;
  let lastClearWhileBusy = false;
  /** Timestamp when connection became "stable candidate" (first keepalive/event). */
  let stableAnchorAt = null;
  let connectionOpenedAt = null;
  /**
   * Blocked operator state: no billable recovery/stream loops.
   * Values: null | 'backlog_exceeded' | 'auth_or_config'
   */
  let blockedReason = null;
  /** Wakes interruptible blocked sleep (stop() must not wait 60s). */
  let blockedSleepWake = null;
  /** Stream open count (tests). */
  let streamConnectCount = 0;
  /** Timeline recovery fetch count (tests). */
  let recoveryFetchCount = 0;
  /** Last structured disconnect for loop backoff. */
  let lastDisconnect = null;
  /** Record of delays used by runLoop (for tests). */
  const reconnectDelays = [];

  function isAttemptCurrent(attemptId) {
    if (attemptId !== attemptGeneration) return false;
    if (stopping) return false;
    // Aborted stream/controller invalidates the in-flight barrier.
    if (abortController && abortController.signal.aborted) return false;
    return true;
  }

  const requestReconnect = (reason, { invalidate = true } = {}) => {
    console.error(`[fortnite-status-stream] Reconexão solicitada: ${reason}`);
    needRecovery = true;
    liveMode = false;
    holdingStream = true;
    worker.pause();
    if (invalidate) {
      // Invalidate current connectOnce generation so a late recovery cannot go live.
      attemptGeneration += 1;
    }
    try { abortController?.abort(); } catch { /* ignore */ }
  };

  const worker = createSerialQueueWorker({
    queue,
    sleep: sleepFn,
    onOverflow: () => requestReconnect('queue_overflow'),
    onFatal: (r) => requestReconnect(r?.reason || 'publish_fatal'),
    processItem: async (item) => {
      if (item.kind !== 'post') return { action: 'skip' };
      const normalized = normalizeV2Post(item.data, item.includes, { userId: config.userId });
      const attempt = item.attempt || 0;
      const result = await processor.handleNormalized(normalized, {
        source: item.source || 'stream',
        attempt,
      });
      if (result.action === 'retry') {
        item.attempt = result.attempt;
        return result;
      }
      return result;
    },
  });

  const watchdog = createWatchdog({
    timeoutMs: config.watchdogMs,
    onTimeout: () => {
      console.error('[fortnite-status-stream] Watchdog: sem dados/keep-alive — abortando conexão');
      requestReconnect('watchdog');
    },
  });

  function noteStreamActivity() {
    watchdog.touch();
    const t = nowFn();
    if (stableAnchorAt == null) stableAnchorAt = t;
    if (stableAnchorAt != null && t - stableAnchorAt >= stableMs) {
      // Only reset backoff after a reasonably stable connection period.
      networkAttempt = 0;
      httpAttempt = 0;
      rateAttempt = 0;
    }
  }

  async function ensureSeenReady() {
    if (seenStore.ready) return { ok: true };
    const disk = seenStore.loadFromDisk();
    if (disk.ok && disk.source === 'file') return { ok: true, source: 'file' };
    if (config.channelId && config.discordToken && allowDiscordHistory) {
      try {
        const restored = await restoreSeenFromDiscord({
          channelId: config.channelId,
          discordRequest,
          signal: createTimeoutSignal(HISTORY_TIMEOUT_MS),
        });
        if (restored.ok && restored.keys.length) {
          seenStore.importLogicalIds(restored.keys);
          for (const [k, v] of restored.messageMap) {
            seenStore.remember(k, v);
          }
          seenStore.markReady();
          return { ok: true, source: 'discord' };
        }
      } catch (err) {
        console.error(
          '[fortnite-status-stream] Histórico Discord indisponível/timeout:',
          err?.message || err,
        );
      }
    }
    seenStore.markReady();
    return { ok: true, source: disk.source || 'empty' };
  }

  function pushHold(data, includes) {
    if (holdBuffer.length >= holdBufferMax) {
      console.error('[fortnite-status-stream] holdBuffer cheio — abortando (sem descarte silencioso)');
      requestReconnect('hold_overflow');
      return { ok: false, reason: 'full' };
    }
    holdBuffer.push({ kind: 'post', data, includes, source: 'stream', attempt: 0 });
    return { ok: true, held: true };
  }

  function enqueueLive(data, includes, source) {
    const r = worker.push({ kind: 'post', data, includes, source, attempt: 0 });
    if (!r.ok) {
      console.error('[fortnite-status-stream] Fila cheia — abortando conexão');
      requestReconnect('queue_overflow');
    }
    return r;
  }

  function enqueuePost(data, includes, source) {
    if (!liveMode || holdingStream || source === 'hold') {
      // During recovery phase only stream events are held.
      if (source === 'stream' || source === 'hold') return pushHold(data, includes);
    }
    return enqueueLive(data, includes, source);
  }

  /**
   * Enqueue recovery posts then held stream posts. Worker must be paused.
   * Only call after recovery is complete and successful.
   */
  function loadQueueRecoveryThenHold(recoveryPosts) {
    for (const { post, includes } of recoveryPosts) {
      const r = queue.push({
        kind: 'post',
        data: post,
        includes,
        source: 'recovery',
        attempt: 0,
      });
      if (!r.ok) {
        requestReconnect('queue_overflow');
        return { ok: false, reason: 'full' };
      }
    }
    const held = holdBuffer;
    holdBuffer = [];
    for (const item of held) {
      const r = queue.push(item);
      if (!r.ok) {
        requestReconnect('queue_overflow');
        return { ok: false, reason: 'full' };
      }
    }
    return { ok: true };
  }

  /**
   * Fetch recovery posts only (no publish). Returns complete:true only when safe.
   * @param {{ signal?: AbortSignal }} opts
   */
  async function fetchRecoveryPhase({ signal } = {}) {
    if (blockedReason) {
      return {
        ok: false,
        complete: false,
        reason: blockedReason,
        backoffKind: 'blocked',
        posts: [],
      };
    }
    await ensureSeenReady();
    if (!seenStore.hadPriorState || !seenStore.lastSinceId) {
      console.log('[fortnite-status-stream] Recovery omitida (sem since_id / primeiro início)');
      return { ok: true, complete: true, skipped: true, reason: 'no_prior_state', posts: [] };
    }
    try {
      recoveryFetchCount += 1;
      const timeoutSig = createTimeoutSignal(TIMELINE_TIMEOUT_MS);
      const combined = combineAbortSignals(signal, timeoutSig);
      const result = await fetchRecoveryPosts({
        userId: config.userId,
        sinceId: seenStore.lastSinceId,
        recoveryMax: config.recoveryMax,
        bearerToken: config.bearerToken,
        fetchImpl,
        signal: combined,
      });
      if (result.skipped) {
        return { ok: true, complete: true, skipped: true, posts: [], reason: result.reason };
      }
      if (!result.ok || !result.complete) {
        console.error(
          `[fortnite-status-stream] Recovery incompleta/falhou: ${result.reason || result.status || 'error'}`,
        );
        return {
          ok: false,
          complete: false,
          reason: result.reason || 'recovery_failed',
          status: result.status,
          backoffKind: result.backoffKind
            || (result.reason === 'backlog_exceeded' ? 'blocked' : 'http'),
          rateLimitReset: result.rateLimitReset,
          posts: [],
        };
      }
      return {
        ok: true,
        complete: true,
        posts: result.posts,
        requests: result.requests,
      };
    } catch (err) {
      const aborted = err?.name === 'AbortError' || signal?.aborted;
      console.error('[fortnite-status-stream] Recovery falhou:', err?.message || err);
      return {
        ok: false,
        complete: false,
        reason: aborted
          ? 'aborted'
          : (err?.code === 'TIMEOUT' ? 'timeout' : 'exception'),
        backoffKind: aborted || err?.code === 'TIMEOUT' ? 'network' : 'network',
        error: err,
        posts: [],
      };
    }
  }

  /**
   * Drain queue via worker until empty. Worker must be resumed.
   * If fatal occurs, worker pauses and needRecovery is set.
   */
  async function drainQueueUntilEmpty({ timeoutMs = 300_000, attemptId } = {}) {
    const start = Date.now();
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    while (queue.size > 0 || worker.busy) {
      if (attemptId != null && !isAttemptCurrent(attemptId)) {
        return { ok: false, complete: false, reason: 'attempt_invalidated', backoffKind: 'network' };
      }
      if (stopping) {
        return { ok: false, complete: false, reason: 'stopping', backoffKind: 'network' };
      }
      if (needRecovery && worker.paused) {
        return { ok: false, complete: false, reason: 'fatal_or_reconnect', backoffKind: 'network' };
      }
      if (Date.now() - start > timeoutMs) {
        return { ok: false, complete: false, reason: 'drain_timeout', backoffKind: 'network' };
      }
      await pause(15);
    }
    return { ok: true, complete: true };
  }

  function handleStreamEvents(events) {
    for (const ev of events) {
      if (ev.kind === 'keepalive') {
        noteStreamActivity();
        continue;
      }
      const parsed = parseStreamLine(ev.text);
      if (parsed.kind === 'keepalive') {
        noteStreamActivity();
        continue;
      }
      if (parsed.kind === 'invalid_json') {
        console.error('[fortnite-status-stream] Linha JSON inválida (ignorada)');
        continue;
      }
      if (parsed.kind === 'error') {
        console.error(
          '[fortnite-status-stream] Erro no stream:',
          parsed.errors?.[0]?.title || 'error',
        );
        requestReconnect('stream_error');
        continue;
      }
      if (parsed.kind === 'post') {
        noteStreamActivity();
        enqueuePost(parsed.data, parsed.includes, 'stream');
      }
    }
  }

  async function prepareForReconnect() {
    // Pause worker; wait for in-flight publish to finish; then clear idle queue.
    worker.pause();
    await worker.waitUntilIdle({ timeoutMs: 120_000 });
    if (worker.busy || worker.activeCount > 0) {
      lastClearWhileBusy = true;
      throw new Error('cannot_clear_queue_while_busy');
    }
    lastClearWhileBusy = false;
    queue.clear();
    holdBuffer = [];
    liveMode = false;
    holdingStream = true;
  }

  /**
   * Run recovery + optional queue load under a generation gate.
   * Never releases live mode if attempt was invalidated mid-flight.
   */
  async function runBarrier(attemptId, signal) {
    let barrier = { ok: false, complete: false, reason: 'not_started' };

    const recoveryOutcome = await fetchRecoveryPhase({ signal });
    if (!isAttemptCurrent(attemptId)) {
      return {
        ok: false,
        complete: false,
        reason: 'attempt_invalidated',
        backoffKind: 'network',
        invalidated: true,
      };
    }

    if (!recoveryOutcome.ok || !recoveryOutcome.complete) {
      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();
      barrier = {
        ok: false,
        complete: false,
        reason: recoveryOutcome.reason || 'recovery_failed',
        backoffKind: recoveryOutcome.backoffKind || 'network',
        status: recoveryOutcome.status,
        rateLimitReset: recoveryOutcome.rateLimitReset,
      };
      if (recoveryOutcome.reason === 'backlog_exceeded') {
        blockedReason = 'backlog_exceeded';
        barrier.backoffKind = 'blocked';
        console.error(
          '[fortnite-status-stream] Backlog excede FORTNITE_STATUS_RECOVERY_MAX — '
          + 'cliente bloqueado. Aumente o limite deliberadamente e reinicie o processo. '
          + 'Nenhuma recovery billable adicional será tentada neste processo.',
        );
      } else if (recoveryOutcome.backoffKind === 'permanent' || recoveryOutcome.reason === 'timeline_permanent') {
        blockedReason = 'auth_or_config';
        barrier.backoffKind = 'blocked';
        console.error(
          `[fortnite-status-stream] Erro permanente de recovery (HTTP ${recoveryOutcome.status}) — cliente bloqueado.`,
        );
      }
      return barrier;
    }

    // Load recovery → hold only if still the current attempt.
    if (!isAttemptCurrent(attemptId)) {
      return {
        ok: false,
        complete: false,
        reason: 'attempt_invalidated',
        backoffKind: 'network',
        invalidated: true,
      };
    }

    const loaded = loadQueueRecoveryThenHold(recoveryOutcome.posts || []);
    if (!loaded.ok) {
      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();
      return {
        ok: false,
        complete: false,
        reason: loaded.reason || 'queue_overflow',
        backoffKind: 'network',
      };
    }

    if (!isAttemptCurrent(attemptId)) {
      // Do not resume worker or clear needRecovery for a stale attempt.
      // Leave queue as-is; prepareForReconnect of the next attempt will clear when idle.
      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();
      return {
        ok: false,
        complete: false,
        reason: 'attempt_invalidated',
        backoffKind: 'network',
        invalidated: true,
      };
    }

    holdingStream = false;
    liveMode = true;
    needRecovery = false;
    worker.resume();

    const drained = await drainQueueUntilEmpty({ attemptId });
    if (!drained.ok || !drained.complete) {
      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();
      if (isAttemptCurrent(attemptId)) {
        try { abortController?.abort(); } catch { /* ignore */ }
      }
      return {
        ok: false,
        complete: false,
        reason: drained.reason || 'drain_failed',
        backoffKind: drained.backoffKind || 'network',
      };
    }

    if (!isAttemptCurrent(attemptId)) {
      // Drain finished but attempt was superseded — do not claim success for live.
      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();
      return {
        ok: false,
        complete: false,
        reason: 'attempt_invalidated',
        backoffKind: 'network',
        invalidated: true,
      };
    }

    return { ok: true, complete: true, reason: 'ok', ...recoveryOutcome };
  }

  async function connectOnce(signal) {
    const attemptId = attemptGeneration;
    await prepareForReconnect();
    if (!isAttemptCurrent(attemptId)) {
      const err = new Error('attempt_invalidated');
      err.backoffKind = 'network';
      throw err;
    }

    const url = buildStreamUrl();
    streamConnectCount += 1;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        'User-Agent': STREAM_USER_AGENT,
      },
      signal,
    });

    if (!res.ok) {
      const kind = classifyStreamHttpError(res.status);
      let rateLimitReset = null;
      try {
        rateLimitReset = res.headers?.get?.('x-rate-limit-reset')
          ?? res.headers?.get?.('X-Rate-Limit-Reset')
          ?? null;
      } catch { /* ignore */ }
      // Discard body without logging (may contain sensitive details).
      try { await res.text(); } catch { /* ignore */ }

      needRecovery = true;
      liveMode = false;
      holdingStream = true;
      worker.pause();

      if (kind === 'permanent') {
        blockedReason = 'auth_or_config';
        console.error(
          `[fortnite-status-stream] Erro permanente do Filtered Stream (HTTP ${res.status}) — `
          + 'cliente bloqueado (auth/config). Verifique Bearer, app e regras do stream. '
          + 'Reinicie o processo após corrigir. Sem novas conexões neste processo.',
        );
      }

      const err = new Error(`stream_http_${res.status}`);
      err.status = res.status;
      err.backoffKind = kind === 'permanent' ? 'blocked' : kind;
      err.rateLimitReset = rateLimitReset;
      if (kind === 'permanent') err.blockedReason = 'auth_or_config';
      throw err;
    }

    // Do NOT reset backoff counters on mere HTTP 200 — wait for stable period.
    connectionOpenedAt = nowFn();
    stableAnchorAt = null;
    holdingStream = true;
    liveMode = false;
    holdBuffer = [];
    watchdog.touch();
    watchdog.start();

    const ndjson = createNdjsonBuffer();
    const body = res.body;

    // Full barrier outcome (timeline + load + drain), not just timeline success.
    let barrierOutcome = { ok: false, complete: false, reason: 'not_started' };
    const barrierPromise = (async () => {
      barrierOutcome = await runBarrier(attemptId, signal);
      if (!barrierOutcome.ok || !barrierOutcome.complete) {
        if (isAttemptCurrent(attemptId) && barrierOutcome.backoffKind !== 'blocked') {
          // Invalidate so no late path can go live; abort stream read.
          requestReconnect(barrierOutcome.reason || 'barrier_failed');
        } else if (isAttemptCurrent(attemptId) && barrierOutcome.backoffKind === 'blocked') {
          worker.pause();
          liveMode = false;
          holdingStream = true;
          needRecovery = true;
          try { abortController?.abort(); } catch { /* ignore */ }
        }
      }
      return barrierOutcome;
    })();

    try {
      if (!body || typeof body.getReader !== 'function') {
        if (body && Symbol.asyncIterator in Object(body)) {
          for await (const chunk of body) {
            if (signal.aborted || !isAttemptCurrent(attemptId)) break;
            handleStreamEvents(ndjson.push(chunk));
          }
        } else {
          throw new Error('stream_body_unavailable');
        }
      } else {
        const reader = body.getReader();
        const decoder = new TextDecoder('utf-8');
        while (!signal.aborted && isAttemptCurrent(attemptId)) {
          const { done, value } = await reader.read();
          if (done) break;
          handleStreamEvents(ndjson.push(decoder.decode(value, { stream: true })));
        }
      }
    } finally {
      ndjson.flushIncomplete();
      await barrierPromise.catch(() => {});
      // Represent entire barrier in finally, not only timeline fetch success.
      if (!barrierOutcome.ok || !barrierOutcome.complete) {
        needRecovery = true;
        liveMode = false;
        holdingStream = true;
        worker.pause();
        lastDisconnect = {
          reason: barrierOutcome.reason || 'barrier_failed',
          backoffKind: barrierOutcome.backoffKind || 'network',
          status: barrierOutcome.status,
          rateLimitReset: barrierOutcome.rateLimitReset,
        };
      } else {
        lastDisconnect = null;
      }
    }

    if (lastDisconnect && lastDisconnect.backoffKind === 'blocked') {
      const err = new Error(lastDisconnect.reason || 'blocked');
      err.backoffKind = 'blocked';
      err.blockedReason = blockedReason;
      throw err;
    }
    if (lastDisconnect && !lastDisconnect.reason?.includes('attempt_invalidated')) {
      // Propagate structured failure to runLoop for correct backoff class.
      const err = new Error(lastDisconnect.reason || 'barrier_failed');
      err.backoffKind = lastDisconnect.backoffKind || 'network';
      err.status = lastDisconnect.status;
      err.rateLimitReset = lastDisconnect.rateLimitReset;
      // Only throw if we didn't cleanly finish live streaming.
      if (!barrierOutcome.ok) throw err;
    }
  }

  async function sleep(ms, signal) {
    if (ms <= 0) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal?.aborted) {
        clearTimeout(t);
        resolve();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  /**
   * Real-timer blocked wait (always). stop() wakes immediately via blockedSleepWake.
   * Intentionally does NOT use injectable sleepFn — noop sleep would tight-loop the
   * blocked state and starve the event loop / flood logs.
   */
  async function sleepBlocked(ms) {
    if (ms <= 0 || stopping || !running) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (blockedSleepWake === wake) blockedSleepWake = null;
        resolve();
      };
      const wake = () => finish();
      const t = setTimeout(finish, ms);
      if (typeof t === 'object' && typeof t.unref === 'function') t.unref();
      blockedSleepWake = wake;
      if (stopping || !running) finish();
    });
  }

  /**
   * Reconnect backoff: injectable sleepFn for tests, raced with stop() wake.
   */
  async function sleepReconnect(ms) {
    if (ms <= 0 || stopping || !running) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (blockedSleepWake === wake) blockedSleepWake = null;
        resolve();
      };
      const wake = () => finish();
      blockedSleepWake = wake;
      if (stopping || !running) {
        finish();
        return;
      }
      Promise.resolve()
        .then(() => sleepFn(ms))
        .then(finish, finish);
    });
  }

  async function runLoop() {
    await ensureSeenReady();
    workerPromise = worker.start();
    worker.pause(); // start paused; connectOnce resumes after recovery
    needRecovery = true;

    while (running && !stopping) {
      if (blockedReason) {
        console.error(
          `[fortnite-status-stream] Cliente bloqueado (${blockedReason}) — sem novas conexões/recoveries. Reinicie após corrigir config.`,
        );
        // Interruptible: stop() must not wait the full interval.
        await sleepBlocked(60_000);
        continue;
      }

      attemptGeneration += 1;
      const attemptId = attemptGeneration;
      abortController = new AbortController();
      const signal = abortController.signal;
      try {
        console.log(`[fortnite-status-stream] Conectando (attempt=${attemptId})…`);
        await connectOnce(signal);
        if (stopping || !running) break;
        // Clean remote close after live session.
        needRecovery = true;
        liveMode = false;
        holdingStream = true;
        worker.pause();
        networkAttempt += 1;
        const wait = computeBackoffMs('network', networkAttempt - 1);
        reconnectDelays.push({ kind: 'network', wait, attempt: networkAttempt - 1 });
        console.error(`[fortnite-status-stream] Stream fechou; reconectando em ${wait}ms`);
        await sleepReconnect(wait);
      } catch (err) {
        if (stopping || !running) break;
        if (err?.name === 'AbortError' && stopping) break;
        needRecovery = true;
        liveMode = false;
        holdingStream = true;
        worker.pause();

        if (err?.blockedReason) blockedReason = err.blockedReason;
        if (err?.backoffKind === 'blocked' || blockedReason) {
          if (!blockedReason) blockedReason = err?.blockedReason || 'auth_or_config';
          // Next loop iteration enters blocked sleep (interruptible).
          continue;
        }

        const kind = err?.backoffKind || 'network';
        let attempt;
        let wait;
        if (kind === 'rate_limit') {
          rateAttempt += 1;
          attempt = rateAttempt - 1;
          wait = rateLimitWaitMs(attempt, err?.rateLimitReset, nowFn);
        } else if (kind === 'http') {
          httpAttempt += 1;
          attempt = httpAttempt - 1;
          wait = computeBackoffMs('http', attempt);
        } else {
          networkAttempt += 1;
          attempt = networkAttempt - 1;
          wait = computeBackoffMs('network', attempt);
        }
        reconnectDelays.push({
          kind,
          wait,
          attempt,
          status: err?.status,
          rateLimitReset: err?.rateLimitReset,
        });
        console.error(
          `[fortnite-status-stream] Falha (HTTP ${err?.status || 'n/a'} / ${err?.message || 'error'}); backoff ${kind} ${wait}ms`,
        );
        await sleepReconnect(wait);
      } finally {
        watchdog.stop();
        // If another reconnect invalidated us, attemptGeneration already advanced.
        void attemptId;
      }
    }
    worker.stop();
    if (workerPromise) {
      try { await workerPromise; } catch { /* ignore */ }
    }
  }

  function start() {
    const ready = configReadyForLive(config);
    if (!ready.ok) {
      if (ready.reason === 'disabled') {
        console.log('[fortnite-status-stream] Desabilitado (FORTNITE_STATUS_STREAM_ENABLED≠1)');
      } else {
        console.log(`[fortnite-status-stream] Não iniciado: ${ready.reason}`);
      }
      return { started: false, reason: ready.reason };
    }
    if (running) return { started: false, reason: 'already_running' };
    running = true;
    stopping = false;
    blockedReason = null;
    streamConnectCount = 0;
    recoveryFetchCount = 0;
    loopPromise = runLoop().catch((err) => {
      console.error('[fortnite-status-stream] Loop encerrou com erro:', err?.message || err);
    });
    return { started: true };
  }

  async function stop() {
    stopping = true;
    running = false;
    // Invalidate any in-flight connectOnce / recovery.
    attemptGeneration += 1;
    watchdog.stop();
    worker.stop();
    try { abortController?.abort(); } catch { /* ignore */ }
    // Wake blocked sleep immediately (do not wait up to 60s).
    if (typeof blockedSleepWake === 'function') {
      try { blockedSleepWake(); } catch { /* ignore */ }
    }
    if (loopPromise) {
      try { await loopPromise; } catch { /* ignore */ }
    }
  }

  /**
   * Test helper: clear blocked state (simulates process restart with higher limit).
   */
  function _clearBlockedForTest() {
    blockedReason = null;
  }

  return {
    config,
    seenStore,
    queue,
    processor,
    worker,
    start,
    stop,
    /** test helpers */
    _fetchRecoveryPhase: fetchRecoveryPhase,
    _ensureSeenReady: ensureSeenReady,
    _enqueuePost: enqueuePost,
    _handleStreamEvents: handleStreamEvents,
    _requestReconnect: requestReconnect,
    _prepareForReconnect: prepareForReconnect,
    _loadQueueRecoveryThenHold: loadQueueRecoveryThenHold,
    _drainQueueUntilEmpty: drainQueueUntilEmpty,
    _runBarrier: runBarrier,
    _connectOnce: connectOnce,
    _isAttemptCurrent: isAttemptCurrent,
    _setHolding(v) { holdingStream = v; },
    _setLiveMode(v) { liveMode = v; },
    _getHoldBuffer: () => holdBuffer,
    _getNetworkAttempt: () => networkAttempt,
    _setNetworkAttempt(n) { networkAttempt = n; },
    _getHttpAttempt: () => httpAttempt,
    _getRateAttempt: () => rateAttempt,
    _noteStreamActivity: noteStreamActivity,
    _getStableAnchor: () => stableAnchorAt,
    _clearBlockedForTest,
    _getReconnectDelays: () => [...reconnectDelays],
    get _needRecovery() { return needRecovery; },
    get _liveMode() { return liveMode; },
    get _holdingStream() { return holdingStream; },
    get _lastClearWhileBusy() { return lastClearWhileBusy; },
    get _holdBufferMax() { return holdBufferMax; },
    get _attemptGeneration() { return attemptGeneration; },
    get _blockedReason() { return blockedReason; },
    get _lastDisconnect() { return lastDisconnect; },
    get _streamConnectCount() { return streamConnectCount; },
    get _recoveryFetchCount() { return recoveryFetchCount; },
  };
}

/**
 * Start from app.js. Does NOT install SIGTERM/SIGINT handlers so the default
 * process exit behavior remains (recovery on next boot covers in-flight work).
 */
export function startFortniteStatusStream(options = {}) {
  try {
    const client = createFortniteStatusStreamClient(options);
    const result = client.start();
    return { client, ...result };
  } catch (err) {
    console.error('[fortnite-status-stream] Falha ao iniciar:', err?.message || err);
    return { started: false, reason: 'exception' };
  }
}
