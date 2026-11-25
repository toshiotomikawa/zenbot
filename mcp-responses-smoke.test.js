/**
 * Offline tests for the Responses API → Botélia MCP smoke test.
 * No live network: OpenAI and Auth0 are both replaced by injected fetch stubs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReadOnlyTools,
  buildDryRunPlan,
  buildResponsesRequest,
  callResponsesApi,
  decodeJwtClaims,
  fetchM2mToken,
  maskIdentifier,
  projectStatusPayload,
  readSmokeConfig,
  redactSecrets,
  RESPONSES_URL,
  runSmoke,
  SMOKE_ALLOWED_TOOLS,
  summarizeResponse,
  summarizeTokenClaims,
  tokenUrlForIssuer,
} from './mcp-responses-smoke.js';

const ISSUER = 'https://issuer.test.local/';
const AUDIENCE = 'https://resource.test.local/mcp';
const CLIENT_SECRET = 'client-secret-value-0123456789';
const API_KEY = 'sk-test-key-0123456789abcdef';

const FULL_ENV = {
  OPENAI_API_KEY: API_KEY,
  MCP_AUTH_ISSUER: ISSUER,
  MCP_AUTH_AUDIENCE: AUDIENCE,
  MCP_M2M_CLIENT_ID: 'client-id-0001',
  MCP_M2M_CLIENT_SECRET: CLIENT_SECRET,
  MCP_SMOKE_SERVER_URL: 'https://resource.test.local/mcp',
};

function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

function silentLogger() {
  const lines = [];
  const push = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, log: push, warn: push, error: push };
}

function statusOutput() {
  return JSON.stringify({
    service: 'zenbot',
    status: 'ok',
    version: '1.0.0',
    nodeVersion: 'v20.0.0',
    uptimeSeconds: 42,
    serverTimeUtc: '2026-08-14T00:00:00.000Z',
    mcp: { enabled: true, toolCount: 8 },
    subsystems: {
      interactionsRouteConfigured: true,
      presenceGatewayConfigured: true,
      llmProvidersConfigured: 1,
    },
  });
}

function happyResponse() {
  return {
    output: [
      { type: 'mcp_list_tools', server_label: 'botelia', tools: [{ name: 'botelia_status' }] },
      { type: 'mcp_call', name: 'botelia_status', server_label: 'botelia', output: statusOutput(), error: null },
      { type: 'message', content: [{ type: 'output_text', text: 'zenbot is ok.' }] },
    ],
  };
}

/**
 * Fetch stub: first call is the Auth0 token endpoint, second is the Responses API.
 * Records both requests so tests can assert on what actually went out.
 */
function stubFetch({ token, response, tokenStatus = 200, responseStatus = 200 }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/oauth/token')) {
      return {
        ok: tokenStatus === 200,
        status: tokenStatus,
        text: async () => JSON.stringify({ access_token: token, token_type: 'Bearer' }),
      };
    }
    return {
      ok: responseStatus === 200,
      status: responseStatus,
      text: async () => JSON.stringify(response),
    };
  };
  impl.calls = calls;
  return impl;
}

// ─── Config ─────────────────────────────────────────────────────────────────

test('readSmokeConfig reports only missing variable NAMES', () => {
  const config = readSmokeConfig({ MCP_AUTH_ISSUER: ISSUER });
  assert.deepEqual(config.missing, [
    'OPENAI_API_KEY', 'MCP_AUTH_AUDIENCE', 'MCP_M2M_CLIENT_ID', 'MCP_M2M_CLIENT_SECRET', 'MCP_SMOKE_SERVER_URL',
  ]);
  assert.equal(config.missing.join(' ').includes(ISSUER), false);
});

test('token URL is derived from either issuer form', () => {
  assert.equal(tokenUrlForIssuer('https://x.auth0.com/'), 'https://x.auth0.com/oauth/token');
  assert.equal(tokenUrlForIssuer('https://x.auth0.com'), 'https://x.auth0.com/oauth/token');
});

