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

test('rewards copy reactive rarity selections and worker errors retain content rejection identity', async () => {
  const original = globalThis.Worker;
  let worker: TestWorker;
  const requests: { method: string; args: unknown[] }[] = [];
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      worker = this;
    }
    postMessage(message: { id: number; method: string; args: unknown[] }) {
      const copied = structuredClone(message);
      requests.push(copied);
      queueMicrotask(() =>
        this.onmessage?.({
          data:
            copied.method === 'decodeBackup'
              ? {
                  id: copied.id,
                  error: 'Unsupported backup format.',
                  errorName: 'InvalidBackupError'
                }
              : { id: copied.id, result: copied.method === 'revision' ? 12 : {} }
        })
      );
    }
    terminate() {}
  }
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const client = createLocalClient();
  try {
    const revisions: number[] = [];
    client.subscribe((revision) => revisions.push(revision));
    await client.rewards('profile', 3, new Proxy(['Elite', 'Standard'], {}), 20, 20);
    assert.deepEqual(requests[0], {
      id: 1,
      method: 'rewards',
      args: ['profile', 3, ['Elite', 'Standard'], 20, 20]
    });
    assert.equal(await client.revision(), 12);
    worker!.onmessage?.({ data: { changed: true, revision: 13 } });
    assert.deepEqual(revisions, [13]);
    await assert.rejects(() => client.decodeBackup(new Uint8Array([1])), {
      name: 'InvalidBackupError'
    });
  } finally {
    client.close();
    globalThis.Worker = original;
  }
});
