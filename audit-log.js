/**
 * Central audit log for the process output (Northflank container log).
 * Best-effort, allowlisted metadata only. Never logs secrets or payloads.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const auditStore = new AsyncLocalStorage();

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|signature|api[_-]?key|bearer|webhook|private[_-]?key|client[_-]?secret/i;
const WEBHOOK_URL = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9._-]+/gi;
const BEARERISH = /\b(?:Bot|Bearer)\s+[A-Za-z0-9._-]{8,}/gi;

export const SAFE_META_KEYS = new Set([
  'subsystem',
  'event',
  'action',
  'method',
  'route',
  'endpoint',
  'status',
  'elapsed_ms',
  'request_id',
  'operation_id',
  'guild_id',
  'channel_id',
  'thread_id',
  'message_id',
  'user_id',
  'provider',
  'requested_model',
  'tool',
  'outcome',
  'error_code',
  'opcode',
]);

const META_ORDER = [
  'subsystem',
  'event',
  'action',
  'method',
  'route',
  'endpoint',
  'status',
  'elapsed_ms',
  'request_id',
  'operation_id',
  'guild_id',
  'channel_id',
  'thread_id',
  'message_id',
  'user_id',
  'provider',
  'requested_model',
  'tool',
  'outcome',
  'error_code',
  'opcode',
];

export function getAuditContext() {
  return auditStore.getStore() ?? {};
}

export function runWithAuditContext(ctx, fn) {
  const parent = getAuditContext();
  return auditStore.run({ ...parent, ...ctx }, fn);
}

export function redactText(value) {
  if (value == null) return '';
  return String(value)
    .replace(WEBHOOK_URL, '[redacted-webhook]')
    .replace(BEARERISH, '[redacted-auth]');
}

export function pickSafeMeta(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (!SAFE_META_KEYS.has(key)) continue;
    const raw = input[key];
    if (raw == null || raw === '') continue;
    if (typeof raw === 'object') continue;
    if (key === 'requested_model' && raw !== 'openrouter/free') continue;
    const text = key === 'endpoint' ? normalizeDiscordEndpoint(raw) : redactText(raw);
    if (!text) continue;
    out[key] = text;
  }
  return out;
}

export function normalizeDiscordEndpoint(endpoint) {
  const raw = String(endpoint || '').split('?')[0];
  return raw
    .replace(/(^|\/)webhooks\/\d{17,20}\/[^/]+/gi, '$1webhooks/:id/:token')
    .replace(/\d{17,20}/g, ':id')
    .replace(/\/{2,}/g, '/');
}

export function sanitizeHttpRoute(req) {
  const routed = `${req.baseUrl || ''}${req.route?.path || ''}`;
  if (routed) return routed.replace(/\/{2,}/g, '/') || '/';
  const pathOnly = String(req.path || req.url || '/').split('?')[0];
  return redactText(pathOnly
    // Route removed. Statuspage can still post the secret in this path until
    // the external subscription is deleted, and unmatched routes log req.path.
    .replace(/(\/webhooks\/claude-status\/)[^/]+/i, '$1:secret')
    .replace(/\d{17,20}/g, ':id'));
}

export function formatAuditLine(level, meta) {
  const safe = pickSafeMeta(meta);
  const ctx = pickSafeMeta(getAuditContext());
  const merged = { ...ctx, ...safe };
  const bits = [];
  for (const key of META_ORDER) {
    if (merged[key] == null || merged[key] === '') continue;
    if (key === 'elapsed_ms') {
      bits.push(`${merged[key]}ms`);
      continue;
    }
    bits.push(String(merged[key]));
  }
  const body = bits.join(' ').trim() || 'event';
  const label = String(level || 'INFO').trim().toUpperCase() || 'INFO';
  const prefix = `**${label}:**`;
  if (label === 'ERROR') return `${prefix} ${body} 🟥`;
  return `${prefix} ${body}`;
}

export function createAuditLogger(options = {}) {
  const now = options.now ?? (() => Date.now());

  function enqueue(line, level = 'INFO') {
    line = line.replace(/[\r\n]+/g, ' ');
    if (String(level).trim().toUpperCase() === 'ERROR') console.error(line);
    else console.log(line);
  }

  function emit(level, meta = {}) {
    try {
      const line = formatAuditLine(level, meta);
      enqueue(line, level);
      return line;
    } catch {
      return null;
    }
  }

  return {
    info(meta) {
      return emit('INFO', meta);
    },
    error(meta) {
      return emit('ERROR', meta);
    },
    emit,
    enqueue,
    get queueSize() {
      return 0;
    },
    get now() {
      return now;
    },
  };
}

export const audit = createAuditLogger();

export function createRequestId() {
  return randomUUID();
}

export function createHttpAuditMiddleware(logger = audit) {
  return function httpAuditMiddleware(req, res, next) {
    const requestId = createRequestId();
    const started = Date.now();
    runWithAuditContext({ request_id: requestId, subsystem: 'http' }, () => {
      let recorded = false;
      const record = (aborted = false) => {
        if (recorded) return;
        recorded = true;
        const elapsed = Date.now() - started;
        const route = sanitizeHttpRoute(req);
        const status = res.statusCode;
        const meta = {
          subsystem: 'http',
          method: req.method,
          route,
          status,
          elapsed_ms: elapsed,
          request_id: requestId,
          outcome: aborted || status >= 500 ? 'error' : 'ok',
          error_code: aborted ? 'client_abort' : undefined,
        };
        if (meta.outcome === 'error') logger.error(meta);
        else logger.info(meta);
      };
      res.on('finish', () => record(false));
      res.on('close', () => record(!res.writableEnded));
      next();
    });
  };
}

export function auditDiscordRest(logger = audit) {
  return function wrapRest(kind, endpoint, method, started, status, errorCode) {
    const elapsed_ms = Date.now() - started;
    const meta = {
      subsystem: 'discord-rest',
      action: kind,
      method,
      endpoint: normalizeDiscordEndpoint(endpoint),
      status,
      elapsed_ms,
      outcome: status >= 400 || errorCode ? 'error' : 'ok',
      error_code: errorCode,
    };
    if (meta.outcome === 'error') logger.error(meta);
    else logger.info(meta);
  };
}

export async function withOperationAudit(logger, fields, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const elapsed_ms = Date.now() - started;
    const isError = result?.isError === true;
    const errorCode = result?.structuredContent?.error;
    const meta = {
      ...fields,
      elapsed_ms,
      outcome: isError ? 'error' : 'ok',
      error_code: errorCode,
      status: result?.status,
    };
    if (isError) logger.error(meta);
    else logger.info(meta);
    return result;
  } catch (err) {
    const elapsed_ms = Date.now() - started;
    const error_code = err?.name === 'AbortError' || err?.code === 'ETIMEDOUT' ? 'timeout' : (err?.code || 'error');
    logger.error({
      ...fields,
      elapsed_ms,
      outcome: 'error',
      error_code,
      status: err?.status,
    });
    throw err;
  }
}
