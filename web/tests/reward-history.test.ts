import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRewards, readRewardRarities } from '../src/lib/reward-history.ts';
import { eliteSummary } from '../src/lib/elite-summary.ts';
import type { Pull } from '../src/lib/api.ts';

const rows: Pull[] = ['Elite', 'Standard', 'Retired', 'Unresolved'].map((rarity, index) => ({
  id: index + 1,
  item_id: index + 1000,
  name: rarity,
  rarity,
  kind: 'weapon',
  region: 'en',
  type_id: 3,
  pool_id: 1,
  timestamp: '2026-09-20T12:00:00Z',
  timestamp_order: index,
  pity: 10 - index,
  pity_uncertain: index > 0,
  gap_before: index === 2,
  quantity: 1,
  source_page: 1,
  estimated_group_size: 1
}));

test('device preference validates values, preserves none, and normalizes combinations', () => {
  for (const value of [null, '', 'broken', '{}', 'null', '"Elite"', '["5"]', '["Elite",null]']) {
    assert.deepEqual(readRewardRarities(value), ['Elite']);
  }
  assert.deepEqual(readRewardRarities('[]'), []);
  assert.deepEqual(readRewardRarities('["Retired","Elite","Retired"]'), ['Elite', 'Retired']);
  assert.deepEqual(readRewardRarities('["Standard","Unknown"]'), ['Standard', 'Unknown']);
});

test('single, mixed, all and empty display selections retain original rows and recorded order', () => {
  const scoped = eliteSummary([...rows].reverse(), 3).scoped;
  assert.deepEqual(
    filterRewards(scoped, ['Elite']).map((row) => row.id),
    [1]
  );
  assert.deepEqual(
    filterRewards(scoped, ['Standard']).map((row) => row.id),
    [2]
  );
  assert.deepEqual(
    filterRewards(scoped, ['Retired']).map((row) => row.id),
    [3]
  );
  assert.deepEqual(
    filterRewards(scoped, ['Retired', 'Elite']).map((row) => row.id),
    [1, 3]
  );
  assert.deepEqual(filterRewards(scoped, ['Elite', 'Standard', 'Retired', 'Unknown']), rows);
  assert.deepEqual(filterRewards(scoped, []), []);
  assert.deepEqual(filterRewards([], ['Elite']), []);
  assert.strictEqual(filterRewards(scoped, ['Retired'])[0], rows[2]);
  assert.equal(filterRewards(scoped, ['Retired'])[0].pity_uncertain, true);
  assert.equal(filterRewards(scoped, ['Retired'])[0].gap_before, true);
});

test('display filtering cannot alter recruitment summary or pity intervals', () => {
  const before = structuredClone(rows);
  const summary = eliteSummary(rows, 3);
  filterRewards(summary.scoped, ['Standard', 'Retired']);
  assert.deepEqual(rows, before);
  assert.deepEqual(eliteSummary(rows, 3), summary);
  assert.equal(summary.currentPity, 0);
  assert.equal(summary.average, '10.0');
  assert.equal(summary.scoped.length, 4);
});
