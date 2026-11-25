import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimeoutSignal } from './discord-feed-utils.js';

test('createTimeoutSignal eventually aborts', async () => {
  const signal = createTimeoutSignal(30);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  assert.equal(signal.aborted, true);
});
