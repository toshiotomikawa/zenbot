import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'twitter', 'icons');

function loadSvgIcon(filename) {
  const svg = readFileSync(join(ICON_DIR, filename), 'utf8');
  const pathMatch = svg.match(/\bd="([^"]+)"/);
  if (!pathMatch) throw new Error(`[twitter-icons] No <path d="..."> in ${filename}`);
  const viewBoxMatch = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const viewBox = viewBoxMatch ? Number(viewBoxMatch[1]) : 24;
  const evenodd = /fill-rule="evenodd"/i.test(svg);
  return { path: pathMatch[1], viewBox, evenodd };
}

export const TWITTER_ICONS = {
  reply: loadSvgIcon('reply.svg'),
  like: loadSvgIcon('like.svg'),
  retweet: loadSvgIcon('retweet.svg'),
  views: loadSvgIcon('views.svg'),
  play: loadSvgIcon('play.svg'),
  verified: loadSvgIcon('verified.svg'),
  verifiedGovernment: loadSvgIcon('verified-government.svg'),
  verifiedBusiness: loadSvgIcon('verified-business.svg'),
};