test('scope defaults to botelia:read', () => {
  assert.equal(readSmokeConfig(FULL_ENV).scope, 'botelia:read');
});

// ─── Read-only gate ─────────────────────────────────────────────────────────

test('the smoke allowlist contains only botelia_status', () => {
  assert.deepEqual([...SMOKE_ALLOWED_TOOLS], ['botelia_status']);
});

for (const writeTool of [
  'botelia_post_issue_message',
  'botelia_ensure_issue_thread',
  'botelia_handoff_alex_work',
]) {
  test(`assertReadOnlyTools rejects ${writeTool}`, () => {
    assert.throws(() => assertReadOnlyTools([writeTool]), /read-only smoke allowlist/);
    assert.throws(
      () => buildResponsesRequest({
        model: 'm', serverUrl: 'https://x/mcp', accessToken: 't', allowedTools: [writeTool],
      }),
      /read-only smoke allowlist/,
    );
  });
}

test('assertReadOnlyTools rejects an empty tool list', () => {
  assert.throws(() => assertReadOnlyTools([]), /non-empty/);
});

// ─── Request shape ──────────────────────────────────────────────────────────

test('buildResponsesRequest emits the documented MCP tool fields', () => {
  const request = buildResponsesRequest({
    model: 'gpt-test', serverUrl: 'https://resource.test.local/mcp', accessToken: 'access-token-value',
  });
  const [tool] = request.tools;
  assert.equal(tool.type, 'mcp');
  assert.equal(tool.server_label, 'botelia');
  assert.equal(tool.server_url, 'https://resource.test.local/mcp');
  assert.equal(tool.authorization, 'access-token-value');
  assert.deepEqual(tool.allowed_tools, ['botelia_status']);
  assert.deepEqual(tool.require_approval, { never: { tool_names: ['botelia_status'] } });
  assert.equal(request.store, false, 'the transcript must not be stored by OpenAI');
});

test('buildResponsesRequest requires model, server URL and token', () => {
  assert.throws(() => buildResponsesRequest({ serverUrl: 'https://x/mcp', accessToken: 't' }), /model/);
  assert.throws(() => buildResponsesRequest({ model: 'm', accessToken: 't' }), /serverUrl/);
  assert.throws(() => buildResponsesRequest({ model: 'm', serverUrl: 'https://x/mcp' }), /accessToken/);
});

// ─── Redaction ──────────────────────────────────────────────────────────────

test('redactSecrets removes every supplied secret', () => {
  const text = `boom ${API_KEY} and ${CLIENT_SECRET}`;
  const out = redactSecrets(text, [API_KEY, CLIENT_SECRET]);
  assert.equal(out.includes(API_KEY), false);
  assert.equal(out.includes(CLIENT_SECRET), false);
  assert.equal(out, 'boom [redacted] and [redacted]');
});

test('maskIdentifier never returns the full value', () => {
  assert.equal(maskIdentifier('abcdefghijklmnop@clients'), 'abcdef…ts');
  assert.equal(maskIdentifier('short'), 'sh…');
  assert.equal(maskIdentifier(''), '');
  assert.equal(maskIdentifier(undefined), '');
});

// ─── Token claims ───────────────────────────────────────────────────────────

