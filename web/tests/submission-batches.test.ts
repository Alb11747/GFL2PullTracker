import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionBatches, type HistorySubmission } from '../src/lib/submission-batches.ts';
const input: HistorySubmission = {
  account_id: 'account',
  name: 'Export',
  expected_version: 7,
  associate: true,
  snapshots: []
};
test('large histories split into ordered requests retaining one authorization version', () => {
  const snapshots = Array.from({ length: 205 }, (_, index) => ({ records_document: { index } }));
  const batches = submissionBatches({ ...input, snapshots });
  assert.deepEqual(
    batches.map((batch) => batch.snapshots.length),
    [100, 100, 5]
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.snapshots),
    snapshots
  );
  assert.ok(batches.every((batch) => batch.expected_version === 7 && batch.associate));
});
test('batch limits count encoded UTF-8 JSON bytes including metadata and separators', () => {
  const snapshots = Array.from({ length: 8 }, () => ({
    records_document: { text: 'é'.repeat(20) }
  }));
  const limit = new TextEncoder().encode(
    JSON.stringify({ ...input, snapshots: snapshots.slice(0, 2) })
  ).length;
  const batches = submissionBatches({ ...input, snapshots }, limit);
  assert.deepEqual(
    batches.map((batch) => batch.snapshots.length),
    [2, 2, 2, 2]
  );
  assert.ok(
    batches.every((batch) => new TextEncoder().encode(JSON.stringify(batch)).length <= limit)
  );
});
test('empty history and a single oversized snapshot fail before any batch can be sent', () => {
  assert.throws(() => submissionBatches(input), /no history/);
  assert.throws(
    () =>
      submissionBatches(
        { ...input, snapshots: [{ records_document: { text: 'x'.repeat(1000) } }] },
        200
      ),
    /snapshot exceeds/
  );
});
