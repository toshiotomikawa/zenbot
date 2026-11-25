import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas';
import { TWITTER_ICONS } from './twitter-icons.js';

const CANVAS_WIDTH = 840;
const PADDING = 24;
const PADDING_BOTTOM = 14;
const CONTENT_WIDTH = CANVAS_WIDTH - PADDING * 2;
const FOOTER_STAT_ROW_H = 20;
const MEDIA_GAP = 2;
const LANDSCAPE_ASPECT = 16 / 9;
const ULTRAWIDE_ASPECT = 21 / 9;
const PORTRAIT_ASPECT = 4 / 5;

const COLORS = {
  text: '#0F1419',
  muted: '#536471',
  border: 'rgba(0,0,0,0.08)',
  link: '#1D9BF0',
  verified: '#1D9BF0',
  verifiedGov: '#829AAB',
  verifiedBiz: '#E0B400',
  mediaPlaceholder: '#EFF3F4',
};

const SHADOW = {
  color: 'rgba(0,0,0,0.10)',
  blur: 16,
  offsetY: 4,
};

// Media gets its own, more pronounced shadow: photos sit directly on the
// transparent canvas (no panel behind them), so on light Discord themes the
// edge meets a near-white background almost edge-on. A softer/wider halo
// gives that transition some visual cushioning instead of a hard cutoff.
const MEDIA_SHADOW = {
  color: 'rgba(0,0,0,0.32)',
  blur: 28,
  offsetY: 8,
};

const PANEL_INSET = 14;
const BLOCK_GAP = 8;
const BODY_GAP = 18;
const INNER_X = PADDING + PANEL_INSET;
const INNER_W = CONTENT_WIDTH - PANEL_INSET * 2;
const HEADER_AVATAR = 40;
const NAME_X = INNER_X + HEADER_AVATAR + 12;
const QUOTE_AVATAR = 24;
const QUOTE_NAME_X = INNER_X + QUOTE_AVATAR + 10;

const PANEL = {
  fill: 'rgba(255,255,255,0.94)',
  radius: 12,
};

const AVATAR_PALETTE = ['#7856FF', '#1D9BF0', '#00BA7C', '#E0525F', '#FFAD1F', '#9C6ADE'];

const STAT_ICON_SIZE = 20;

const TWITTER_URL_RE =
  /(?:https?:\/\/)?(?:(?:www|mobile|m)\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;

export function parseTwitterUrl(input) {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TWITTER_URL_RE);
  if (!match) return null;
  return { screenName: match[1], tweetId: match[2] };
}

export async function fetchTweetFromUrl(input) {
  const parsed = parseTwitterUrl(input);
  if (!parsed) return { ok: false, reason: 'invalid-url' };

  try {
    const url = `https://api.fxtwitter.com/${parsed.screenName}/status/${parsed.tweetId}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ZenBot/1.0' } });
    const json = await res.json();
    if (!json.tweet) return { ok: false, reason: res.status === 404 || json.code === 404 ? 'not-found' : 'error' };
    return { ok: true, tweet: json.tweet };
  } catch (err) {
    console.error('[twitter] fetch failed:', err);
    return { ok: false, reason: 'error' };
  }
}

function hashColor(screenName) {
  let hash = 0;
  for (const ch of screenName ?? '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function getInitials(name) {
  const parts = (name ?? '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatStat(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1_000_000) {
    const k = num / 1000;
    const s = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${String(s).replace(/\.0$/, '')}K`;
  }
  const m = num / 1_000_000;
  const s = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
  return `${String(s).replace(/\.0$/, '')}M`;
}

function formatTimestamp(tweet) {
  const date = tweet.created_timestamp
    ? new Date(tweet.created_timestamp * 1000)
    : new Date(tweet.created_at);
  const time = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
  return `${time} · ${day}`;
}

function setFont(ctx, size, weight = '400') {
  ctx.font = `${weight} ${size}px "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif`;
}

