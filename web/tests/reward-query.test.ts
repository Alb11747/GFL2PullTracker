import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pull } from '../src/lib/api.ts';
import { createRewardQuery } from '../src/lib/reward-query.ts';
import { eliteSummary } from '../src/lib/elite-summary.ts';

function pull(id: number, options: Partial<Pull> = {}): Pull {
  return {
    id,
    item_id: id,
    name: `Reward ${id}`,
    kind: 'doll',
    rarity: 'Standard',
    region: null,
    type_id: 3,
    pool_id: 224001,
    timestamp: '2026-07-26T10:00:00Z',
    timestamp_order: id,
    pity: id,
    pity_uncertain: false,
    gap_before: false,
    quantity: 1,
    source_page: 1,
    estimated_group_size: 1,
    ...options
  };
}

test('bounded rewards preserve complete recruitment summary and recorded order across all rarity selections', () => {
  const rows = [
    pull(4, { rarity: 'Elite', pity: 70 }),
    pull(2, { rarity: 'Elite', pity: 40, pity_uncertain: true }),
    pull(1, { pity: 3, pity_uncertain: true }),
    pull(3, { rarity: 'Unmapped' }),
    pull(5, { rarity: 'Retired' }),
    pull(6, { type_id: 6, rarity: 'Elite', pity: 2 })
  ];
  const original = structuredClone(rows);
  const query = createRewardQuery(rows);
  const expected = eliteSummary(rows, 3);
  for (let mask = 0; mask < 16; mask++) {
    const rarities = ['Elite', 'Standard', 'Retired', 'Unknown'].filter(
      (_, index) => mask & (1 << index)
    );
    const result = query(3, rarities, 1, 2);
    const matching = expected.scoped.filter((row) =>
      rarities.includes(
        ['Elite', 'Standard', 'Retired'].includes(row.rarity) ? row.rarity : 'Unknown'
      )
    );
    assert.deepEqual(result.items, matching.slice(1, 3));
    assert.equal(result.total, matching.length);
    assert.equal(result.currentPity, expected.currentPity);
    assert.equal(result.currentUncertain, expected.currentUncertain);
    assert.equal(result.average?.toFixed(1), expected.average);
    assert.deepEqual(result.lastElite, expected.elites[0]);
    assert.equal(
      result.breakdown.reduce((sum, entry) => sum + entry.count, 0),
      5
    );
    assert.deepEqual(result.availableRarities, ['Elite', 'Standard', 'Retired', 'Unknown']);
  }
  assert.deepEqual(rows, original, 'query construction never reorders the source');
});

test('recruitment fallback, missing rarity choices, and empty histories have explicit summaries', () => {
  const query = createRewardQuery([pull(1, { type_id: 6 }), pull(2, { rarity: 'Elite' })]);
  assert.deepEqual(query(null, ['Elite'], 0, 20).types, [3, 6]);
  assert.equal(query(999, ['Elite'], 0, 20).selectedType, 3);
  const none = query(6, [], 0, 20);
  assert.equal(none.total, 0);
  assert.equal(none.currentPity, 1);
  assert.equal(none.lastElite, null);
  assert.deepEqual(none.availableRarities, ['Elite', 'Standard', 'Retired']);
  assert.deepEqual(query(6, ['Unknown'], 0, 20).availableRarities, [
    'Elite',
    'Standard',
    'Retired',
    'Unknown'
  ]);
  assert.equal(createRewardQuery([pull(1, { type_id: 6 })])(null, [], 0, 20).selectedType, 6);
  const empty = createRewardQuery([])(null, ['Elite'], 0, 20);
  assert.equal(empty.selectedType, null);
  assert.equal(empty.currentPity, 0);
  assert.equal(empty.currentUncertain, false);
  assert.equal(empty.average, null);
  assert.equal(empty.lastElite, null);
  assert.deepEqual(empty.items, []);
});

test('reward pages are bounded independently of the total history size', () => {
  const query = createRewardQuery(Array.from({ length: 1000 }, (_, index) => pull(index)));
  const first = query(3, ['Standard'], -1, 10000);
  assert.equal(first.total, 1000);
  assert.equal(first.items.length, 500);
  assert.deepEqual(
    query(3, ['Standard'], 999, 20).items.map((row) => row.id),
    [999]
  );
  assert.equal(query(3, ['Standard'], 1000, 20).items.length, 0);
});

test('warm previews reuse totals and stop inspecting history after their selected window', () => {
  let inspected = 0;
  const rows = Array.from({ length: 30000 }, (_, index) => {
    const row = pull(index, { rarity: index % 10 === 0 ? 'Elite' : 'Standard' });
    const rarity = row.rarity;
    Object.defineProperty(row, 'rarity', {
      enumerable: true,
      get() {
        inspected++;
        return rarity;
      }
    });
    return row;
  });
  const query = createRewardQuery(rows);
  inspected = 0;
  assert.deepEqual(query(3, [], 0, 20).items, []);
  assert.equal(inspected, 0, 'An empty selection need not inspect any history');
  assert.deepEqual(
    query(3, ['Elite', 'Standard'], 29998, 20).items.map((row) => row.id),
    [29998, 29999]
  );
  assert.equal(inspected, 0, 'An all-rarity page need not refilter history');
  const preview = query(3, ['Elite'], 3, 10);
  assert.equal(preview.total, 3000);
  assert.deepEqual(
    preview.items.map((row) => row.id),
    [30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
  );
  assert(inspected <= 121, 'A warm preview scanned beyond its requested window');
  inspected = 0;
  assert.deepEqual(query(3, ['Elite'], 3000, 10).items, []);
  assert.equal(inspected, 0, 'A page beyond the cached total need not inspect history');
});
