import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobMemory } from '../src/lib/local/job-memory.ts';

test('active jobs remain retryable when storage is blocked or unavailable', () => {
  for (const storage of [
    () => null,
    () => {
      throw new Error('SecurityError');
    }
  ]) {
    const jobs = new JobMemory(storage);
    assert.equal(jobs.get('a'), null);
    jobs.set('a', 'active-job');
    assert.equal(jobs.get('a'), 'active-job');
    assert.equal(jobs.get('b'), null);
    jobs.set('a', null);
    assert.equal(jobs.get('a'), null);
  }
});

test('failed writes and removals never replace in-memory job identity with stale storage', () => {
  const jobs = new JobMemory(() => ({
    getItem: () => 'old-job',
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    }
  }));
  assert.equal(jobs.get('a'), 'old-job');
  jobs.set('a', 'new-job');
  assert.equal(jobs.get('a'), 'new-job');
  jobs.set('a', null);
  assert.equal(jobs.get('a'), null);
});

test('reload recovery is isolated by profile and stable namespace', () => {
  const values = new Map<string, string>([['gfl2-job-a', 'prerelease-job']]);
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    }
  });
  const current = new JobMemory(storage);
  assert.equal(current.get('a'), null);
  current.set('a', 'new-job');
  current.set('b', 'other-job');
  const reloaded = new JobMemory(storage);
  assert.equal(reloaded.get('a'), 'new-job');
  assert.equal(reloaded.get('b'), 'other-job');
  reloaded.set('a', null);
  assert.equal(new JobMemory(storage).get('a'), null);
  assert.equal(values.get('gfl2-job-a'), 'prerelease-job');
});