function drawRoundedShadowFill(ctx, x, y, w, h, r, fill) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.shadowColor = SHADOW.color;
  ctx.shadowBlur = SHADOW.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = SHADOW.offsetY;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

function drawPanel(ctx, x, y, w, h) {
  drawRoundedShadowFill(ctx, x, y, w, h, PANEL.radius, PANEL.fill);
}

function splitTextRuns(text) {
  const re = /(@[A-Za-z0-9_]{1,15}|#[\w\u00C0-\u024F]+|https?:\/\/\S+)/g;
  const runs = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index > last) {
      runs.push({ text: text.slice(last, match.index), color: COLORS.text });
    }
    runs.push({ text: match[0], color: COLORS.link });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), color: COLORS.text });
  if (!runs.length && text) runs.push({ text, color: COLORS.text });
  return runs;
}

function measureWordWidth(ctx, word) {
  const width = ctx.measureText(word).width;
  const emojiCount = (word.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  return width + emojiCount * ctx.measureText('M').width * 0.1;
}

function wrapRichText(ctx, segments, maxWidth, fontSize, lineHeight, maxLines = Infinity) {
  setFont(ctx, fontSize);
  const lines = [];
  let current = [];
  let currentWidth = 0;

  const flush = () => {
    if (current.length) {
      lines.push([...current]);
      current = [];
      currentWidth = 0;
    }
  };

  for (const segment of segments) {
    const words = segment.text.split(/(\s+)/).filter((w) => w.length);
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        const w = ctx.measureText(' ').width;
        if (currentWidth + w <= maxWidth) {
          current.push({ text: ' ', color: segment.color });
          currentWidth += w;
        }
        continue;
      }
      const w = measureWordWidth(ctx, word);
      if (currentWidth + w > maxWidth && current.length) {
        flush();
        if (lines.length >= maxLines) return { lines, truncated: true };
      }
      current.push({ text: word, color: segment.color });
      currentWidth += w;
      if (currentWidth > maxWidth && current.length === 1) flush();
      if (lines.length >= maxLines) return { lines, truncated: true };
    }
  }
  flush();
  return { lines, truncated: false };
}

function truncateLines(lines, maxLines) {
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  if (last?.length) {
    const lastSeg = last[last.length - 1];
    lastSeg.text = lastSeg.text.replace(/\s+\S*$/, '') + '…';
  }
  return { lines: kept, truncated: true };
}

function getTweetBodyText(tweet) {
  const text = (tweet.text ?? '').trim();
  if (text) return { kind: 'text', text };
  if (tweet.article?.title) {
    return {
      kind: 'article',
      title: tweet.article.title,
      preview: tweet.article.preview_text ?? '',
    };
  }
  if (tweet.quote?.text) return { kind: 'text', text: tweet.quote.text };
  return { kind: 'text', text: '' };
}

function collectMediaItems(tweet) {
  const items = [];
  const media = tweet.media ?? {};

  if (media.mosaic?.formats) {
    items.push({
      type: 'photo',
      url: media.mosaic.formats.jpeg ?? media.mosaic.formats.webp,
      width: media.mosaic.width,
      height: media.mosaic.height,
    });
    return items;
  }

  for (const photo of media.photos ?? []) {
    items.push({ type: 'photo', url: photo.url, width: photo.width, height: photo.height });
  }
  for (const video of media.videos ?? []) {
    items.push({
      type: video.type === 'gif' ? 'gif' : 'video',
      url: video.thumbnail_url ?? video.url,
      width: video.width,
      height: video.height,
    });
  }
  if (!items.length && media.all?.length) {
    for (const item of media.all) {
      items.push({
        type: item.type === 'photo' ? 'photo' : item.type === 'gif' ? 'gif' : 'video',
        url: item.thumbnail_url ?? item.url,
        width: item.width,
        height: item.height,
      });
    }
  }
  if (!items.length && tweet.article?.cover_media?.media_info?.original_img_url) {
    items.push({
      type: 'photo',
      url: tweet.article.cover_media.media_info.original_img_url,
      width: tweet.article.cover_media.media_info.original_img_width,
      height: tweet.article.cover_media.media_info.original_img_height,
    });
  }
  return items;
}

