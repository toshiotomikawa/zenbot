/**
 * Offline tests for the MCP OAuth resource server.
 * No live network, no Auth0, no Discord REST, no Gateway.
 *
 * JWTs are signed with RSA keys generated at runtime and verified against a
 * local JWKS injected into the verifier, so nothing here touches the internet.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { verifyKeyMiddleware } from 'discord-interactions';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  buildProtectedResourceMetadata,
  buildStatusPayload,
  createMcpServer,
  createTokenVerifier,
  DISCORD_TOOL_NAMES,
  MCP_ROUTE,
  MCP_SCOPE,
  MCP_WRITE_SCOPE,
  parseAllowedSubjects,
  readMcpConfig,
  registerMcpServer,
  REQUIRED_CONFIG,
  TOOL_NAMES,
} from './mcp.js';

const ISSUER = 'https://issuer.test.local/';
const AUDIENCE = 'https://resource.test.local/mcp';
const SUBJECT = 'auth0|test-subject-0001';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const FULL_ENV = {
  MCP_ENABLED: '1',
  MCP_AUTH_ISSUER: ISSUER,
  MCP_AUTH_AUDIENCE: AUDIENCE,
  MCP_ALLOWED_SUBJECT: SUBJECT,
};

// ─── Key material ───────────────────────────────────────────────────────────

const good = await generateKeyPair('RS256', { extractable: true });
const rogue = await generateKeyPair('RS256', { extractable: true });
const psKeys = await generateKeyPair('PS256', { extractable: true });

async function localJwks(...publicKeys) {
  const keys = [];
  for (let i = 0; i < publicKeys.length; i += 1) {
    const jwk = await exportJWK(publicKeys[i]);
    keys.push({ ...jwk, kid: `k${i}`, alg: 'RS256', use: 'sig' });
  }
  return createLocalJWKSet({ keys });
}

const JWKS = await localJwks(good.publicKey);

async function signToken({
  key = good.privateKey,
  alg = 'RS256',
  kid = 'k0',
  issuer = ISSUER,
  audience = AUDIENCE,
  subject = SUBJECT,
  scope = MCP_SCOPE,
  expiresIn = '5m',
  omitSub = false,
  omitExp = false,
} = {}) {
  const jwt = new SignJWT({ ...(scope === null ? {} : { scope }), azp: 'test-client' })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience);
  if (!omitSub) jwt.setSubject(subject);
  if (!omitExp) jwt.setExpirationTime(expiresIn);
  return jwt.sign(key);
}

// ─── Harness ────────────────────────────────────────────────────────────────

function silentLogger() {
  const lines = [];
  const push = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, log: push, warn: push, error: push };
}

async function withServer(register, fn) {
  const app = express();
  const result = register(app);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(port, result);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function registerFull(app, extra = {}) {
  return registerMcpServer(app, {
    env: FULL_ENV,
    jwks: JWKS,
    logger: silentLogger(),
    ...extra,
  });
}

async function rpc(port, body, token) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return {
    status: res.status,
    www: res.headers.get('www-authenticate'),
    sessionId: res.headers.get('mcp-session-id'),
    json,
    text,
  };
}

const initializeRequest = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
});

// ─── Config gating ──────────────────────────────────────────────────────────

test('MCP_ENABLED is opt-in: only "1" and "true" enable it', () => {
  for (const value of [undefined, '', '0', 'false', 'no', 'yes', 'TRUEISH']) {
    assert.equal(readMcpConfig({ MCP_ENABLED: value }).enabled, false, `value=${value}`);
  }
  assert.equal(readMcpConfig({ MCP_ENABLED: '1' }).enabled, true);
  assert.equal(readMcpConfig({ MCP_ENABLED: 'TRUE' }).enabled, true);
});

test('disabled MCP registers no route at all', async () => {
  const logger = silentLogger();
  await withServer(
    (app) => registerMcpServer(app, { env: { ...FULL_ENV, MCP_ENABLED: '0' }, logger }),
    async (port, result) => {
      assert.deepEqual(result, { registered: false, reason: 'disabled' });
      assert.equal((await rpc(port, initializeRequest())).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`)).status, 404);
      const meta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(meta.status, 404);
    },
  );
  assert.equal(logger.lines.length, 0);
});

test('incomplete configuration blocks registration and names only the missing vars', async () => {
  for (const missingVar of REQUIRED_CONFIG) {
    const env = { ...FULL_ENV };
    delete env[missingVar];
    const logger = silentLogger();
    await withServer(
      (app) => registerMcpServer(app, { env, logger, jwks: JWKS }),
      async (port, result) => {
        assert.equal(result.registered, false);
        assert.equal(result.reason, 'missing_config');
        assert.deepEqual(result.missing, [missingVar]);
        assert.equal((await rpc(port, initializeRequest())).status, 404);
        assert.equal((await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`)).status, 404);
      },
    );
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], new RegExp(missingVar));
    // The warning must carry names, never values.
    assert.ok(!logger.lines[0].includes(SUBJECT));
    assert.ok(!logger.lines[0].includes(AUDIENCE));
  }
});

// ─── Unauthenticated behaviour ──────────────────────────────────────────────

test('no Authorization header returns 401 with spec-shaped WWW-Authenticate', async () => {
  await withServer(registerFull, async (port) => {
    const res = await rpc(port, initializeRequest());
    assert.equal(res.status, 401);
    assert.match(res.www, /^Bearer /);
    assert.match(res.www, /error="invalid_token"/);
    assert.match(res.www, /scope="botelia:read"/);
    assert.match(
      res.www,
      /resource_metadata="https:\/\/resource\.test\.local\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });
});

test('Protected Resource Metadata is served at the RFC 9728 path', async () => {
  await withServer(registerFull, async (port, result) => {
    assert.equal(
      result.resourceMetadataUrl,
      'https://resource.test.local/.well-known/oauth-protected-resource/mcp',
    );
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      scopes_supported: [MCP_SCOPE],
      resource_name: 'Botélia MCP',
    });
  });
});

test('authorization server compatibility document points at the authoritative issuer', async () => {
  await withServer(registerFull, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.issuer, ISSUER);
    assert.equal(body.authorization_endpoint, `${ISSUER}authorize`);
    assert.equal(body.token_endpoint, `${ISSUER}oauth/token`);
    assert.equal(body.jwks_uri, `${ISSUER}.well-known/jwks.json`);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  });
});

test('GET /mcp is 405 with Allow: POST; initialize and .well-known discovery stay intact', async () => {
  const token = await signToken();
  await withServer(registerFull, async (port) => {
    const probes = [
      await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`),
      await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      }),
    ];
    for (const probe of probes) {
      assert.equal(probe.status, 405);
      assert.equal(probe.headers.get('allow'), 'POST');
      assert.equal(probe.headers.get('www-authenticate'), null);
      const body = await probe.text();
      assert.equal(body, '');
      assert.ok(!body.includes(SUBJECT));
      assert.ok(!body.includes(AUDIENCE));
      assert.ok(!body.includes(ISSUER));
    }

    const unauthenticatedPost = await rpc(port, initializeRequest());
    assert.equal(unauthenticatedPost.status, 401);
    assert.match(unauthenticatedPost.www, /^Bearer /);

    const init = await rpc(port, initializeRequest(), token);
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'botelia');

    const protectedMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(protectedMeta.status, 200);
    assert.deepEqual(await protectedMeta.json(), {
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      scopes_supported: [MCP_SCOPE],
      resource_name: 'Botélia MCP',
    });

    const asMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    assert.equal(asMeta.status, 200);
    const asBody = await asMeta.json();
    assert.equal(asBody.issuer, ISSUER);
    assert.equal(asBody.authorization_endpoint, `${ISSUER}authorize`);
    assert.equal(asBody.token_endpoint, `${ISSUER}oauth/token`);
  });
});

// ─── JWT rejection matrix ───────────────────────────────────────────────────

const REJECTIONS = [
  ['signature from an unknown key', () => signToken({ key: rogue.privateKey }), 401],
  ['unexpected algorithm (PS256)', () => signToken({ key: psKeys.privateKey, alg: 'PS256' }), 401],
  ['wrong issuer', () => signToken({ issuer: 'https://evil.test.local/' }), 401],
  ['wrong audience', () => signToken({ audience: 'https://resource.test.local/other' }), 401],
  ['expired token', () => signToken({ expiresIn: '-1m' }), 401],
  ['missing subject', () => signToken({ omitSub: true }), 401],
  ['different subject', () => signToken({ subject: 'auth0|someone-else' }), 401],
  ['no expiration claim', () => signToken({ omitExp: true }), 401],
  ['garbage token', () => Promise.resolve('not-a-jwt'), 401],
  ['missing scope', () => signToken({ scope: null }), 403],
  ['unrelated scope only', () => signToken({ scope: 'openid profile' }), 403],
];

for (const [label, make, expected] of REJECTIONS) {
  test(`rejects: ${label}`, async () => {
    const token = await make();
    await withServer(registerFull, async (port) => {
      const res = await rpc(port, initializeRequest(), token);
      assert.equal(res.status, expected, `${label} -> ${res.status}`);
      assert.ok(res.www, 'WWW-Authenticate must be present');
      // The rejection must never echo the token back.
      assert.ok(!res.text.includes(token));
      assert.ok(!res.text.includes(SUBJECT));
    });
  });
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('valid token unlocks initialize, tools/list and tools/call', async () => {
  const token = await signToken();
  await withServer(registerFull, async (port) => {
    const init = await rpc(port, initializeRequest(), token);
    assert.equal(init.status, 200);
    assert.equal(init.sessionId, null, 'stateless: no session id');
    assert.equal(init.json.result.serverInfo.name, 'botelia');

    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token);
    assert.equal(list.status, 200);
    const { tools } = list.json.result;
    assert.equal(tools.length, 1);
    assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES]);
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const call = await rpc(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'botelia_status', arguments: {} },
    }, token);
    assert.equal(call.status, 200);
    const sc = call.json.result.structuredContent;
    assert.equal(sc.service, 'zenbot');
    assert.equal(sc.status, 'ok');
    assert.equal(sc.mcp.toolCount, TOOL_NAMES.length);
    assert.deepEqual(JSON.parse(call.json.result.content[0].text), sc);
  });
});

test('concurrent stateless calls use exclusive server/transport pairs without crossed responses', async () => {
  const token = await signToken();
  const servers = [];
  const requestIds = Array.from({ length: 8 }, (_, index) => 100 + index);

  await withServer(
    (app) => registerFull(app, {
      serverFactory: () => {
        const server = createMcpServer();
        servers.push(server);
        return server;
      },
    }),
    async (port) => {
      const responses = await Promise.all(requestIds.map((id) => rpc(port, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'botelia_status', arguments: {} },
      }, token)));

      assert.equal(servers.length, requestIds.length);
      assert.equal(new Set(servers).size, requestIds.length);
      for (let index = 0; index < responses.length; index += 1) {
        const response = responses[index];
        assert.equal(response.status, 200);
        assert.equal(response.json.id, requestIds[index]);
        assert.equal(response.json.result.structuredContent.status, 'ok');
        assert.ok(!response.text.includes('mcp_error'));
      }
    },
  );
});

test('token with extra scopes alongside botelia:read is accepted', async () => {
  const token = await signToken({ scope: `openid ${MCP_SCOPE} profile` });
  await withServer(registerFull, async (port) => {
    assert.equal((await rpc(port, initializeRequest(), token)).status, 200);
  });
});

test('verifier returns AuthInfo shaped for requireBearerAuth', async () => {
  const verifier = createTokenVerifier({
    issuer: ISSUER, audience: AUDIENCE, allowedSubject: SUBJECT, jwks: JWKS,
  });
  const token = await signToken();
  const info = await verifier.verifyAccessToken(token);
  assert.equal(info.token, token);
  assert.equal(info.clientId, 'test-client');
  assert.deepEqual(info.scopes, [MCP_SCOPE]);
  assert.equal(typeof info.expiresAt, 'number');
  assert.equal(info.resource.href, AUDIENCE);
  assert.equal(info.sub, undefined, 'AuthInfo must not carry the subject');
});

test('createTokenVerifier refuses to build without full configuration', () => {
  assert.throws(() => createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE }));
  assert.throws(() => createTokenVerifier({}));
  assert.throws(() => createTokenVerifier({
    issuer: ISSUER, audience: AUDIENCE, allowedSubject: ' , ,, ', jwks: JWKS,
  }), /allowedSubjects/);
});

// ─── Subject allowlist (machine-to-machine alongside the interactive client) ──

const M2M_SUBJECT = 'machine-client-0001@clients';

test('parseAllowedSubjects trims, drops blanks and keeps exact values', () => {
  assert.deepEqual(parseAllowedSubjects(` ${SUBJECT} , ,${M2M_SUBJECT}, `), [SUBJECT, M2M_SUBJECT]);
  assert.deepEqual(parseAllowedSubjects(''), []);
  assert.deepEqual(parseAllowedSubjects(undefined), []);
  assert.deepEqual(parseAllowedSubjects(' , , '), []);
});

test('an allowlist that is blank after trimming keeps MCP_ALLOWED_SUBJECT missing', () => {
  const config = readMcpConfig({ ...FULL_ENV, MCP_ALLOWED_SUBJECT: ' , ' });
  assert.deepEqual(config.missing, ['MCP_ALLOWED_SUBJECT']);
  assert.deepEqual(config.allowedSubjects, []);
});

test('a single-value MCP_ALLOWED_SUBJECT keeps behaving exactly as before', async () => {
  const config = readMcpConfig(FULL_ENV);
  assert.deepEqual(config.allowedSubjects, [SUBJECT]);
  await withServer(registerFull, async (port) => {
    assert.equal((await rpc(port, initializeRequest(), await signToken())).status, 200);
    assert.equal(
      (await rpc(port, initializeRequest(), await signToken({ subject: M2M_SUBJECT }))).status,
      401,
      'a subject outside the allowlist must stay rejected',
    );
  });
});

test('both allowlisted subjects are accepted and everything else is still rejected', async () => {
  const env = { ...FULL_ENV, MCP_ALLOWED_SUBJECT: `${SUBJECT},${M2M_SUBJECT}` };
  const register = (app) => registerMcpServer(app, { env, jwks: JWKS, logger: silentLogger() });
  await withServer(register, async (port) => {
    for (const subject of [SUBJECT, M2M_SUBJECT]) {
      const res = await rpc(port, initializeRequest(), await signToken({ subject }));
      assert.equal(res.status, 200, `subject ${subject} should be authorized`);
    }
    for (const subject of ['auth0|someone-else', `${M2M_SUBJECT} `, M2M_SUBJECT.slice(0, -1)]) {
      const res = await rpc(port, initializeRequest(), await signToken({ subject }));
      assert.equal(res.status, 401, `subject ${subject} must be rejected`);
    }
  });
});

test('an allowlisted subject still needs a valid signature, issuer, audience and scope', async () => {
  const env = { ...FULL_ENV, MCP_ALLOWED_SUBJECT: `${SUBJECT},${M2M_SUBJECT}` };
  const register = (app) => registerMcpServer(app, { env, jwks: JWKS, logger: silentLogger() });
  await withServer(register, async (port) => {
    const cases = [
      [await signToken({ subject: M2M_SUBJECT, key: rogue.privateKey }), 401],
      [await signToken({ subject: M2M_SUBJECT, issuer: 'https://evil.test.local/' }), 401],
      [await signToken({ subject: M2M_SUBJECT, audience: 'https://resource.test.local/other' }), 401],
      [await signToken({ subject: M2M_SUBJECT, expiresIn: '-1m' }), 401],
      [await signToken({ subject: M2M_SUBJECT, scope: null }), 403],
    ];
    for (const [token, expected] of cases) {
      assert.equal((await rpc(port, initializeRequest(), token)).status, expected);
    }
  });
});

// ─── Isolation and hygiene ──────────────────────────────────────────────────

test('MCP Discord access is isolated to dedicated READ/WRITE modules and keeps no path secret', () => {
  const source = fs.readFileSync(path.join(MODULE_DIR, 'mcp.js'), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const specifier of imports) {
    if (specifier === './mcp-discord-read.js' || specifier === './mcp-discord-write.js'
      || specifier === './mcp-discord-research.js'
      || specifier === './mcp-discord-2a3a.js') continue;
    assert.ok(!/utils\.js|presence\.js|discord/i.test(specifier));
  }
  assert.ok(!source.includes('DiscordRequest'));
  assert.ok(!source.includes('MCP_SHARED_SECRET'), 'path-secret config must be gone');
  assert.ok(!/['"`]\/mcp\/:secret/.test(source), 'path-secret route must be gone');
  // Every app.use() must be path-scoped: a string path as first argument.
  // A bare app.use(fn) would be global middleware and could break /interactions.
  const uses = [...source.matchAll(/app\.use\(\s*([^\n]*)/g)].map((m) => m[1].trim());
  for (const first of uses) {
    const pathScoped = /^['"`]/.test(first) || /^[A-Za-z_$][\w$]*Path\b/.test(first);
    assert.ok(pathScoped, `app.use must be path-scoped, got: ${first}`);
  }
  assert.ok(!/express\.json\(\)\s*\)/.test(source), 'no global json parser');
  const tokenMentions = source.match(/DISCORD_TOKEN/g) ?? [];
  const booleanProbes = source.match(/isSet\('DISCORD_TOKEN'\)/g) ?? [];
  assert.equal(tokenMentions.length, booleanProbes.length);
});

test('Discord READ tools appear only with complete separate config and preserve status', async () => {
  const discordEnv = {
    ...FULL_ENV,
    MCP_DISCORD_READ_ENABLED: '1',
    MCP_DISCORD_GUILD_IDS: '11111111111111111',
    MCP_DISCORD_PARENT_CHANNEL_IDS: '22222222222222222',
    DISCORD_TOKEN: 'sentinel-discord-token',
  };
  const discordReadService = {
    async findIssueThread(input) { return { status: 'not_found', ...input }; },
    async readIssueThread(input) { return { status: 'not_found', ...input }; },
  };
  const token = await signToken();
  await withServer(
    (app) => registerMcpServer(app, { env: discordEnv, jwks: JWKS, logger: silentLogger(), discordReadService }),
    async (port) => {
      const list = await rpc(port, { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} }, token);
      assert.deepEqual(list.json.result.tools.map((tool) => tool.name), [...TOOL_NAMES, ...DISCORD_TOOL_NAMES]);
      const status = await rpc(port, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'botelia_status', arguments: {} } }, token);
      assert.equal(status.json.result.structuredContent.mcp.toolCount, 3);
      const find = await rpc(port, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'botelia_find_issue_thread', arguments: { repo: 'a/b', issue_number: 42 } } }, token);
      assert.equal(find.json.result.structuredContent.status, 'not_found');
    },
  );
});

test('the path-secret bootstrap is no longer accepted', async () => {
  const token = await signToken();
  await withServer(registerFull, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/anything-at-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initializeRequest()),
    });
    assert.equal(res.status, 404);
    // And the real route still works with a token.
    assert.equal((await rpc(port, initializeRequest(), token)).status, 200);
  });
});

test('a tools/call performs no outbound fetch', async (t) => {
  const realFetch = globalThis.fetch;
  const token = await signToken();
  let outbound = 0;

  await withServer(registerFull, async (port) => {
    const selfUrl = `http://127.0.0.1:${port}${MCP_ROUTE}`;
    globalThis.fetch = (input, init) => {
      if (String(input) !== selfUrl) {
        outbound += 1;
        throw new Error(`unexpected outbound fetch to ${String(input)}`);
      }
      return realFetch(input, init);
    };
    t.after(() => { globalThis.fetch = realFetch; });

    assert.equal((await rpc(port, initializeRequest(), token)).status, 200);
    const call = await rpc(port, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'botelia_status', arguments: {} },
    }, token);
    assert.equal(call.status, 200);
  });

  assert.equal(outbound, 0);
});

test('sentinel secrets, tokens and subject never appear in responses or logs', async () => {
  const sentinels = {
    DISCORD_TOKEN: 'SENTINEL_DISCORD_TOKEN',
    PUBLIC_KEY: 'SENTINEL_PUBLIC_KEY',
    APP_ID: 'SENTINEL_APP_ID',
    GUILD_ID: 'SENTINEL_GUILD_ID',
    LOG_CHANNEL_ID: 'SENTINEL_LOG_CHANNEL_ID',
    OPENROUTER_API_KEY: 'SENTINEL_OPENROUTER_KEY',
    ...FULL_ENV,
  };
  const logger = silentLogger();
  const token = await signToken();

  await withServer(
    (app) => registerMcpServer(app, { env: sentinels, jwks: JWKS, logger }),
    async (port) => {
      await rpc(port, initializeRequest(), token);
      const list = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, token);
      const call = await rpc(port, {
        jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'botelia_status', arguments: {} },
      }, token);

      const haystack = `${list.text}\n${call.text}\n${logger.lines.join('\n')}`;
      for (const value of Object.values(sentinels)) {
        if (value === '1') continue;
        assert.ok(!haystack.includes(value), `leaked ${value}`);
      }
      assert.ok(!haystack.includes(token), 'bearer token leaked');
      assert.ok(!haystack.includes(SUBJECT), 'authorized subject leaked');

      const { subsystems } = call.json.result.structuredContent;
      assert.equal(subsystems.presenceGatewayConfigured, true);
      assert.equal(subsystems.llmProvidersConfigured, 1);
    },
  );
});

test('buildStatusPayload emits only allowlisted keys', () => {
  const payload = buildStatusPayload({
    env: { DISCORD_TOKEN: 'x', OPENROUTER_API_KEY: 'y', MCP_ALLOWED_SUBJECT: SUBJECT },
    nowMs: 0,
    uptimeSeconds: 7,
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'mcp', 'nodeVersion', 'serverTimeUtc', 'service', 'status', 'subsystems', 'uptimeSeconds', 'version',
  ]);
  assert.deepEqual(Object.keys(payload.subsystems).sort(), [
    'interactionsRouteConfigured',
    'llmProvidersConfigured',
    'presenceGatewayConfigured',
  ]);
  assert.ok(!JSON.stringify(payload).includes(SUBJECT));
  assert.equal(payload.serverTimeUtc, '1970-01-01T00:00:00.000Z');
  assert.equal(payload.uptimeSeconds, 7);
  assert.equal(payload.subsystems.llmProvidersConfigured, 1);
  assert.equal(buildStatusPayload({ env: {} }).subsystems.llmProvidersConfigured, 0);
});

test('protected resource metadata helper is standards-shaped', () => {
  const md = buildProtectedResourceMetadata({ audience: AUDIENCE, issuer: ISSUER });
  assert.equal(md.resource, AUDIENCE);
  assert.deepEqual(md.authorization_servers, [ISSUER]);
  assert.deepEqual(md.scopes_supported, [MCP_SCOPE]);
});

// ─── /interactions regression ───────────────────────────────────────────────

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { rawPublicKey, privateKey };
}

function signBody(privateKey, bodyString) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign(null, Buffer.from(timestamp + bodyString), privateKey).toString('hex');
  return { timestamp, signature };
}

async function postInteraction(port, { signature, timestamp }, bodyString) {
  const res = await fetch(`http://127.0.0.1:${port}/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body: bodyString,
  });
  return { status: res.status, text: await res.text() };
}

function registerInteractions(app, rawPublicKey) {
  app.post('/interactions', verifyKeyMiddleware(rawPublicKey), (req, res) => {
    res.status(200).json({ type: req.body.type === 1 ? 1 : 5 });
  });
}

test('Ed25519 /interactions survives MCP registration and MCP traffic', async () => {
  const { rawPublicKey, privateKey } = makeKeyPair();
  const pingBody = JSON.stringify({ type: 1 });
  const token = await signToken();

  await withServer(
    (app) => {
      registerFull(app);
      registerInteractions(app, rawPublicKey);
    },
    async (port) => {
      const before = await postInteraction(port, signBody(privateKey, pingBody), pingBody);
      assert.equal(before.status, 200);
      assert.deepEqual(JSON.parse(before.text), { type: 1 });

      const forged = await postInteraction(
        port,
        { signature: 'ab'.repeat(32), timestamp: String(Math.floor(Date.now() / 1000)) },
        pingBody,
      );
      assert.equal(forged.status, 401);

      assert.equal((await rpc(port, initializeRequest(), token)).status, 200);
      assert.equal((await rpc(port, {
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'botelia_status', arguments: {} },
      }, token)).status, 200);

      const after = await postInteraction(port, signBody(privateKey, pingBody), pingBody);
      assert.equal(after.status, 200);
      assert.deepEqual(JSON.parse(after.text), { type: 1 });
    },
  );
});

test('with MCP disabled /interactions behaves exactly as before', async () => {
  const { rawPublicKey, privateKey } = makeKeyPair();
  const pingBody = JSON.stringify({ type: 1 });

  await withServer(
    (app) => {
      registerMcpServer(app, { env: { MCP_ENABLED: '0' }, logger: silentLogger() });
      registerInteractions(app, rawPublicKey);
    },
    async (port) => {
      const ok = await postInteraction(port, signBody(privateKey, pingBody), pingBody);
      assert.equal(ok.status, 200);
      const forged = await postInteraction(
        port,
        { signature: 'cd'.repeat(32), timestamp: String(Math.floor(Date.now() / 1000)) },
        pingBody,
      );
      assert.equal(forged.status, 401);
      assert.equal((await rpc(port, initializeRequest())).status, 404);
    },
  );
});

// ─── Body limits ────────────────────────────────────────────────────────────

test('oversized and malformed JSON are rejected after authentication', async () => {
  const token = await signToken();
  await withServer(registerFull, async (port) => {
    const url = `http://127.0.0.1:${port}${MCP_ROUTE}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };

    const big = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ pad: 'z'.repeat(300 * 1024) }),
    });
    assert.equal(big.status, 413);

    const bad = await fetch(url, { method: 'POST', headers, body: '{ not json' });
    assert.equal(bad.status, 400);
  });
});

test('createMcpServer can be constructed standalone with an injected payload builder', () => {
  const server = createMcpServer({ buildPayload: () => buildStatusPayload({ env: {} }) });
  assert.ok(server);
});
