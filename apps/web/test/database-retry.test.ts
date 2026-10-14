import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDatabaseConflict } from '../src/lib/database-retry';

for (const code of ['40P01', '40001']) {
  test(`retries an aborted idempotent operation for ${code}`, async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryDatabaseConflict(async () => {
      if (++calls < 3) throw Object.assign(new Error('aborted'), { code });
      return 'saved';
    }, async (ms) => { delays.push(ms); });
    assert.equal(result, 'saved');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [50, 100]);
  });
}

test('stops after three conflicts and preserves the original failure', async () => {
  const failure = Object.assign(new Error('aborted'), { code: '40P01' });
  let calls = 0;
  await assert.rejects(retryDatabaseConflict(async () => { calls++; throw failure; }, async () => {}), (error) => error === failure);
  assert.equal(calls, 3);
});

test('does not retry connection, validation, or unknown failures', async () => {
  for (const code of ['23503', '08006', undefined]) {
    let calls = 0;
    const failure = Object.assign(new Error('failed'), { code });
    await assert.rejects(retryDatabaseConflict(async () => { calls++; throw failure; }, async () => {}), (error) => error === failure);
    assert.equal(calls, 1);
  }
});
