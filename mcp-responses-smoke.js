/**
 * READ-only connectivity smoke test for the backend bridge
 *
 *   ZenBot backend (Northflank) → OpenAI Responses API → remote Botélia MCP
 *
 * Purpose: prove that a *backend* execution can drive the Botélia MCP server
 * without a ChatGPT OAuth session, so a future scheduled job does not depend on
 * ChatGPT Scheduled Tasks. It is deliberately not the scheduler.
 *
 * Auth model (machine-to-machine):
 *   1. Auth0 `client_credentials` grant → RS256 access token for
 *      `MCP_AUTH_AUDIENCE` with scope `botelia:read` only.
 *   2. The token is handed to the Responses API in the documented `authorization`
 *      field of the `mcp` tool. OpenAI sends it as `Authorization: Bearer <token>`
 *      to `server_url` and does not persist the value.
 *   3. Botélia keeps validating it exactly as today: RS256 against the issuer
 *      JWKS, exact `iss`/`aud`, `exp`, scope `botelia:read`, and `sub` in the
 *      configured subject allowlist. This script asks for nothing else.
 *
 * Safety rails, by construction:
 *   - `allowed_tools` is hardcoded to the read-only allowlist below; the request
 *     builder throws instead of emitting any WRITE tool name.
 *   - `require_approval: 'never'` is only acceptable *because* the allowlist is
 *     read-only; it is applied per tool name, never globally to the server.
 *   - `store: false` so the transcript is not retained by OpenAI.
 *   - Nothing here posts, edits or deletes on Discord.
 *   - Tokens, client secrets and API keys are never printed. Every line that can
 *     carry provider text goes through `redactSecrets()` first.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Tool names this smoke test is allowed to expose to the model. Read-only. */
export const SMOKE_ALLOWED_TOOLS = Object.freeze(['botelia_status']);

export const SMOKE_SERVER_LABEL = 'botelia';
export const DEFAULT_MODEL = 'gpt-5.6';
export const DEFAULT_SCOPE = 'botelia:read';
export const DEFAULT_SERVER_URL = '';
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** Only names — values live in the environment. */
export const REQUIRED_SMOKE_CONFIG = Object.freeze([
  'OPENAI_API_KEY',
  'MCP_AUTH_ISSUER',
  'MCP_AUTH_AUDIENCE',
  'MCP_M2M_CLIENT_ID',
  'MCP_M2M_CLIENT_SECRET',
  'MCP_SMOKE_SERVER_URL',
]);

const REQUEST_TIMEOUT_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * AbortSignal that fires after `ms`, same guarded pattern already used by
 * `fortnite-status-stream.js`.
 */
function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Auth0 issuers are canonically slash-terminated; tolerate either form. */
export function tokenUrlForIssuer(issuer) {
  return new URL('oauth/token', issuer.endsWith('/') ? issuer : `${issuer}/`).href;
}

/**
 * Reads smoke configuration. `missing` lists variable NAMES only — never values.
 */
