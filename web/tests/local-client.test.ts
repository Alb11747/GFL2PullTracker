import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalClient } from '../src/lib/local/client.ts';
import type { Filters } from '../src/lib/api.ts';

test('worker filter requests copy nested reactive selections before structured cloning', async () => {
  const original = globalThis.Worker;
  const received: { method: string; args: Filters[] }[] = [];
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { id: number; method: string; args: Filters[] }) {
      const copied = structuredClone(message);
      received.push(copied);
      queueMicrotask(() => this.onmessage?.({ data: { id: copied.id, result: {} } }));
    }
    terminate() {}
  }
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const client = createLocalClient();
  try {
    const filters = new Proxy<Filters>(
      {
        profile_id: 'profile',
        q: '',
        rarity: new Proxy(['Elite', 'Standard'], {}),
        kind: new Proxy([], {}),
        type_id: new Proxy(['3', '6'], {}),
        pool_id: '',
        date_from: '',
        date_to: '',
        page: 1,
        page_size: 20
      },
      {}
    );
    await client.history(filters);
    await client.statistics(filters);
    assert.deepEqual(
      received.map((request) => request.method),
      ['history', 'statistics']
    );
    for (const request of received) {
      assert.deepEqual(request.args[0].rarity, ['Elite', 'Standard']);
      assert.deepEqual(request.args[0].kind, []);
      assert.deepEqual(request.args[0].type_id, ['3', '6']);
      assert.equal(request.args[0].pool_id, '');
    }
  } finally {
    client.close();
    globalThis.Worker = original;
  }
});
