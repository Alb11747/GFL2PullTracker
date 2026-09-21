import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileHistoryLoader } from '../src/lib/profile-history.ts';
import type { Pull } from '../src/lib/api.ts';

test('overview shares pending reads and refreshes on profile or import revision changes', async () => {
  const calls: string[] = [];
  const load = createProfileHistoryLoader(async (profileId) => {
    calls.push(profileId);
    return [{ id: 1 } as Pull];
  });
  const [a, b] = await Promise.all([load('profile', 'first'), load('profile', 'first')]);
  assert.equal(a, b);
  assert.deepEqual(calls, ['profile']);
  await load('profile', 'imported');
  await load('other-profile', 'imported');
  assert.deepEqual(calls, ['profile', 'profile', 'other-profile']);
  load.invalidate();
  await load('other-profile', 'imported');
  assert.equal(calls.length, 4);
});

test('failed overview reads can be retried without changing the archive revision', async () => {
  let failed = true;
  const load = createProfileHistoryLoader(async () => {
    if (failed) throw new Error('Unavailable');
    return [{ id: 1 } as Pull];
  });
  await assert.rejects(load('profile', 'same'), /Unavailable/);
  failed = false;
  assert.equal((await load('profile', 'same')).length, 1);
});
