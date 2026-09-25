import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, PublicApiError } from '../src/lib/public-api.ts';
test('unified fetch and manual submission send the history contract once', async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createPublicClient(async (path, init) => {
    if (init?.method === 'DELETE')
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    requests.push({
      path: String(path),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    return Response.json(
      String(path).endsWith('/config')
        ? { csrf_token: 'synthetic' }
        : { account_id: 'account', name: 'Export', snapshot_count: 1, record_count: 1 }
    );
  });
  await client.config();
  await client.fetchCapture({ capture: 'synthetic', submit_history: true });
  await client.submitHistory({
    account_id: 'account',
    name: 'Export',
    snapshots: [],
    expected_version: 7,
    associate: true
  });
  await client.deleteBackup('account');
  assert.deepEqual(requests.slice(1), [
    {
      path: '/api/public/fetch',
      method: 'POST',
      body: { capture: 'synthetic', submit_history: true }
    },
    {
      path: '/api/public/backup',
      method: 'PUT',
      body: {
        account_id: 'account',
        name: 'Export',
        snapshots: [],
        expected_version: 7,
        associate: true
      }
    },
    { path: '/api/public/backup?account_id=account', method: 'DELETE', body: null }
  ]);
  assert.equal('setContribution' in client, false);
  assert.equal('deleteContribution' in client, false);
});
test('manual submission never retries a lost response or stale deletion version', async () => {
  for (const stale of [false, true]) {
    let mutations = 0;
    const client = createPublicClient(async (path) => {
      if (String(path).endsWith('/config')) return Response.json({ csrf_token: 'synthetic' });
      mutations++;
      if (stale) return Response.json({}, { status: 409 });
      throw new TypeError('Lost response');
    });
    await client.config();
    await assert.rejects(
      client.submitHistory({
        account_id: 'account',
        name: 'Export',
        snapshots: [],
        expected_version: 7
      }),
      (error: unknown) =>
        error instanceof PublicApiError && (stale ? error.status === 409 : error.uncertain)
    );
    assert.equal(mutations, 1);
  }
});

test('comparison is a cancellable read without CSRF initialization or raw records', async () => {
  const abort = new AbortController();
  const input = {
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    server: 'global',
    game_channel_id: '1',
    type_id: 3,
    rules_version: 'test',
    elite: { budget: 85, count: 2, startingPity: 0, guaranteed: false },
    featured: null,
    wins: null
  };
  let calls = 0;
  const client = createPublicClient(async (path, init) => {
    calls++;
    assert.equal(path, '/api/public/statistics/compare');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.signal, abort.signal);
    assert.equal(new Headers(init?.headers).has('X-CSRF-Token'), false);
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return Response.json({ rules_version: 'test', self_excluded: false, metrics: {} });
  });
  await client.compareStatistics(input, abort.signal);
  assert.equal(calls, 1);
});

test('cancelled comparisons propagate cancellation and do not become uncertain mutations', async () => {
  const abort = new AbortController();
  const cancelled = new DOMException('Obsolete', 'AbortError');
  const client = createPublicClient(async () => {
    abort.abort();
    throw cancelled;
  });
  await assert.rejects(
    client.compareStatistics(
      {
        endpoint_host: 'test',
        server: 'global',
        game_channel_id: '1',
        type_id: 3,
        rules_version: 'test',
        elite: null,
        featured: null,
        wins: null
      },
      abort.signal
    ),
    (error) => error === cancelled
  );
});
