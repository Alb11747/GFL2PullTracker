import test from 'node:test';
import assert from 'node:assert/strict';
import { eliteSummary } from '../src/lib/elite-summary.ts';
import type { Pull } from '../src/lib/api.ts';

const pull = (overrides: Partial<Pull>): Pull => ({
  id: 1,
  item_id: 1039,
  name: 'Suomi',
  kind: 'doll',
  rarity: 'Elite',
  region: 'en',
  type_id: 3,
  pool_id: 1,
  timestamp: '2026-09-20T12:00:00Z',
  timestamp_order: 0,
  pity: 12,
  pity_uncertain: false,
  gap_before: false,
  quantity: 1,
  source_page: 1,
  estimated_group_size: 1,
  ...overrides
});

test('same-time recorded order determines current pity, and an Elite resets uncertainty', () => {
  const rows = [
    pull({ id: 2, timestamp_order: 1, rarity: 'Retired', pity: 11, pity_uncertain: true }),
    pull({ pity_uncertain: true })
  ];
  const result = eliteSummary(rows, 3);
  assert.equal(result.currentPity, 0);
  assert.equal(result.currentUncertain, false);
  assert.deepEqual(
    result.scoped.map((row) => row.id),
    [1, 2]
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [2, 1]
  );
});

test('average excludes uncertain Elite intervals and other recruitment types', () => {
  const result = eliteSummary(
    [
      pull({ pity: 2 }),
      pull({ id: 2, timestamp_order: 1, pity: 12, pity_uncertain: true }),
      pull({ id: 3, timestamp_order: 2, pity: 4 }),
      pull({ id: 4, type_id: 4, pity: 80 })
    ],
    3
  );
  assert.equal(result.average, '3.0');
  assert.equal(result.elites.length, 3);
});

test('ongoing pity preserves missing-history uncertainty and empty history has no average', () => {
  const current = eliteSummary([pull({ rarity: 'Standard', pity: 9, pity_uncertain: true })], 3);
  assert.equal(current.currentPity, 9);
  assert.equal(current.currentUncertain, true);
  assert.deepEqual(eliteSummary([], null), {
    scoped: [],
    elites: [],
    currentPity: 0,
    currentUncertain: false,
    average: '—'
  });
});
