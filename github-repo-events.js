/**
 * GitHub repository webhook → task topic completion.
 * Opt-in, allowlisted and authenticated with HMAC-SHA256 over the raw body.
 * No channel feed: replay safety comes from the task topic's current state.
 */

import crypto from 'crypto';
import express from 'express';
import { DiscordRequest } from './utils.js';
import { createTaskPrCompletion } from './task-pr-completion.js';
import { createRateLimiter } from './discord-feed-utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const GITHUB_EVENTS_ROUTE = '/webhooks/github-events';
export const GITHUB_EVENTS_BODY_LIMIT = '1mb';
export const MIN_HMAC_SECRET_LENGTH = 16;

const SIGNATURE_FORMAT = /^sha256=[0-9a-fA-F]{64}$/;
const DELIVERY_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REPO_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Normalize a comma-separated `owner/name` allowlist. Malformed entries are
 * dropped rather than silently widening the surface.
 */
export function parseRepoAllowlist(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => REPO_FULL_NAME.test(item));
}

export function readGithubEventsConfig(env = process.env) {
  const enabled = env.GITHUB_EVENTS_ENABLED === '1';
  const hmacSecret = String(env.GITHUB_EVENTS_HMAC_SECRET ?? '');
  const rawAllowlist = String(env.GITHUB_EVENTS_REPO_ALLOWLIST ?? '').trim();
  const allowlist = parseRepoAllowlist(rawAllowlist);

  const missing = [];
  if (!hmacSecret) missing.push('GITHUB_EVENTS_HMAC_SECRET');
  if (!rawAllowlist) missing.push('GITHUB_EVENTS_REPO_ALLOWLIST');

  let reason = 'ok';
  if (!enabled) reason = 'disabled';
  else if (missing.length > 0) reason = 'missing_config';
  else if (hmacSecret.length < MIN_HMAC_SECRET_LENGTH) reason = 'weak_hmac_secret';
  else if (allowlist.length === 0) reason = 'invalid_repo_allowlist';

  const config = {
    enabled,
    valid: reason === 'ok',
    reason,
    missing,
    hmacSecret,
    allowlist,
  };
  // Everything but the secret, for logs and diagnostics.
  config.logSafe = {
    enabled,
    valid: config.valid,
    reason,
    missing,
    allowlist,
  };
  return config;
}

// ─── Signature ───────────────────────────────────────────────────────────────

/**
 * `sha256=<hex>` over the exact request bytes, exactly as GitHub computes it.
 * @param {Buffer} rawBody
 * @param {string} secret
 */
export function computeGithubSignature(rawBody, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return `sha256=${crypto.createHmac('sha256', String(secret ?? '')).update(body).digest('hex')}`;
}

/**
 * Constant-time verification of the X-Hub-Signature-256 header.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyGithubSignature(rawBody, header, secret) {
  if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'not_configured' };
  if (typeof header !== 'string' || !header) return { ok: false, reason: 'missing_signature' };
  if (!SIGNATURE_FORMAT.test(header)) return { ok: false, reason: 'malformed_signature' };

  const provided = Buffer.from(header.slice('sha256='.length).toLowerCase(), 'hex');
  const expected = Buffer.from(
    computeGithubSignature(rawBody, secret).slice('sha256='.length),
    'hex',
  );
  // Both are 32 bytes: the format regex already fixed the hex length.
  if (!crypto.timingSafeEqual(provided, expected)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}

// ─── Delivery id ─────────────────────────────────────────────

export function isValidDeliveryId(value) {
  return typeof value === 'string' && DELIVERY_GUID.test(value);
}

/** Validate every delivery, including ignored events, before dispatching. */
export function normalizeGithubEvent({ eventName, deliveryId, body, allowlist = [] } = {}) {
  const reject = (status, reason) => ({ ok: false, status, reason });
  if (!isValidDeliveryId(deliveryId)) return reject(400, 'invalid_delivery_id');
  if (typeof eventName !== 'string' || !eventName) return reject(400, 'missing_event_name');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'invalid_payload');
  const fullName = body.repository?.full_name;
  const repo = typeof fullName === 'string' ? fullName.trim().toLowerCase() : '';
  if (!repo || !allowlist.includes(repo)) return reject(403, 'repo_not_allowlisted');
  if (eventName === 'ping') return { ok: true, action: 'ping' };
  if (eventName !== 'pull_request' || body.action !== 'closed') {
    return { ok: true, action: 'ignored' };
  }
  const pr = body.pull_request;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return reject(400, 'invalid_payload');
  if (pr.merged !== true) return { ok: true, action: 'ignored' };
  if (!Number.isInteger(pr.number) || pr.number < 1) return reject(400, 'invalid_payload');
  return { ok: true, action: 'complete' };
}

