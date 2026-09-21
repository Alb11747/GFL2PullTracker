import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackupCodec } from '../src/lib/local/codec.ts';

type Request = { id: number; method: string; input: unknown };
class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void }) => void;
  onmessageerror?: () => void;
  requests: Request[] = [];
  terminated = false;
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(request: Request) {
    this.requests.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
}

test('backup codec starts lazily, snapshots inputs, and preserves rejection identity', async () => {
  const original = globalThis.Worker;
  TestWorker.instances = [];
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const codec = createBackupCodec();
  try {
    assert.equal(TestWorker.instances.length, 0);
    const input = { profiles: [{ name: 'Snapshot' }] };
    const encoded = codec.call<Uint8Array>('encodeBackup', input);
    input.profiles[0].name = 'Changed';
    const worker = TestWorker.instances[0];
    assert.deepEqual(worker.requests[0].input, { profiles: [{ name: 'Snapshot' }] });
    worker.onmessage!({ data: { id: worker.requests[0].id, result: new Uint8Array([1, 2]) } });
    assert.deepEqual(await encoded, new Uint8Array([1, 2]));
    for (const name of ['InvalidBackupError', 'UnsupportedArchiveVersionError']) {
      const rejected = assert.rejects(codec.call('decodeBackup', new Uint8Array([3])), { name });
      worker.onmessage!({
        data: { id: worker.requests.at(-1)!.id, error: 'Rejected archive', errorName: name }
      });
      await rejected;
    }
    assert.equal(TestWorker.instances.length, 1);
  } finally {
    codec.close();
    globalThis.Worker = original;
  }
});

test('codec crashes, unreadable replies, and closure reject every pending request and permit retry', async () => {
  const original = globalThis.Worker;
  TestWorker.instances = [];
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const codec = createBackupCodec();
  try {
    const pending = [codec.call('encodeBackup', {}), codec.call('validateState', {})];
    const rejected = Promise.all(
      pending.map((request) => assert.rejects(request, /worker stopped/))
    );
    TestWorker.instances[0].onerror!({ preventDefault() {} });
    await rejected;
    assert(TestWorker.instances[0].terminated);
    const retried = codec.call('decodeBackup', new Uint8Array([1]));
    const second = TestWorker.instances[1];
    second.onmessage!({ data: { id: second.requests[0].id, result: { version: 1 } } });
    assert.deepEqual(await retried, { version: 1 });
    const unreadable = assert.rejects(codec.call('encodeBackup', {}), /unreadable/);
    second.onmessageerror!();
    await unreadable;
    assert(second.terminated);
    const closed = assert.rejects(codec.call('validateState', {}), /processing stopped/);
    codec.close();
    await closed;
    assert(TestWorker.instances[2].terminated);
  } finally {
    codec.close();
    globalThis.Worker = original;
  }
});

test('codec startup and structured-clone failures reject without leaving a pending operation', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new Error('Worker unavailable');
    }
  } as unknown as typeof Worker;
  const codec = createBackupCodec();
  try {
    await assert.rejects(codec.call('validateState', {}), /Worker unavailable/);
    TestWorker.instances = [];
    globalThis.Worker = TestWorker as unknown as typeof Worker;
    await assert.rejects(
      codec.call('validateState', () => undefined),
      { name: 'DataCloneError' }
    );
    const valid = codec.call('validateState', { version: 1 });
    const worker = TestWorker.instances[0];
    worker.onmessage!({ data: { id: worker.requests[0].id, result: { version: 1 } } });
    assert.deepEqual(await valid, { version: 1 });
  } finally {
    codec.close();
    globalThis.Worker = original;
  }
});
