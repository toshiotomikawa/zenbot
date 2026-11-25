import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  DISCORD_TOOL_NAMES,
  DISCORD_WRITE_TOOL_NAMES,
  MCP_ROUTE,
  MCP_SCOPE,
  MCP_WRITE_SCOPE,
  registerMcpServer,
  TOOL_NAMES,
} from './mcp.js';

const ISSUER = 'https://issuer.write.test/';
const AUDIENCE = 'https://resource.write.test/mcp';
const SUBJECT = 'auth0|write-test-subject';
const GUILD = '11111111111111111';
const PARENT = '22222222222222222';
const WRITE_ENV = {
  MCP_ENABLED: '1',
  MCP_AUTH_ISSUER: ISSUER,
  MCP_AUTH_AUDIENCE: AUDIENCE,
  MCP_ALLOWED_SUBJECT: SUBJECT,
  MCP_DISCORD_READ_ENABLED: '1',
  MCP_DISCORD_GUILD_IDS: GUILD,
  MCP_DISCORD_PARENT_CHANNEL_IDS: PARENT,
  MCP_DISCORD_WRITE_ENABLED: '1',
  MCP_DISCORD_WRITE_GUILD_IDS: GUILD,
  MCP_DISCORD_WRITE_PARENT_CHANNEL_IDS: PARENT,
  MCP_DISCORD_WRITE_REPOS: 'a/b',
  DISCORD_TOKEN: 'sentinel-discord-token',
};

const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = await exportJWK(keys.publicKey);
const JWKS = createLocalJWKSet({ keys: [{ ...jwk, kid: 'write-k0', alg: 'RS256', use: 'sig' }] });

async function signToken(scope) {
  return new SignJWT({ scope, azp: 'write-test-client' })
    .setProtectedHeader({ alg: 'RS256', kid: 'write-k0' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(SUBJECT)
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

async function withServer(register, fn) {
  const app = express();
  const registration = register(app);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port, registration);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function rpc(port, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function call(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function harness() {
  const invocations = [];
  const discordReadService = {
    async findIssueThread(input) { return { status: 'not_found', candidates: [], ...input }; },
    async readIssueThread(input) { return { status: 'not_found', candidates: [], ...input }; },
  };
  const discordWriteService = {
    async ensureIssueThread(input) {
      invocations.push({ name: 'ensure', input });
      return { status: 'found', created: true, repo: input.repo, issue_number: input.issue_number };
    },
    async postIssueMessage(input) {
      invocations.push({ name: 'post', input });
      return { status: 'posted', repo: input.repo, issue_number: input.issue_number, message_id: '33333333333333333' };
    },
  };
  return { invocations, discordReadService, discordWriteService };
}

test('WRITE config advertises both OAuth scopes and all five tools', async () => {
  const h = harness();
  const token = await signToken(`${MCP_SCOPE} ${MCP_WRITE_SCOPE}`);
  await withServer(
    (app) => registerMcpServer(app, {
      env: WRITE_ENV, jwks: JWKS, logger: { warn() {}, error() {} },
      discordReadService: h.discordReadService,
      discordWriteService: h.discordWriteService,
    }),
    async (port, registration) => {
      assert.equal(registration.toolCount, 5);
      const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(metadata.status, 200);
      assert.deepEqual((await metadata.json()).scopes_supported, [MCP_SCOPE, MCP_WRITE_SCOPE]);

      const list = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token);
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.json.result.tools.map((tool) => tool.name),
        [...TOOL_NAMES, ...DISCORD_TOOL_NAMES, ...DISCORD_WRITE_TOOL_NAMES],
      );
      const ensure = list.json.result.tools.find((tool) => tool.name === 'botelia_ensure_issue_thread');
      const post = list.json.result.tools.find((tool) => tool.name === 'botelia_post_issue_message');
      assert.deepEqual(ensure.annotations, {
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
      });
      assert.deepEqual(post.annotations, {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      });
    },
  );
});

test('read-only OAuth token can see WRITE tools but cannot execute them', async () => {
  const h = harness();
  const token = await signToken(MCP_SCOPE);
  await withServer(
    (app) => registerMcpServer(app, {
      env: WRITE_ENV, jwks: JWKS, logger: { warn() {}, error() {} },
      discordReadService: h.discordReadService,
      discordWriteService: h.discordWriteService,
    }),
    async (port) => {
      const result = await rpc(port, call(2, 'botelia_ensure_issue_thread', {
        repo: 'a/b', issue_number: 42, title: 'Issue 42',
      }), token);
      assert.equal(result.status, 200);
      assert.equal(result.json.result.isError, true);
      assert.deepEqual(result.json.result.structuredContent, {
        status: 'forbidden', error: 'insufficient_scope', required_scope: MCP_WRITE_SCOPE,
      });
      assert.equal(h.invocations.length, 0);
    },
  );
});

test('botelia:write alongside botelia:read unlocks only the controlled WRITE handlers', async () => {
  const h = harness();
  const token = await signToken(`${MCP_SCOPE} ${MCP_WRITE_SCOPE}`);
  await withServer(
    (app) => registerMcpServer(app, {
      env: WRITE_ENV, jwks: JWKS, logger: { warn() {}, error() {} },
      discordReadService: h.discordReadService,
      discordWriteService: h.discordWriteService,
    }),
    async (port) => {
      const ensure = await rpc(port, call(3, 'botelia_ensure_issue_thread', {
        repo: 'a/b', issue_number: 42, title: 'Issue 42',
      }), token);
      assert.equal(ensure.status, 200);
      assert.equal(ensure.json.result.structuredContent.status, 'found');

      const post = await rpc(port, call(4, 'botelia_post_issue_message', {
        repo: 'a/b', issue_number: 42, content: 'Execute the approved task.', operation_id: 'phase2-op-1',
      }), token);
      assert.equal(post.status, 200);
      assert.equal(post.json.result.structuredContent.status, 'posted');
      assert.deepEqual(h.invocations.map((item) => item.name), ['ensure', 'post']);
    },
  );
});

test('invalid WRITE config leaves the proven READ surface intact and does not advertise write scope', async () => {
  const h = harness();
  const env = { ...WRITE_ENV, MCP_DISCORD_WRITE_PARENT_CHANNEL_IDS: '99999999999999999' };
  const token = await signToken(MCP_SCOPE);
  await withServer(
    (app) => registerMcpServer(app, {
      env, jwks: JWKS, logger: { warn() {}, error() {} },
      discordReadService: h.discordReadService,
      discordWriteService: h.discordWriteService,
    }),
    async (port, registration) => {
      assert.equal(registration.toolCount, 3);
      const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
      assert.deepEqual((await metadata.json()).scopes_supported, [MCP_SCOPE]);
      const list = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, token);
      assert.deepEqual(list.json.result.tools.map((tool) => tool.name), [...TOOL_NAMES, ...DISCORD_TOOL_NAMES]);
      assert.equal(h.invocations.length, 0);
    },
  );
});
