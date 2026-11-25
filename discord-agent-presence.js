import WebSocket from 'ws';
import { DISCORD_AGENT_IDENTITIES } from './discord-agent-identities.js';
import { discordAgentMentions } from './discord-agent-mentions.js';

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const presence = status => ({ since: null, activities: [], status, afk: false });

// Independent sockets using the same ws transport as presence.js; no message intents.
export function startIdentityPresence({ env = process.env, queue = discordAgentMentions,
  Socket = WebSocket, now = Date.now, later = setTimeout, cancel = clearTimeout,
  random = Math.random, logger = console } = {}) {
  const clients = [];
  for (const identity of DISCORD_AGENT_IDENTITIES) {
    const token = env[identity.tokenEnv];
    if (typeof token !== 'string' || !token.trim()) {
      logger.warn(`[identity-presence] ${identity.id}: token_missing`);
      continue;
    }
    let socket, stopped = false, ready = false, session, sequence = null, resumeUrl;
    let heartbeatTimer, reconnectTimer, updateTimer, ack = true, attempt = 0;
    let status = 'idle', lastUpdate = -Infinity;
    const timer = (fn, ms) => { const handle = later(fn, ms); handle?.unref?.(); return handle; };
    const log = reason => logger.warn(`[identity-presence] ${identity.id}: ${reason}`);
    function send(payload) {
      if (socket?.readyState !== 1) return false;
      try { socket.send(JSON.stringify(payload)); return true; }
      catch { reconnect(); return false; }
    }
    function update() {
      cancel(updateTimer);
      if (!ready || stopped) return;
      const polled = queue.lastPollAt(identity.id);
      const desired = polled !== undefined && now() - polled < 60_000 ? 'online' : 'idle';
      const delay = Math.max(0, lastUpdate + 15_000 - now());
      if (desired !== status && delay === 0) {
        if (!send({ op: 3, d: presence(desired) })) return;
        status = desired;
        lastUpdate = now();
      }
      if (desired !== status) updateTimer = timer(update, delay);
      else if (desired === 'online') updateTimer = timer(update, Math.max(1, polled + 60_000 - now()));
    }
    function reconnect() {
      if (stopped || reconnectTimer) return;
      ready = false;
      cancel(heartbeatTimer); cancel(updateTimer);
      const old = socket; socket = undefined;
      try { old?.close(4000); } catch { /* Isolated transport failure. */ }
      reconnectTimer = timer(() => { reconnectTimer = undefined; connect(); },
        Math.min(60_000, 5000 * 2 ** Math.min(attempt++, 4)) + random() * 1000);
    }
    function beat() {
      if (!ack) return reconnect();
      ack = false;
      send({ op: 1, d: sequence });
    }
    function connect() {
      if (stopped) return;
      try { socket = new Socket(session && resumeUrl ? `${resumeUrl.replace(/\/$/, '')}/?v=10&encoding=json` : GATEWAY); }
      catch { log('connection_error'); reconnect(); return; }
      const current = socket;
      current.on('error', () => { if (socket === current) { log('connection_error'); reconnect(); } });
      current.on('close', code => {
        if (socket !== current) return;
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
          log('gateway_rejected'); stop(); return;
        }
        if ([4007, 4009].includes(code)) { session = undefined; sequence = null; }
        reconnect();
      });
      current.on('message', raw => {
        if (socket !== current || stopped) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.s != null) sequence = msg.s;
        if (msg.op === 10) {
          const interval = msg.d?.heartbeat_interval;
          if (!Number.isFinite(interval) || interval <= 0) return reconnect();
          cancel(heartbeatTimer); ack = true;
          const tick = () => { beat(); if (socket === current) heartbeatTimer = timer(tick, interval); };
          heartbeatTimer = timer(tick, random() * interval);
          if (session && sequence != null) send({ op: 6, d: { token, session_id: session, seq: sequence } });
          else {
            status = 'idle';
            if (send({ op: 2, d: { token, intents: 0,
              properties: { os: process.platform, browser: 'ZenBot', device: 'ZenBot' }, presence: presence('idle') } })) lastUpdate = now();
          }
        } else if (msg.op === 11) ack = true;
        else if (msg.op === 1) { ack = false; send({ op: 1, d: sequence }); }
        else if (msg.op === 7) reconnect();
        else if (msg.op === 9) {
          if (msg.d !== true) { session = undefined; sequence = null; resumeUrl = undefined; }
          reconnect();
        } else if (msg.op === 0 && (msg.t === 'READY' || msg.t === 'RESUMED')) {
          if (msg.t === 'READY') {
            session = msg.d?.session_id;
            // Only Discord's trusted Gateway host may receive the credential on resume.
            try { const url = new URL(msg.d?.resume_gateway_url); if (url.protocol === 'wss:' && (url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg'))) resumeUrl = url.origin; } catch { resumeUrl = undefined; }
          }
          ready = true; attempt = 0; update();
        }
      });
    }
    const unsubscribe = queue.onPoll(id => { if (id === identity.id) update(); });
    function stop() {
      stopped = true; ready = false; unsubscribe();
      cancel(heartbeatTimer); cancel(reconnectTimer); cancel(updateTimer);
      const old = socket; socket = undefined;
      try { old?.close(1000); } catch { /* No status offline/invisible is sent. */ }
    }
    clients.push({ stop });
    connect();
  }
  return { stop() { for (const client of clients) client.stop(); } };
}
