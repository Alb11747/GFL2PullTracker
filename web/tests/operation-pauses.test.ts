import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationPauses } from '../src/lib/local/operation-pauses.ts';

test('overlapping preflight and job reads share a pending pause and release exactly once', async () => {
  const pauses = createOperationPauses();
  let resolve!: (release: () => void) => void;
  const pending = new Promise<() => void>((done) => {
    resolve = done;
  });
  let claims = 0,
    releases = 0;
  const claim = () => {
    claims++;
    return pending;
  };
  const first = pauses.acquire(1, claim);
  const second = pauses.acquire(1, claim);
  assert.equal(claims, 1);
  assert.equal(first, second);
  resolve(() => {
    releases++;
  });
  await Promise.all([first, second]);
  pauses.release(1);
  pauses.release(1);
  assert.equal(releases, 1);
});

test('cancelling before acquisition settles releases the eventual lease without touching a newer operation', async () => {
  const pauses = createOperationPauses();
  let resolve!: (release: () => void) => void;
  let releases = 0,
    nextReleases = 0;
  const first = pauses.acquire(
    1,
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  pauses.release(1);
  await pauses.acquire(2, async () => () => {
    nextReleases++;
  });
  resolve(() => {
    releases++;
  });
  await first;
  assert.equal(releases, 1);
  assert.equal(nextReleases, 0);
  pauses.releaseAll();
  pauses.releaseAll();
  assert.equal(releases, 1);
  assert.equal(nextReleases, 1);
});

test('failed acquisition clears its pending entry so a retry can claim a new lease', async () => {
  const pauses = createOperationPauses();
  await assert.rejects(
    pauses.acquire(1, async () => {
      throw new Error('Sync interrupted');
    }),
    /interrupted/
  );
  let releases = 0;
  await pauses.acquire(1, async () => () => {
    releases++;
  });
  pauses.release(1);
  assert.equal(releases, 1);
});
