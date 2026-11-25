/**
 * Deterministic dry-run for FortniteStatus presentation.
 * Uses local fixtures only — never contacts X or Discord.
 *
 * Usage: node fortnite-status-stream-dryrun.mjs
 *    or: npm run fortnite-status-stream-dryrun
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  adaptV2PostToTweet,
  buildEmbedMessage,
  normalizeV2Post,
} from './fortnite-status-stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures', 'fortnite-status-stream');

const USER_ID = '1111111111111111111';

const fixtures = {
  original: {
    data: {
      id: '2000000000000000001',
      author_id: USER_ID,
      text: 'All Fortnite services are online.',
      created_at: '2026-08-05T15:00:00.000Z',
      edit_history_tweet_ids: ['2000000000000000001'],
      public_metrics: {
        like_count: 12,
        retweet_count: 3,
        reply_count: 1,
        impression_count: 500,
      },
    },
    includes: {
      users: [
        {
          id: USER_ID,
          name: 'Fortnite Status',
          username: 'FortniteStatus',
          profile_image_url: 'https://pbs.twimg.com/profile_images/example_normal.jpg',
          verified: true,
          verified_type: 'business',
        },
      ],
    },
  },
  noteTweet: {
    data: {
      id: '2000000000000000002',
      author_id: USER_ID,
      text: 'Long maintenance note…',
      note_tweet: {
        text: 'Long maintenance note covering multiple systems and expected resolution windows for BR matchmaking and login.',
      },
      created_at: '2026-08-05T15:05:00.000Z',
      edit_history_tweet_ids: ['2000000000000000002'],
    },
    includes: {
      users: [
        {
          id: USER_ID,
          name: 'Fortnite Status',
          username: 'FortniteStatus',
          verified: true,
          verified_type: 'business',
        },
      ],
    },
  },
  edited: {
    data: {
      id: '2000000000000000003',
      author_id: USER_ID,
      text: 'All Fortnite services are online. (updated ETA)',
      created_at: '2026-08-05T15:10:00.000Z',
      edit_history_tweet_ids: ['2000000000000000001', '2000000000000000003'],
    },
    includes: {
      users: [
        {
          id: USER_ID,
          name: 'Fortnite Status',
          username: 'FortniteStatus',
          verified: true,
          verified_type: 'business',
        },
      ],
    },
  },
};

function ensureFixturesOnDisk() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  for (const [name, body] of Object.entries(fixtures)) {
    const file = path.join(fixturesDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
  }
}

function runOne(name, body) {
  const normalized = normalizeV2Post(body.data, body.includes, { userId: USER_ID });
  if (!normalized.ok) {
    console.log(`\n## ${name}\nFAIL normalize: ${normalized.reason}`);
    return false;
  }
  const tweet = adaptV2PostToTweet(body.data, body.includes);
  const embed = buildEmbedMessage(normalized, tweet);
  console.log(`\n## ${name}`);
  console.log(`logicalId: ${normalized.logicalId}`);
  console.log(`postId: ${normalized.postId}`);
  console.log(`isEdit: ${normalized.isEdit}`);
  console.log(`adapter.text: ${JSON.stringify(tweet.text)}`);
  console.log(`discord.content: ${embed.content}`);
  console.log(`footer: ${embed.embeds[0].footer.text}`);
  console.log(`description preview: ${String(embed.embeds[0].description).slice(0, 120)}`);
  return true;
}

ensureFixturesOnDisk();
let ok = true;
for (const [name, body] of Object.entries(fixtures)) {
  if (!runOne(name, body)) ok = false;
}

// Also load from disk to prove fixtures are readable
const diskOriginal = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'original.json'), 'utf8'),
);
if (!runOne('disk:original', diskOriginal)) ok = false;

console.log(ok ? '\nDry-run OK (no network).' : '\nDry-run FAILED.');
process.exit(ok ? 0 : 1);