export function readSmokeConfig(env = process.env) {
  const issuer = env.MCP_AUTH_ISSUER ?? '';
  const missing = REQUIRED_SMOKE_CONFIG.filter((name) => !env[name]);

  return {
    missing,
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.MCP_SMOKE_MODEL || DEFAULT_MODEL,
    serverUrl: env.MCP_SMOKE_SERVER_URL || DEFAULT_SERVER_URL,
    issuer,
    audience: env.MCP_AUTH_AUDIENCE ?? '',
    tokenUrl: env.MCP_M2M_TOKEN_URL || (issuer ? tokenUrlForIssuer(issuer) : ''),
    clientId: env.MCP_M2M_CLIENT_ID ?? '',
    clientSecret: env.MCP_M2M_CLIENT_SECRET ?? '',
    scope: env.MCP_M2M_SCOPE || DEFAULT_SCOPE,
    // Optional: local expectation check only. Never sent anywhere.
    expectedSubject: env.MCP_ALLOWED_SUBJECT ?? '',
  };
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/**
 * Replaces every known secret substring with a placeholder. Used on any text
 * that originates from a provider (error bodies, tool output) before printing.
 */
export function redactSecrets(text, secrets = []) {
  let out = typeof text === 'string' ? text : JSON.stringify(text);
  if (typeof out !== 'string') return '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Shows only enough of an identifier to correlate it, never the whole value. */
export function maskIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-2)}`;
}

// ─── Request building ───────────────────────────────────────────────────────

/**
 * Fails closed if anything outside the read-only allowlist is requested. This is
 * the single gate that keeps the smoke test from ever exposing a WRITE tool.
 */
export function assertReadOnlyTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('allowed_tools must be a non-empty array');
  }
  for (const name of tools) {
    if (!SMOKE_ALLOWED_TOOLS.includes(name)) {
      throw new Error(`tool "${name}" is not in the read-only smoke allowlist`);
    }
  }
  return tools;
}

/**
 * Builds the Responses API body. `authorization` carries the raw access token;
 * OpenAI turns it into `Authorization: Bearer <token>` toward `server_url` and
 * documents that it does not store the value.
 */
export function buildResponsesRequest({
  model,
  serverUrl,
  accessToken,
  allowedTools = SMOKE_ALLOWED_TOOLS,
  serverLabel = SMOKE_SERVER_LABEL,
  input = 'Call the botelia_status tool exactly once and report the returned '
    + 'service, status, version and mcp.toolCount. Do not call any other tool.',
}) {
  assertReadOnlyTools(allowedTools);
  if (!model) throw new Error('model is required');
  if (!serverUrl) throw new Error('serverUrl is required');
  if (!accessToken) throw new Error('accessToken is required');

  return {
    model,
    input,
    store: false,
    tools: [
      {
        type: 'mcp',
        server_label: serverLabel,
        server_description:
          'ZEN Botélia diagnostics. This smoke test exposes only the read-only '
          + 'botelia_status tool.',
        server_url: serverUrl,
        authorization: accessToken,
        allowed_tools: [...allowedTools],
        // Safe only because allowed_tools is read-only; keyed per tool name so a
        // future WRITE tool can never inherit this setting.
        require_approval: { never: { tool_names: [...allowedTools] } },
      },
    ],
  };
}

// ─── Token claims (local inspection only) ───────────────────────────────────

/**
 * Decodes JWT claims WITHOUT verifying the signature. Used only to report to the
 * operator which subject/scopes the M2M grant produced. Botélia itself always
 * verifies the signature; this never substitutes for that.
 */
export function decodeJwtClaims(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * `expectedSubjects` mirrors Botélia's own `MCP_ALLOWED_SUBJECT` parsing: one
 * value or a comma-separated allowlist, exact match only. This is a local
 * operator convenience — Botélia still enforces it independently.
 */
export function summarizeTokenClaims(token, { expectedSubject = '', expectedAudience = '' } = {}) {
  const claims = decodeJwtClaims(token);
  if (!claims) return { decoded: false };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud].filter(Boolean);
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
  const expectedSubjects = String(expectedSubject).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    decoded: true,
    subjectMasked: maskIdentifier(claims.sub ?? ''),
    subjectLooksMachineToMachine: typeof claims.sub === 'string' && claims.sub.endsWith('@clients'),
    subjectMatchesExpected: expectedSubjects.length > 0
      ? expectedSubjects.includes(claims.sub)
      : null,
    audienceMatchesExpected: expectedAudience ? audiences.includes(expectedAudience) : null,
    scopes,
    hasWriteScope: scopes.includes('botelia:write'),
    expiresInSeconds: typeof claims.exp === 'number'
      ? claims.exp - Math.floor(Date.now() / 1000)
      : null,
  };
}

// ─── Response parsing ───────────────────────────────────────────────────────

/**
 * Extracts the MCP-relevant facts from a Responses API result:
 * whether the server's tool list was fetched, whether the tool actually ran, and
 * whether an approval was demanded instead of executing.
 */
export function summarizeResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const listed = output.filter((item) => item?.type === 'mcp_list_tools');
  const calls = output.filter((item) => item?.type === 'mcp_call');
  const approvals = output.filter((item) => item?.type === 'mcp_approval_request');

  const listedToolNames = listed
    .flatMap((item) => (Array.isArray(item.tools) ? item.tools : []))
    .map((tool) => tool?.name)
    .filter((name) => typeof name === 'string');

  const statusCall = calls.find((call) => call?.name === 'botelia_status');
  let statusPayload = null;
  if (statusCall && typeof statusCall.output === 'string') {
    try {
      statusPayload = JSON.parse(statusCall.output);
    } catch {
      statusPayload = null;
    }
  }

  const text = output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();

  return {
    toolsListed: listed.length > 0,
    listedToolNames,
    approvalRequested: approvals.length > 0,
    calledTools: calls.map((call) => call?.name).filter(Boolean),
    statusCalled: Boolean(statusCall),
    statusError: statusCall?.error ?? null,
    statusPayload,
    text,
  };
}

/** Allowlisted projection of `botelia_status`; mirrors the tool's own contract. */
export function projectStatusPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    service: payload.service,
    status: payload.status,
    version: payload.version,
    nodeVersion: payload.nodeVersion,
    uptimeSeconds: payload.uptimeSeconds,
    toolCount: payload.mcp?.toolCount,
    mcpEnabled: payload.mcp?.enabled,
  };
}

// ─── Network steps ──────────────────────────────────────────────────────────

export async function fetchM2mToken(config, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: config.audience,
      scope: config.scope,
    }),
    signal: createTimeoutSignal(TOKEN_TIMEOUT_MS),
  });

  const raw = await res.text();
  if (!res.ok) {
    const detail = redactSecrets(raw, [config.clientSecret, config.clientId]).slice(0, 400);
    throw new Error(`token endpoint returned ${res.status}: ${detail}`);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('token endpoint returned a non-JSON body');
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('token endpoint returned no access_token');
  }
  return body.access_token;
}

export async function callResponsesApi(request, { apiKey, fetchImpl = fetch, url = RESPONSES_URL }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
    signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
  });

  const raw = await res.text();
  if (!res.ok) {
    const detail = redactSecrets(raw, [apiKey, request?.tools?.[0]?.authorization]).slice(0, 800);
    throw new Error(`Responses API returned ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Responses API returned a non-JSON body');
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Describes exactly what a live run would do, without any network call and
 * without any credential. This is what runs when configuration is incomplete,
 * so the script is always safe to execute.
 */
