import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startIdentityPresence } from './discord-agent-presence.js';
import { createDiscordAgentMentions } from './discord-agent-mentions.js';

function fixture(env = { AGENT_ALPHA_DISCORD_TOKEN: 'fixture-token' }) {
  let time = 0, serial = 0;
  const tasks = new Map(), sockets = [], logs = [];
  const queue = createDiscordAgentMentions({ now: () => time });
  class Socket extends EventEmitter {
    readyState = 1; sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close(code) { this.readyState = 3; this.emit('close', code); }
    message(msg) { this.emit('message', JSON.stringify(msg)); }
  }
  const client = startIdentityPresence({ env, queue, Socket, now: () => time,
    later: (fn, ms) => { const id = ++serial; tasks.set(id, { fn, at: time + ms }); return id; },
    cancel: id => tasks.delete(id), random: () => 0.5, logger: { warn: line => logs.push(line) } });
  function advance(ms) {
    const end = time + ms;
    while (true) {
      const next = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; tasks.delete(next[0]); next[1].fn();
    }
    time = end;
  }
  function ready(socket = sockets.at(-1)) {
    socket.message({ op: 10, d: { heartbeat_interval: 1_000_000 } });
    socket.message({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' } });
  }
  async function poll(id = 'agent-alpha', wait = 25) {
    const controller = new AbortController();
    const result = queue.poll(id, { wait }, controller.signal); controller.abort(); await result;
  }
  return { client, sockets, logs, advance, ready, poll, tasks, queue };
}

test('idle initially; long-poll online; expires at 60 seconds; no redundant updates', async () => {
  const f = fixture(); f.ready(); const s = f.sockets[0];
  assert.equal(s.sent[0].d.intents, 0);
  assert.deepEqual(s.sent[0].d.presence, { since: null, activities: [], status: 'idle', afk: false });
  f.advance(15_000); await f.poll();
  assert.equal(s.sent.at(-1).d.status, 'online');
  f.advance(20_000); await f.poll();
  assert.equal(s.sent.filter(p => p.op === 3).length, 1);
  f.advance(59_999); assert.equal(s.sent.at(-1).d.status, 'online');
  f.advance(1); assert.equal(s.sent.at(-1).d.status, 'idle');
  f.client.stop(); assert.equal(f.tasks.size, 0);
  for (const p of s.sent.filter(p => p.op === 2 || p.op === 3)) {
    assert.ok(['idle', 'online'].includes((p.op === 2 ? p.d.presence : p.d).status));
  }
});

test('throttles initial poll and rapid idle to online transition', async () => {
  const f = fixture(); f.ready(); await f.poll();
  f.advance(14_999); assert.equal(f.sockets[0].sent.filter(p => p.op === 3).length, 0);
  f.advance(1); assert.equal(f.sockets[0].sent.at(-1).d.status, 'online');
  f.advance(45_000); assert.equal(f.sockets[0].sent.at(-1).d.status, 'idle');
  await f.poll(); f.advance(14_999); assert.equal(f.sockets[0].sent.at(-1).d.status, 'idle');
  f.advance(1); assert.equal(f.sockets[0].sent.at(-1).d.status, 'online'); f.client.stop();
});

test('short and aborted polls do not mark attention; identities isolated', async () => {
  const f = fixture({ AGENT_ALPHA_DISCORD_TOKEN: 'one', AGENT_BETA_DISCORD_TOKEN: 'two' });
  f.sockets.forEach(f.ready); f.advance(15_000); await f.poll('agent-alpha', 0);
  const aborted = new AbortController(); aborted.abort();
  await f.queue.poll('agent-alpha', { wait: 25 }, aborted.signal);
  await f.poll('agent-beta');
  assert.equal(f.sockets[0].sent.filter(p => p.op === 3).length, 0);
  assert.equal(f.sockets[1].sent.at(-1).d.status, 'online'); f.client.stop();
});

test('reconnect backs off, resumes, invalid session identifies idle', () => {
  const f = fixture(); f.ready(); f.sockets[0].message({ op: 7 });
  f.advance(5499); assert.equal(f.sockets.length, 1); f.advance(1);
  const s = f.sockets[1]; s.message({ op: 10, d: { heartbeat_interval: 1_000_000 } });
  assert.equal(s.sent[0].op, 6); assert.equal(s.sent[0].d.seq, 1);
  s.message({ op: 9, d: false }); f.advance(10_500);
  f.ready(); assert.equal(f.sockets[2].sent[0].op, 2);
  assert.equal(f.sockets[2].sent[0].d.presence.status, 'idle'); f.client.stop();
});

test('missing token logs reason only and opens no socket', () => {
  const f = fixture({}); assert.equal(f.sockets.length, 0);
  assert.equal(f.logs.length, 3); assert.ok(f.logs.every(line => line.endsWith('token_missing'))); f.client.stop();
});

test('auth failure isolated; heartbeat ACK and missed ACK reconnect', () => {
  const f = fixture({ AGENT_ALPHA_DISCORD_TOKEN: 'one', AGENT_BETA_DISCORD_TOKEN: 'two' });
  f.sockets.forEach(f.ready); f.sockets[0].close(4004);
  const s = f.sockets[1]; s.message({ op: 1 }); assert.equal(s.sent.at(-1).op, 1);
  s.message({ op: 11 }); f.advance(500_000); assert.equal(s.sent.at(-1).op, 1);
  f.advance(1_005_500); assert.equal(f.sockets.length, 3); f.client.stop();
});