function resolveSingleMediaAspect(item, img) {
  const w = img?.width ?? item?.width;
  const h = img?.height ?? item?.height;
  if (!w || !h) return LANDSCAPE_ASPECT;
  const aspect = w / h;
  // Keep the photo's own aspect ratio (so portrait shots aren't crammed into
  // a landscape box and cropped to bits) — only clamp the extremes so a
  // panorama or a near-square portrait doesn't break the card layout.
  return Math.max(PORTRAIT_ASPECT, Math.min(aspect, ULTRAWIDE_ASPECT));
}

function getMediaBlockLayout(count, items = [], images = []) {
  if (!count) return { blockH: 0, cells: [] };

  if (count === 1) {
    const aspect = resolveSingleMediaAspect(items[0], images[0]);
    const blockH = Math.round(CONTENT_WIDTH / aspect);
    return {
      blockH,
      cells: [{ x: 0, y: 0, w: CONTENT_WIDTH, h: blockH, r: 12, index: 0 }],
    };
  }

  const cellW = (CONTENT_WIDTH - MEDIA_GAP) / 2;
  const cellH = Math.round(cellW / LANDSCAPE_ASPECT);

  if (count === 2) {
    return {
      blockH: cellH,
      cells: [
        { x: 0, y: 0, w: cellW, h: cellH, r: 12, index: 0 },
        { x: cellW + MEDIA_GAP, y: 0, w: cellW, h: cellH, r: 12, index: 1 },
      ],
    };
  }

  if (count === 3) {
    const blockH = cellH * 2 + MEDIA_GAP;
    return {
      blockH,
      cells: [
        { x: 0, y: 0, w: cellW, h: blockH, r: 12, index: 0 },
        { x: cellW + MEDIA_GAP, y: 0, w: cellW, h: cellH, r: 12, index: 1 },
        { x: cellW + MEDIA_GAP, y: cellH + MEDIA_GAP, w: cellW, h: cellH, r: 12, index: 2 },
      ],
    };
  }

  const blockH = cellH * 2 + MEDIA_GAP;
  return {
    blockH,
    cells: [
      { x: 0, y: 0, w: cellW, h: cellH, r: 12, index: 0 },
      { x: cellW + MEDIA_GAP, y: 0, w: cellW, h: cellH, r: 12, index: 1 },
      { x: 0, y: cellH + MEDIA_GAP, w: cellW, h: cellH, r: 12, index: 2 },
      { x: cellW + MEDIA_GAP, y: cellH + MEDIA_GAP, w: cellW, h: cellH, r: 12, index: 3 },
    ],
  };
}