test('summarizeTokenClaims masks the subject and reports scopes', () => {
  const token = fakeJwt({
    sub: 'AbCdEfGhIjKlMnOp@clients',
    aud: AUDIENCE,
    scope: 'botelia:read',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const summary = summarizeTokenClaims(token, {
    expectedSubject: 'AbCdEfGhIjKlMnOp@clients', expectedAudience: AUDIENCE,
  });
  assert.equal(summary.decoded, true);
  assert.equal(summary.subjectLooksMachineToMachine, true);
  assert.equal(summary.subjectMatchesExpected, true);
  assert.equal(summary.audienceMatchesExpected, true);
  assert.deepEqual(summary.scopes, ['botelia:read']);
  assert.equal(summary.hasWriteScope, false);
  assert.equal(JSON.stringify(summary).includes('AbCdEfGhIjKlMnOp@clients'), false);
});

test('summarizeTokenClaims matches a comma-separated expected-subject allowlist', () => {
  const token = fakeJwt({ sub: 'm2m-0001@clients', aud: AUDIENCE, scope: 'botelia:read', exp: 1 });
  const allowlist = ' auth0|interactive , m2m-0001@clients ';
  assert.equal(summarizeTokenClaims(token, { expectedSubject: allowlist }).subjectMatchesExpected, true);
  assert.equal(
    summarizeTokenClaims(token, { expectedSubject: 'auth0|interactive,other@clients' }).subjectMatchesExpected,
    false,
  );
  assert.equal(
    summarizeTokenClaims(token, { expectedSubject: 'm2m-0001@client' }).subjectMatchesExpected,
    false,
    'a prefix must not count as a match',
  );
  assert.equal(summarizeTokenClaims(token, { expectedSubject: '' }).subjectMatchesExpected, null);
});

test('summarizeTokenClaims flags a write scope', () => {
  const token = fakeJwt({ sub: 'x@clients', aud: AUDIENCE, scope: 'botelia:read botelia:write', exp: 1 });
  assert.equal(summarizeTokenClaims(token).hasWriteScope, true);
});

test('decodeJwtClaims returns null for a malformed token', () => {
  assert.equal(decodeJwtClaims('not-a-jwt'), null);
});

// ─── Response parsing ───────────────────────────────────────────────────────

test('summarizeResponse extracts listing, call and payload', () => {
  const summary = summarizeResponse(happyResponse());
  assert.equal(summary.toolsListed, true);
  assert.deepEqual(summary.listedToolNames, ['botelia_status']);
  assert.equal(summary.approvalRequested, false);
  assert.deepEqual(summary.calledTools, ['botelia_status']);
  assert.equal(summary.statusCalled, true);
  assert.equal(summary.statusPayload.status, 'ok');
  assert.equal(summary.text, 'zenbot is ok.');
});

test('summarizeResponse surfaces an approval request instead of a call', () => {
  const summary = summarizeResponse({
    output: [{ type: 'mcp_approval_request', name: 'botelia_status' }],
  });
  assert.equal(summary.approvalRequested, true);
  assert.equal(summary.statusCalled, false);
});

test('projectStatusPayload keeps only allowlisted fields', () => {
  const projected = projectStatusPayload(JSON.parse(statusOutput()));
  assert.deepEqual(Object.keys(projected).sort(), [
    'mcpEnabled', 'nodeVersion', 'service', 'status', 'toolCount', 'uptimeSeconds', 'version',
  ]);
  assert.equal(projected.toolCount, 8);
  assert.equal('subsystems' in projected, false);
});

// ─── Network steps ──────────────────────────────────────────────────────────

test('fetchM2mToken posts a client_credentials grant with the audience and scope', async () => {
  const impl = stubFetch({ token: fakeJwt({ sub: 'x@clients' }), response: happyResponse() });
  const config = readSmokeConfig(FULL_ENV);
  await fetchM2mToken(config, { fetchImpl: impl });
  const [call] = impl.calls;
  assert.equal(call.url, 'https://issuer.test.local/oauth/token');
  assert.equal(call.body.grant_type, 'client_credentials');
  assert.equal(call.body.audience, AUDIENCE);
  assert.equal(call.body.scope, 'botelia:read');
});

test('fetchM2mToken redacts the client secret from an error body', async () => {
  const impl = async () => ({
    ok: false, status: 401, text: async () => `bad secret ${CLIENT_SECRET}`,
  });
  await assert.rejects(
    () => fetchM2mToken(readSmokeConfig(FULL_ENV), { fetchImpl: impl }),
    (err) => {
      assert.equal(err.message.includes(CLIENT_SECRET), false);
      assert.match(err.message, /token endpoint returned 401/);
      return true;
    },
  );
});

test('callResponsesApi sends the API key as a Bearer header and redacts it on error', async () => {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    return { ok: false, status: 400, text: async () => `bad key ${API_KEY}` };
  };
  const request = buildResponsesRequest({
    model: 'gpt-test', serverUrl: 'https://resource.test.local/mcp', accessToken: 'tok',
  });
  await assert.rejects(
    () => callResponsesApi(request, { apiKey: API_KEY, fetchImpl: impl }),
    (err) => {
      assert.equal(err.message.includes(API_KEY), false);
      return true;
    },
  );
  assert.equal(seen[0].url, RESPONSES_URL);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${API_KEY}`);
});

// ─── Runner ─────────────────────────────────────────────────────────────────

test('runSmoke stays offline and dry when configuration is incomplete', async () => {
  let called = 0;
  const logger = silentLogger();
  const result = await runSmoke({
    env: { MCP_AUTH_ISSUER: ISSUER },
    logger,
    fetchImpl: async () => { called += 1; },
  });
  assert.equal(called, 0, 'a dry run must not touch the network');
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan.withAllowedTools, ['botelia_status']);
  assert.equal(result.plan.writesPerformed, 'none');
});

test('buildDryRunPlan never contains a secret value', () => {
  const plan = buildDryRunPlan(readSmokeConfig(FULL_ENV));
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(CLIENT_SECRET), false);
  assert.equal(serialized.includes(API_KEY), false);
});

test('runSmoke passes end to end against stubbed providers', async () => {
  const token = fakeJwt({
    sub: 'machine-client-0001@clients',
    aud: AUDIENCE,
    scope: 'botelia:read',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const impl = stubFetch({ token, response: happyResponse() });
  const logger = silentLogger();
  const result = await runSmoke({ env: FULL_ENV, logger, fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.report.toolsListed, true);
  assert.equal(result.report.statusCalled, true);
  assert.equal(result.report.status.status, 'ok');
  assert.equal(result.report.writesPerformed, 'none');

  const responsesCall = impl.calls.find((c) => String(c.url) === RESPONSES_URL);
  assert.equal(responsesCall.body.tools[0].authorization, token);
  assert.deepEqual(responsesCall.body.tools[0].allowed_tools, ['botelia_status']);

  const logged = logger.lines.join('\n');
  assert.equal(logged.includes(token), false, 'the access token must never be logged');
  assert.equal(logged.includes(CLIENT_SECRET), false);
  assert.equal(logged.includes(API_KEY), false);
  assert.equal(logged.includes('machine-client-0001@clients'), false, 'subject must stay masked');
});

test('runSmoke refuses to continue when the M2M grant carries botelia:write', async () => {
  const token = fakeJwt({
    sub: 'x@clients', aud: AUDIENCE, scope: 'botelia:read botelia:write', exp: 1,
  });
  const impl = stubFetch({ token, response: happyResponse() });
  await assert.rejects(
    () => runSmoke({ env: FULL_ENV, logger: silentLogger(), fetchImpl: impl }),
    /botelia:write/,
  );
  assert.equal(impl.calls.length, 1, 'the Responses API must not be reached');
});

test('runSmoke says so when the token is not a decodable JWT instead of implying a scope check', async () => {
  const impl = stubFetch({ token: 'opaque-token-value', response: happyResponse() });
  const logger = silentLogger();
  const result = await runSmoke({ env: FULL_ENV, logger, fetchImpl: impl });
  const logged = logger.lines.join('\n');
  assert.match(logged, /not a decodable JWT/);
  assert.equal(logged.includes('opaque-token-value'), false, 'the token must never be logged');
  assert.equal(result.mode, 'live');
});

test('runSmoke fails when the tool was listed but never executed', async () => {
  const impl = stubFetch({
    token: fakeJwt({ sub: 'x@clients', aud: AUDIENCE, scope: 'botelia:read', exp: 1 }),
    response: { output: [{ type: 'mcp_list_tools', tools: [{ name: 'botelia_status' }] }] },
  });
  const result = await runSmoke({ env: FULL_ENV, logger: silentLogger(), fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.report.toolsListed, true);
  assert.equal(result.report.statusCalled, false);
});
