import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProbabilityClient } from '../src/lib/statistics/probability-client.ts';
import { handleProbabilityRequest } from '../src/lib/statistics/probability.worker.ts';
import { MODELS } from '../src/lib/statistics/probability-types.ts';
import type {
  ProbabilityRequest,
  ProbabilityWorkerRequest,
  ProbabilityWorkerResponse
} from '../src/lib/statistics/probability-types.ts';

class TestWorker {
  onmessage?: (event: { data: ProbabilityWorkerResponse }) => void;
  onerror?: (event: { preventDefault(): void }) => void;
  onmessageerror?: () => void;
  requests: ProbabilityWorkerRequest[] = [];
  terminated = false;
  postMessage(request: ProbabilityWorkerRequest): void {
    this.requests.push(structuredClone(request));
  }
  terminate(): void {
    this.terminated = true;
  }
  complete(): void {
    handleProbabilityRequest(this.requests.at(-1)!, (response) =>
      this.onmessage?.({ data: response })
    );
  }
}

const plannerRequest: ProbabilityRequest = { method: 'planner', p: MODELS.dolls, budget: 85 };

test('worker transport returns typed arrays and transfers every metric buffer', () => {
  const requests: ProbabilityRequest[] = [
    plannerRequest,
    { method: 'summary', p: MODELS.dolls, windows: { elite: { budget: 30, count: 1 } } },
    { method: 'acquisition', p: MODELS.dolls, intervals: [20], wins: { wins: 1, trials: 2 } }
  ];
  for (const request of requests) {
    let called = false;
    handleProbabilityRequest({ ...request, id: 42 }, (message, transfer) => {
      called = true;
      assert.equal(message.id, 42);
      assert.equal(message.error, undefined);
      assert.ok(message.result);
      assert.ok(message.result.elite.dist instanceof Float64Array);
      assert.ok(message.result.elite.dist.length);
      assert.equal(transfer.length, request.method === 'planner' ? 2 : 3);
      assert.equal(transfer[0], message.result.elite.dist.buffer);
    });
    assert.equal(called, true);
  }
  handleProbabilityRequest(
    { method: 'unknown', id: 99 } as unknown as ProbabilityWorkerRequest,
    (message, transfer) => {
      assert.equal(message.error?.code, 'INVALID_INPUT');
      assert.deepEqual(transfer, []);
    }
  );
});

test('superseded and disposed calculations terminate, reject and ignore stale messages', async () => {
  const workers: TestWorker[] = [];
  const client = createProbabilityClient(() => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  assert.equal(workers.length, 0);
  const first = client.run(plannerRequest);
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const next = client.run({ ...plannerRequest, budget: 10 });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  workers[0].complete();
  workers[0].onerror?.({ preventDefault() {} });
  assert.equal(workers[1].terminated, false);
  workers[1].complete();
  assert.equal((await next).elite.budget, 10);
  await firstRejected;
  const final = client.run(plannerRequest);
  assert.equal(workers.length, 2, 'idle workers are reused');
  const finalRejected = assert.rejects(final, { name: 'AbortError' });
  client.dispose();
  await finalRejected;
  assert.equal(workers[1].terminated, true);
  await assert.rejects(client.run(plannerRequest), { name: 'AbortError' });
});

test('worker startup, decode and runtime failures are recoverable without logging payloads', async () => {
  let failStartup = true;
  let current: TestWorker;
  const client = createProbabilityClient(() => {
    if (failStartup) throw new Error('private browser details');
    current = new TestWorker();
    return current as unknown as Worker;
  });
  await assert.rejects(client.run(plannerRequest), {
    message: 'The probability worker could not start. Please try again.'
  });
  failStartup = false;
  const decoded = client.run(plannerRequest);
  const decodedRejected = assert.rejects(decoded, /could not be read/);
  current!.onmessageerror?.();
  await decodedRejected;
  const runtime = client.run(plannerRequest);
  const runtimeRejected = assert.rejects(runtime, /calculation stopped/);
  current!.onerror?.({ preventDefault() {} });
  await runtimeRejected;
  const recovered = client.run(plannerRequest);
  current!.complete();
  assert.equal((await recovered).elite.missing, false);
  client.dispose();
});