function quoteMediaHeight(contentWidth) {
  return Math.round(contentWidth / LANDSCAPE_ASPECT);
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCoverImage(ctx, img, x, y, w, h) {
  const srcW = img.width;
  const srcH = img.height;
  const scale = Math.max(w / srcW, h / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const sx = (drawW - w) / 2 / scale;
  const sy = (drawH - h) / 2 / scale;
  ctx.drawImage(img, sx, sy, w / scale, h / scale, x, y, w, h);
}

async function loadOptionalImage(url) {
  if (!url) return null;
  try {
    return await loadImage(url);
  } catch {
    return null;
  }
}

async function loadTweetImages(tweet) {
  const mediaItems = collectMediaItems(tweet);
  const avatar = await loadOptionalImage(tweet.author?.avatar_url?.replace('_normal', '_200x200'));
  const media = await Promise.all(mediaItems.map((item) => loadOptionalImage(item.url)));
  const quoteAvatar = tweet.quote
    ? await loadOptionalImage(tweet.quote.author?.avatar_url?.replace('_normal', '_200x200'))
    : null;
  const quoteMedia = tweet.quote?.media?.photos?.[0]
    ? await loadOptionalImage(tweet.quote.media.photos[0].url)
    : null;
  return { avatar, media, mediaItems, quoteAvatar, quoteMedia };
}

function measureBodyBlock(ctx, tweet) {
  const body = getTweetBodyText(tweet);
  if (body.kind === 'article') {
    setFont(ctx, 16);
    const titleWrap = wrapRichText(ctx, [{ text: body.title, color: COLORS.text }], INNER_W, 16, 24, 6);
    let h = titleWrap.lines.length * 24;
    let previewWrap = null;
    if (body.preview) {
      setFont(ctx, 14);
      previewWrap = wrapRichText(ctx, [{ text: body.preview, color: COLORS.muted }], INNER_W, 14, 20, 3);
      h += 8 + previewWrap.lines.length * 20;
    }
    return { body, titleWrap, previewWrap, height: h };
  }
  setFont(ctx, 16);
  const segments = splitTextRuns(body.text);
  let wrap = wrapRichText(ctx, segments, INNER_W, 16, 24, 12);
  if (wrap.lines.length > 12) wrap = truncateLines(wrap.lines, 12);
  else wrap = { lines: wrap.lines, truncated: wrap.truncated };
  const h = wrap.lines.length * 24 + (wrap.truncated ? 24 : 0);
  return { body, wrap, height: h };
}

function measureLayout(ctx, tweet, images = { media: [] }) {
  const blocks = [];
  let y = PADDING;

  const replyTo = Array.isArray(tweet.replying_to)
    ? tweet.replying_to[0]
    : tweet.replying_to;

  const bodyBlock = measureBodyBlock(ctx, tweet);
  let textGroupH = PANEL_INSET;
  if (replyTo) textGroupH += 20;
  textGroupH += 48;
  if (bodyBlock.height > 0) textGroupH += BODY_GAP + bodyBlock.height;
  textGroupH += PANEL_INSET;

  blocks.push({
    type: 'textGroup',
    y,
    h: textGroupH,
    replyTo,
    bodyBlock,
  });
  y += textGroupH;

  const mediaItems = collectMediaItems(tweet);
  if (mediaItems.length) {
    y += BLOCK_GAP;
    const mediaLayout = getMediaBlockLayout(mediaItems.length, mediaItems, images.media);
    blocks.push({ type: 'media', y, h: mediaLayout.blockH, layout: mediaLayout, items: mediaItems });
    y += mediaLayout.blockH;
  }

  if (tweet.quote?.text) {
    y += BLOCK_GAP;
    setFont(ctx, 14);
    const qSegments = splitTextRuns(tweet.quote.text);
    const qWrap = wrapRichText(ctx, qSegments, INNER_W, 14, 20, 4);
    const quoteHeaderH = 32;
    const quoteTextH = qWrap.lines.length * 20;
    const hasQuoteMedia = !!tweet.quote.media?.photos?.length;
    const quoteMediaH = hasQuoteMedia ? quoteMediaHeight(INNER_W) : 0;
    const quoteGap = quoteTextH > 0 ? 10 : 0;
    const quoteMediaGap = hasQuoteMedia ? 10 : 0;
    const quoteH =
      PANEL_INSET + quoteHeaderH + quoteGap + quoteTextH + quoteMediaGap + quoteMediaH + PANEL_INSET;
    blocks.push({
      type: 'quote',
      y,
      h: quoteH,
      wrap: qWrap,
      quoteHeaderH,
      quoteTextH,
      quoteGap,
      quoteMediaH,
      hasQuoteMedia,
    });
    y += quoteH;
  }

  y += BLOCK_GAP;
  const footerH = PANEL_INSET + FOOTER_STAT_ROW_H + PANEL_INSET;
  blocks.push({ type: 'footer', y, h: footerH });
  y += footerH;

  return { height: Math.max(220, y + PADDING_BOTTOM), blocks, replyTo, mediaItems };
}

function drawAvatar(ctx, img, x, y, size, name, screenName) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = hashColor(screenName);
    ctx.fillRect(x, y, size, size);
    setFont(ctx, size * 0.375, '600');
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(getInitials(name), x + size / 2, y + size / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function drawSvgIcon(
  ctx,
  pathD,
  x,
  y,
  size,
  color,
  { viewBox = 24, fillRule = 'nonzero' } = {},
) {
  ctx.save();
  ctx.translate(x, y);
  const scale = size / viewBox;
  ctx.scale(scale, scale);
  const path = new Path2D(pathD);
  ctx.fillStyle = color;
  ctx.fill(path, fillRule);
  ctx.restore();
}

function drawVerifiedBadge(ctx, x, y, verification) {
  if (!verification?.verified) return;
  const type = verification.type ?? 'individual';
  let icon = TWITTER_ICONS.verified;
  let color = COLORS.verified;
  if (type === 'government' || type === 'legacy') {
    icon = TWITTER_ICONS.verifiedGovernment;
    color = COLORS.verifiedGov;
  } else if (type === 'business') {
    icon = TWITTER_ICONS.verifiedBusiness;
    color = COLORS.verifiedBiz;
  }

  const size = 18;
  drawSvgIcon(ctx, icon.path, x, y, size, color, {
    viewBox: icon.viewBox,
    fillRule: icon.evenodd ? 'evenodd' : 'nonzero',
  });
}

function drawWrappedLines(ctx, wrap, x, startY, lineHeight) {
  let y = startY;
  for (const line of wrap.lines) {
    let xOff = x;
    for (const seg of line) {
      setFont(ctx, lineHeight === 24 ? 16 : 14);
      ctx.fillStyle = seg.color;
      ctx.fillText(seg.text, xOff, y);
      xOff += ctx.measureText(seg.text).width;
    }
    y += lineHeight;
  }
  return y;
}

function drawMediaGrid(ctx, images, items, layout, x, y, sensitive) {
  for (const spec of layout.cells) {
    const cell = {
      x: x + spec.x,
      y: y + spec.y,
      w: spec.w,
      h: spec.h,
      r: spec.r,
      img: images[spec.index],
      item: items[spec.index],
    };
    if (cell.w <= 0 || cell.h <= 0) continue;

    // Render the cell into an offscreen canvas, then mask it to rounded
    // corners with a `destination-in` fill rather than `ctx.clip()` —
    // @napi-rs/canvas's clip paths come out hard-edged (no AA), while
    // filled paths are properly anti-aliased, giving a soft rounded edge
    // that blends cleanly with the (often dark) Discord background.
    const cw = Math.ceil(cell.w);
    const ch = Math.ceil(cell.h);
    const off = createCanvas(cw, ch);
    const octx = off.getContext('2d');
    if (cell.img && !sensitive) {
      drawCoverImage(octx, cell.img, 0, 0, cell.w, cell.h);
    } else {
      octx.fillStyle = COLORS.mediaPlaceholder;
      octx.fillRect(0, 0, cell.w, cell.h);
    }
    if (sensitive) {
      octx.fillStyle = 'rgba(0,0,0,0.7)';
      octx.fillRect(0, 0, cell.w, cell.h);
      setFont(octx, 14, '600');
      octx.textAlign = 'center';
      octx.fillStyle = '#FFFFFF';
      octx.fillText('Conteúdo sensível', cell.w / 2, cell.h / 2);
      octx.textAlign = 'left';
    } else if (cell.item?.type === 'video' || cell.item?.type === 'gif') {
      const cx = cell.w / 2;
      const cy = cell.h / 2;
      octx.fillStyle = 'rgba(0,0,0,0.55)';
      octx.beginPath();
      octx.arc(cx, cy, 32, 0, Math.PI * 2);
      octx.fill();
      drawSvgIcon(octx, TWITTER_ICONS.play.path, cx - 14, cy - 14, 28, '#FFFFFF', {
        viewBox: TWITTER_ICONS.play.viewBox,
      });
      if (cell.item.type === 'gif') {
        setFont(octx, 11, '600');
        const label = 'GIF';
        const lw = octx.measureText(label).width + 12;
        roundedRectPath(octx, 8, 8, lw, 20, 10);
        octx.fillStyle = 'rgba(0,0,0,0.6)';
        octx.fill();
        octx.fillStyle = '#FFFFFF';
        octx.fillText(label, 14, 22);
      }
    }

    octx.save();
    octx.globalCompositeOperation = 'destination-in';
    octx.fillStyle = '#000000';
    roundedRectPath(octx, 0, 0, cell.w, cell.h, cell.r);
    octx.fill();
    octx.restore();

    ctx.save();
    ctx.shadowColor = MEDIA_SHADOW.color;
    ctx.shadowBlur = MEDIA_SHADOW.blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = MEDIA_SHADOW.offsetY;
    ctx.drawImage(off, cell.x, cell.y);
    ctx.restore();
  }
}

function drawStatIcon(ctx, type, x, y) {
  const icon = TWITTER_ICONS[type];
  if (!icon) return;
  drawSvgIcon(ctx, icon.path, x, y, STAT_ICON_SIZE, COLORS.muted, {
    viewBox: icon.viewBox,
    fillRule: icon.evenodd ? 'evenodd' : 'nonzero',
  });
}

function drawTextGroup(ctx, tweet, block, avatar) {
  let cy = block.y + PANEL_INSET;

  if (block.replyTo) {
    setFont(ctx, 13);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText('Respondendo a ', NAME_X, cy + 12);
    const prefixW = ctx.measureText('Respondendo a ').width;
    ctx.fillStyle = COLORS.link;
    ctx.fillText(`@${block.replyTo}`, NAME_X + prefixW, cy + 12);
    cy += 20;
  }

  drawAvatar(ctx, avatar, INNER_X, cy + 2, HEADER_AVATAR, tweet.author?.name, tweet.author?.screen_name);

  setFont(ctx, 15, '700');
  const displayName = tweet.author?.name ?? 'Usuário';
  let nameText = displayName;
  const maxNameW = INNER_X + INNER_W - NAME_X - 8;
  while (ctx.measureText(nameText).width > maxNameW && nameText.length > 1) {
    nameText = nameText.slice(0, -2) + '…';
  }
  ctx.fillStyle = COLORS.text;
  ctx.fillText(nameText, NAME_X, cy + 18);

  const nameW = ctx.measureText(nameText).width;
  drawVerifiedBadge(ctx, NAME_X + nameW + 4, cy + 4, tweet.author?.verification);

  setFont(ctx, 14);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`@${tweet.author?.screen_name ?? 'unknown'}`, NAME_X, cy + 36);

  cy += 48;
  const { bodyBlock } = block;
  if (bodyBlock.height > 0) {
    cy += BODY_GAP;
    if (bodyBlock.body.kind === 'article') {
      drawWrappedLines(ctx, bodyBlock.titleWrap, INNER_X, cy, 24);
      cy += bodyBlock.titleWrap.lines.length * 24;
      if (bodyBlock.previewWrap) {
        cy += 8;
        drawWrappedLines(ctx, bodyBlock.previewWrap, INNER_X, cy, 20);
      }
    } else if (bodyBlock.wrap.lines.length) {
      drawWrappedLines(ctx, bodyBlock.wrap, INNER_X, cy, 24);
      cy += bodyBlock.wrap.lines.length * 24;
      if (bodyBlock.wrap.truncated) {
        setFont(ctx, 16);
        ctx.fillStyle = COLORS.link;
        ctx.fillText('… mostrar mais', INNER_X, cy + 20);
      }
    }
  }

  setFont(ctx, 13);
  const ts = formatTimestamp(tweet);
  const tsW = ctx.measureText(ts).width;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(ts, INNER_X + INNER_W - tsW, block.y + block.h - PANEL_INSET);
}

function drawFooterBlock(ctx, tweet, block) {
  const cy = block.y + PANEL_INSET;
  const stats = [
    ['reply', tweet.replies],
    ['retweet', tweet.retweets],
    ['like', tweet.likes],
    ['views', tweet.views],
  ];
  setFont(ctx, 13);

  const STAT_GROUP_GAP = 36;
  const groups = stats.map(([type, value]) => {
    const label = formatStat(value);
    return { type, label, width: STAT_ICON_SIZE + 6 + ctx.measureText(label).width };
  });
  const totalW = groups.reduce((sum, g) => sum + g.width, 0) + STAT_GROUP_GAP * (groups.length - 1);

  let sx = INNER_X + (INNER_W - totalW) / 2;
  for (const g of groups) {
    drawStatIcon(ctx, g.type, sx, cy);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(g.label, sx + STAT_ICON_SIZE + 6, cy + 13);
    sx += g.width + STAT_GROUP_GAP;
  }
}

function drawQuoteBlock(ctx, tweet, block, quoteAvatar, quoteMedia) {
  const accentX = INNER_X - 6;
  ctx.fillStyle = COLORS.border;
  roundedRectPath(ctx, accentX, block.y + PANEL_INSET, 3, block.h - PANEL_INSET * 2, 2);
  ctx.fill();

  let cy = block.y + PANEL_INSET;

  drawAvatar(ctx, quoteAvatar, INNER_X, cy + 4, QUOTE_AVATAR, tweet.quote.author?.name, tweet.quote.author?.screen_name);
  setFont(ctx, 13, '700');
  ctx.fillStyle = COLORS.text;
  const qName = tweet.quote.author?.name ?? '';
  ctx.fillText(qName, QUOTE_NAME_X, cy + 18);
  const qNameW = ctx.measureText(qName).width;
  setFont(ctx, 13);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`@${tweet.quote.author?.screen_name ?? ''}`, QUOTE_NAME_X + qNameW + 4, cy + 18);

  cy += block.quoteHeaderH;
  if (block.quoteTextH > 0) {
    cy += block.quoteGap;
    drawWrappedLines(ctx, block.wrap, INNER_X, cy, 20);
    cy += block.quoteTextH;
  }

  if (block.hasQuoteMedia && quoteMedia) {
    cy += 10;
    ctx.save();
    roundedRectPath(ctx, INNER_X, cy, INNER_W, block.quoteMediaH, 8);
    ctx.clip();
    drawCoverImage(ctx, quoteMedia, INNER_X, cy, INNER_W, block.quoteMediaH);
    ctx.restore();
  }
}

function drawCard(ctx, tweet, images, layout) {
  const { avatar, media, quoteAvatar, quoteMedia } = images;

  for (const block of layout.blocks) {
    if (block.type === 'textGroup') {
      drawPanel(ctx, PADDING, block.y, CONTENT_WIDTH, block.h);
      drawTextGroup(ctx, tweet, block, avatar);
    } else if (block.type === 'media') {
      drawMediaGrid(ctx, media, block.items, block.layout, PADDING, block.y, tweet.possibly_sensitive);
    } else if (block.type === 'quote') {
      drawPanel(ctx, PADDING, block.y, CONTENT_WIDTH, block.h);
      drawQuoteBlock(ctx, tweet, block, quoteAvatar, quoteMedia);
    } else if (block.type === 'footer') {
      drawPanel(ctx, PADDING, block.y, CONTENT_WIDTH, block.h);
      drawFooterBlock(ctx, tweet, block);
    }
  }
}

export async function renderTweetScreenshot(tweet) {
  const measureCanvas = createCanvas(CANVAS_WIDTH, 10);
  const measureCtx = measureCanvas.getContext('2d');
  const images = await loadTweetImages(tweet);
  const layout = measureLayout(measureCtx, tweet, images);

  const canvas = createCanvas(CANVAS_WIDTH, layout.height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CANVAS_WIDTH, layout.height);

  drawCard(ctx, tweet, images, layout);

  return canvas.encode('png');
}