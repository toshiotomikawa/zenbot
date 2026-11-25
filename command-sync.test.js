import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COMMANDS } from './command-definitions.js';
import { syncCommandsOnBoot } from './command-sync.js';

const credentials = { APP_ID: '123', DISCORD_TOKEN: 'offline-fixture' };
function harness(env = credentials, response = { ok: true, status: 200 }) {
  const calls = [], logs = [];
  return {
    calls, logs,
    options: {
      env,
      fetchImpl: async (...args) => { calls.push(args); return response; },
      logger: { info: meta => logs.push(meta), error: meta => logs.push(meta) },
    },
  };
}

for (const guild of [true, false]) {
  test(`success ${guild ? 'guild' : 'global'}: one overwrite with ALL_COMMANDS`, async () => {
    const h = harness({ ...credentials, ...(guild ? { GUILD_ID: '456' } : {}) });
    assert.equal(await syncCommandsOnBoot(h.options), true);
    assert.equal(h.calls.length, 1);
    const [url, options] = h.calls[0];
    assert.equal(url, 'https://discord.com/api/v10/applications/123/' + (guild ? 'guilds/456/' : '') + 'commands');
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers.Authorization, 'Bot offline-fixture');
    assert.deepEqual(JSON.parse(options.body), ALL_COMMANDS);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(h.logs[0].outcome, 'success');
    assert.equal(ALL_COMMANDS.some(command => command.name === 'competitivo'), false);
  });
}

test('HTTP failure is contained and response body is never read', async () => {
  let cancelled = false;
  const h = harness(credentials, { ok: false, status: 401,
    body: { cancel: async () => { cancelled = true; } },
    json: () => { throw new Error('must not read response'); },
    text: () => { throw new Error('must not read response'); },
  });
  assert.equal(await syncCommandsOnBoot(h.options), false);
  assert.equal(h.calls.length, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(h.logs, [{ subsystem: 'command_sync', event: 'boot', action: 'global', status: 401, outcome: 'failure', error_code: 'http_error' }]);
});

test('network failure never throws or logs exception details and never retries', async () => {
  const h = harness();
  let attempts = 0;
  h.options.fetchImpl = async () => { attempts++; throw new Error('offline-fixture sensitive body'); };
  assert.equal(await syncCommandsOnBoot(h.options), false);
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(h.logs).includes('offline-fixture'), false);
  assert.equal(h.logs[0].error_code, 'request_failed');
});

test('COMMAND_SYNC_ON_BOOT=0 skips fetch and logging', async () => {
  const h = harness({ ...credentials, COMMAND_SYNC_ON_BOOT: '0' });
  assert.equal(await syncCommandsOnBoot(h.options), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.length, 0);
});

test('missing runtime credentials fails without fetching', async () => {
  const h = harness({ APP_ID: '123' });
  assert.equal(await syncCommandsOnBoot(h.options), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs[0].error_code, 'missing_configuration');
});

test('audit failure cannot reject startup synchronization', async () => {
  const h = harness(credentials, { ok: false, status: 500 });
  h.options.logger.error = () => { throw new Error('logger failure'); };
  assert.equal(await syncCommandsOnBoot(h.options), false);
});