export function buildDryRunPlan(config) {
  return {
    mode: 'dry-run',
    missingConfig: [...config.missing],
    wouldRequestTokenFrom: config.tokenUrl || '(unset: needs MCP_AUTH_ISSUER)',
    wouldRequestAudience: config.audience || '(unset: needs MCP_AUTH_AUDIENCE)',
    wouldRequestScope: config.scope,
    wouldCall: RESPONSES_URL,
    withModel: config.model,
    withMcpServerUrl: config.serverUrl,
    withAllowedTools: [...SMOKE_ALLOWED_TOOLS],
    writesPerformed: 'none',
  };
}

export async function runSmoke({ env = process.env, logger = console, fetchImpl = fetch } = {}) {
  const config = readSmokeConfig(env);

  if (config.missing.length > 0) {
    const plan = buildDryRunPlan(config);
    logger.log('[smoke] incomplete configuration — dry run only, no network call.');
    logger.log(`[smoke] missing (names only): ${plan.missingConfig.join(', ')}`);
    logger.log(JSON.stringify(plan, null, 2));
    // Not a pass: connectivity was not proven, so the exit code stays non-zero.
    logger.log('[smoke] DRY RUN — connectivity not proven; exit code 1 by design.');
    return { ok: false, mode: 'dry-run', plan };
  }

  logger.log('[smoke] step 1/3 — requesting Auth0 client_credentials token');
  const accessToken = await fetchM2mToken(config, { fetchImpl });
  const claims = summarizeTokenClaims(accessToken, {
    expectedSubject: config.expectedSubject,
    expectedAudience: config.audience,
  });
  logger.log(`[smoke] token acquired: ${JSON.stringify(claims)}`);
  if (claims.hasWriteScope) {
    throw new Error('M2M grant carries botelia:write; this READ-only smoke refuses to continue');
  }
  if (!claims.decoded) {
    // Botélia only accepts RS256 JWTs, so an undecodable token cannot pass its
    // verification either. Say so instead of implying the scope was checked.
    logger.log('[smoke] token is not a decodable JWT — local scope check skipped.');
  }

  logger.log('[smoke] step 2/3 — calling the Responses API with the MCP tool');
  const request = buildResponsesRequest({
    model: config.model,
    serverUrl: config.serverUrl,
    accessToken,
  });
  const response = await callResponsesApi(request, { apiKey: config.apiKey, fetchImpl });

  logger.log('[smoke] step 3/3 — inspecting the MCP items');
  const summary = summarizeResponse(response);
  const secrets = [accessToken, config.apiKey, config.clientSecret];

  const report = {
    mode: 'live',
    toolsListed: summary.toolsListed,
    listedToolNames: summary.listedToolNames,
    approvalRequested: summary.approvalRequested,
    calledTools: summary.calledTools,
    statusCalled: summary.statusCalled,
    statusError: summary.statusError ? redactSecrets(summary.statusError, secrets) : null,
    status: projectStatusPayload(summary.statusPayload),
    modelText: redactSecrets(summary.text, secrets).slice(0, 500),
    writesPerformed: 'none',
  };
  logger.log(JSON.stringify(report, null, 2));

  const ok = summary.toolsListed
    && summary.statusCalled
    && !summary.statusError
    && report.status?.status === 'ok';
  logger.log(ok ? '[smoke] PASS — backend reached Botélia MCP through the Responses API.'
    : '[smoke] FAIL — see the report above.');
  return { ok, mode: 'live', report };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const result = await runSmoke();
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    // Message only — provider bodies are already redacted at the source.
    console.error(`[smoke] ERROR: ${err?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}