export function createGithubEventsProcessor(options = {}) {
  const config = {
    ...readGithubEventsConfig(options.env ?? process.env),
    ...options.configOverride,
  };
  const taskCompletion = options.taskCompletion ?? createTaskPrCompletion({
    env: options.env ?? process.env, request: options.discordRequest ?? DiscordRequest,
  });
  const inFlight = new Map();

  async function processDelivery({ eventName, deliveryId, body }) {
    const normalized = normalizeGithubEvent({ eventName, deliveryId, body, allowlist: config.allowlist });
    if (!normalized.ok) return { status: normalized.status, body: { error: normalized.reason } };
    if (normalized.action !== 'complete') {
      return { status: 200, body: { ok: true, action: normalized.action } };
    }
    if (!taskCompletion) return { status: 200, body: { ok: true, action: 'ignored' } };
    const key = deliveryId.toLowerCase();
    if (inFlight.has(key)) return inFlight.get(key);
    const work = Promise.resolve().then(async () => {
      try {
        await taskCompletion.handleMerge(body);
        return { status: 200, body: { ok: true, action: 'processed' } };
      } catch {
        return { status: 502, body: { error: 'task_completion_failed' } };
      } finally {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, work);
    return work;
  }

  return { processDelivery, config };
}

// ─── Express wiring ──────────────────────────────────────────────────────────

/**
 * Register POST /webhooks/github-events with a route-scoped raw body parser.
 * Nothing is registered when the surface is disabled or misconfigured, so a
 * partially configured deployment answers 404 instead of half-working.
 *
 * @param {import('express').Express | import('express').Router} app
 * @param {object} [options]
 * @returns {{ registered: boolean, reason: string, logSafe?: object }} never the
 *   HMAC secret, and nothing that transitively reaches it.
 */
export function registerGithubEventsWebhook(app, options = {}) {
  const config = options.processor?.config
    ?? { ...readGithubEventsConfig(options.env ?? process.env), ...options.configOverride };

  if (!config.valid) {
    console.log(`[github-events] Superfície não registrada: ${config.reason}`);
    return { registered: false, reason: config.reason };
  }

  const processor = options.processor ?? createGithubEventsProcessor(options);
  const rateLimiter = options.rateLimiter ?? createRateLimiter();
  const rawParser = express.raw({ type: 'application/json', limit: GITHUB_EVENTS_BODY_LIMIT });

  // Middleware order (intentional):
  // 1) read at most 1 MiB of raw bytes — the only pre-auth protection needed,
  //    and HMAC requires the exact bytes anyway
  // 2) verify the signature before interpreting any content
  // 3) rate-limit, but only what is already proven to come from GitHub
  // 4) parse JSON and process
  //
  // The rate limiter deliberately runs AFTER authentication. `req.ip` is the
  // ingress peer, not GitHub, so a shared bucket filled by unauthenticated
  // traffic would let a third party starve real deliveries into 429.
  app.post(
    GITHUB_EVENTS_ROUTE,
    (req, res, next) => {
      rawParser(req, res, (err) => {
        if (err) {
          if (err.type === 'entity.too.large' || err.status === 413) {
            return res.status(413).json({ error: 'payload_too_large' });
          }
          return res.status(400).json({ error: 'invalid_body' });
        }
        return next();
      });
    },
    (req, res, next) => {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: 'unsupported_content_type' });
      }
      const verdict = verifyGithubSignature(
        req.body,
        req.get('X-Hub-Signature-256'),
        config.hmacSecret,
      );
      if (!verdict.ok) return res.status(401).json({ error: verdict.reason });
      return next();
    },
    (req, res, next) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const limit = rateLimiter.check(ip);
      if (!limit.allowed) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((limit.retryAfterMs || 60_000) / 1000))),
        );
        return res.status(429).json({ error: 'rate_limited' });
      }
      return next();
    },
    async (req, res) => {
      try {
        let payload;
        try {
          payload = JSON.parse(req.body.toString('utf8'));
        } catch {
          return res.status(400).json({ error: 'invalid_json' });
        }

        const result = await processor.processDelivery({
          eventName: req.get('X-GitHub-Event'),
          deliveryId: req.get('X-GitHub-Delivery'),
          body: payload,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        console.error('[github-events] Erro no handler:', err?.message || err);
        return res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // Deliberately narrow: nothing here may transitively reach `hmacSecret`.
  // The processor and the rate limiter stay injectable through `options`, so
  // callers that need a handle already own one.
  return { registered: true, reason: config.reason, logSafe: config.logSafe };
}
