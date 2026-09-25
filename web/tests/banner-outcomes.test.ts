import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateBannerOutcomes,
  summarizeBannerOutcomes,
  type BannerRules
} from '../src/lib/banner-outcomes.ts';
import { createRewardQuery } from '../src/lib/reward-query.ts';
import type { Pull } from '../src/lib/api.ts';
import fixture from './banner-parity.json' with { type: 'json' };

const host = 'gf2-gacha-record-us.sunborngame.com';
const catalog: BannerRules = {
  hosts: [host],
  pools: [
    {
      type_id: 3,
      pool_id: 101,
      featured: [1039],
      kind: 'doll',
      start: '2025-01-01T00:00:00Z',
      end: '2025-02-01T00:00:00Z'
    },
    { type_id: 3, pool_id: 102, featured: [1037], kind: 'doll' },
    { type_id: 4, pool_id: 201, featured: [11039], kind: 'weapon' }
  ]
};
function pull(id: number, overrides: Partial<Pull> = {}): Pull {
  return {
    id,
    item_id: 1039,
    name: 'Synthetic',
    kind: 'doll',
    rarity: 'Elite',
    region: 'en',
    type_id: 3,
    pool_id: 101,
    timestamp: '2025-01-15T12:00:00Z',
    timestamp_order: 100 - id,
    pity: 1,
    pity_uncertain: false,
    gap_before: false,
    quantity: 1,
    source_page: 1,
    estimated_group_size: 1,
    ...overrides
  };
}
function classify(rows: Pull[], rules = catalog, provider: string | null = host) {
  annotateBannerOutcomes(rows, provider, rules);
  return rows.map((row) => row.banner_result!);
}

test('unknown initial guarantee, losses, guarantees and wins are distinct', () => {
  const rows = [pull(1), pull(2, { item_id: 1001 }), pull(3), pull(4)];
  const result = classify(rows);
  assert.deepEqual(
    result.map((r) => r.outcome),
    ['unknown', 'loss', 'guaranteed', 'win']
  );
  assert.deepEqual(
    result.map((r) => r.featured_pity),
    [null, null, 2, 1]
  );
  assert.deepEqual(
    result.map((r) => r.guarantee_after),
    [false, true, false, false]
  );
  assert.equal(
    result[0].reason,
    'unknown_start',
    'known Elite pity is not proof of initial guarantee'
  );
});

test('off-banner result proves a loss even with an unknown start', () => {
  const result = classify([pull(1, { item_id: 1001 }), pull(2)]);
  assert.equal(result[0].outcome, 'loss');
  assert.equal(result[0].guarantee_before, false);
  assert.equal(result[1].outcome, 'guaranteed');
  assert.equal(result[1].featured_pity, null, 'no invented first featured interval');
});

test('fixed loss roster classifies unmapped banners and keeps trailing guarantee state', () => {
  const rules: BannerRules = {
    ...catalog,
    fixed_loss_pools: [
      { type_id: 3, kind: 'doll', item_ids: [1025] },
      { type_id: 4, kind: 'weapon', item_ids: [11038] }
    ]
  };
  const rows = [
    pull(1, { pool_id: 999 }),
    pull(2, { pool_id: 999, item_id: 1025 }),
    pull(3, { pool_id: 888, item_id: 1, kind: 'weapon', rarity: 'Standard' }),
    pull(4, { pool_id: 888 }),
    pull(5, { pool_id: 888 }),
    pull(6, { pool_id: 888, rarity: 'Standard' })
  ];
  const results = classify(rows, rules);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['unknown', 'loss', 'not_applicable', 'guaranteed', 'win', 'not_applicable']
  );
  assert.deepEqual(
    results.map((r) => r.guarantee_after),
    [false, true, true, false, false, false]
  );
  assert.equal(results[3].featured_pity, 3);
  const weapons = classify(
    [
      pull(1, { type_id: 4, pool_id: 999, kind: 'weapon', item_id: 11038 }),
      pull(2, { type_id: 4, pool_id: 999, kind: 'weapon', item_id: 10393 })
    ],
    rules
  );
  assert.deepEqual(
    weapons.map((r) => r.outcome),
    ['loss', 'guaranteed']
  );
  assert.equal(classify([pull(1, { pool_id: 999 })], rules, null)[0].reason, 'unknown_provider');
  assert.equal(
    classify([pull(1, { pool_id: 999, kind: 'weapon' })], rules)[0].reason,
    'unknown_item'
  );
  const gap = classify(
    [
      pull(1, { pool_id: 999 }),
      pull(2, { pool_id: 999, gap_before: true }),
      pull(3, { pool_id: 999 })
    ],
    rules
  );
  assert.deepEqual(
    gap.map((r) => r.outcome),
    ['unknown', 'unknown', 'win']
  );
});

test('dated loss rosters and explicit standard rate-ups do not invent boundary outcomes', () => {
  const rules: BannerRules = {
    hosts: [host],
    pools: [
      {
        type_id: 3,
        pool_id: 101,
        featured: [1025],
        kind: 'doll',
        start: '2025-01-01T00:00:00Z',
        end: '2025-02-01T00:00:00Z'
      }
    ],
    fixed_loss_pools: [
      { type_id: 3, kind: 'doll', item_ids: [1025], end: '2026-01-01T00:00:00Z' },
      { type_id: 3, kind: 'doll', item_ids: [1025, 1043], start: '2026-01-01T00:00:00Z' }
    ]
  };
  assert.equal(classify([pull(1, { item_id: 1025 })], rules)[0].featured, true);
  assert.equal(
    classify([pull(1, { item_id: 1025, timestamp: '2025-02-01T00:00:00Z' })], rules)[0].reason,
    'unknown_pool'
  );
  assert.equal(classify([pull(1, { pool_id: 999, item_id: 1043 })], rules)[0].featured, true);
  assert.equal(
    classify(
      [pull(1, { pool_id: 999, item_id: 1043, timestamp: '2026-01-01T00:00:00Z' })],
      rules
    )[0].featured,
    false
  );
  assert.equal(
    classify([pull(1, { pool_id: 999 })], {
      ...rules,
      fixed_loss_pools: [rules.fixed_loss_pools![0], rules.fixed_loss_pools![0]]
    })[0].reason,
    'unknown_pool'
  );
});

test('coverage gaps and unknown rewards reset state until new evidence', () => {
  for (const boundary of [{ gap_before: true }, { rarity: 'Unknown' }, { pool_id: 999 }]) {
    const rows = [
      pull(1),
      pull(2, { item_id: 1001 }),
      pull(3, { rarity: 'Standard', ...boundary }),
      pull(4),
      pull(5)
    ];
    const results = classify(rows);
    assert.equal(results[3].outcome, 'unknown');
    assert.equal(results[3].featured_pity, null);
    assert.equal(results[4].outcome, 'win');
    assert.equal(results[4].featured_pity, 1);
  }
});

test('pool changes carry guarantee within a family, never between types', () => {
  const rows = [
    pull(1, { item_id: 1001 }),
    pull(2, { type_id: 4, pool_id: 201, item_id: 11039, kind: 'weapon' }),
    pull(3, { pool_id: 102, item_id: 1037 })
  ];
  const results = classify(rows);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['loss', 'unknown', 'guaranteed']
  );
});

test('unexpected off-banner after a guarantee is a conflict, not another counted loss', () => {
  const rows = [pull(1), pull(2, { item_id: 1001 }), pull(3, { item_id: 1001 }), pull(4)];
  const results = classify(rows);
  assert.equal(results[2].outcome, 'unknown');
  assert.equal(results[2].reason, 'guarantee_conflict');
  assert.equal(results[3].outcome, 'guaranteed');
  assert.equal(results[3].featured_pity, null);
});

test('unknown providers, custom pools, mismatched item kinds and reused pool dates fail closed', () => {
  assert.equal(classify([pull(1)], catalog, null)[0].reason, 'unknown_provider');
  assert.equal(classify([pull(1, { type_id: 6 })])[0].outcome, 'not_applicable');
  assert.equal(classify([pull(1, { item_id: 11039, kind: 'weapon' })])[0].reason, 'unknown_item');
  const reused = {
    ...catalog,
    pools: [
      ...catalog.pools,
      {
        ...catalog.pools[0],
        featured: [1037],
        start: '2026-01-01T00:00:00Z',
        end: '2026-02-01T00:00:00Z'
      }
    ]
  };
  assert.equal(classify([pull(1)], reused)[0].featured, true);
  assert.equal(
    classify([pull(1, { item_id: 1037, timestamp: '2026-01-15T00:00:00Z' })], reused)[0].featured,
    true
  );
  for (const timestamp of ['2024-12-31T23:59:59Z', '2025-02-01T00:00:00Z', '2026-09-01T00:00:00Z'])
    assert.equal(classify([pull(1, { timestamp })], reused)[0].reason, 'unknown_pool');
  assert.equal(
    classify([pull(1)], { ...catalog, pools: [...catalog.pools, catalog.pools[0]] })[0].reason,
    'unknown_pool'
  );
});

test('shared chronological fixture preserves equal-time ordering and full-history summary before paging', () => {
  const rows = fixture.chronological.map((row, i) => pull(i + 1, row)).reverse();
  classify(rows, fixture.rules);
  assert.deepEqual(
    [...rows].reverse().map((row) => row.banner_result),
    fixture.expected
  );
  const before = structuredClone(rows);
  const query = createRewardQuery(rows);
  for (const rarities of [['Elite'], ['Standard'], []]) {
    const result = query(3, rarities, 1, 1);
    assert.deepEqual(result.featured, fixture.summary);
  }
  assert.deepEqual(rows, before);
  assert.deepEqual(summarizeBannerOutcomes([]), {
    featured_count: 0,
    off_banner_count: 0,
    wins: 0,
    losses: 0,
    guaranteed: 0,
    unknown_elites: 0,
    unknown_outcomes: 0,
    featured_intervals: [],
    current_guarantee: null
  });
});

test('real local engine retains source duplicates and exposes derived outcomes without altering archives', async () => {
  const { LocalEngine } = await import('../src/lib/local/engine.ts');
  const { default: mapped } = await import('../../backend/banner_rules.json', {
    with: { type: 'json' }
  });
  const rule = mapped.pools.find((r) => r.type_id === 3 && r.featured[0] === 1039)!;
  const engine = new LocalEngine();
  const profile = engine.createProfile('Synthetic');
  const time = Math.floor(Date.parse(rule.start) / 1000) + 86400;
  const records = [1039, 1013, 1001, 1039].map((item) => ({
    source_type_id: 3,
    source_page: 1,
    record: { item, pool_id: rule.pool_id, item_num: 1, time }
  }));
  await engine.importRecords({
    profile_id: profile.id,
    records_document: {
      schema_version: 1,
      exported_at: new Date(time * 1000).toISOString(),
      endpoint_host: host,
      account_fingerprint: 'sha256:' + 'a'.repeat(64),
      records
    }
  });
  const archive = engine.exportState();
  const all = engine.overview(profile.id);
  assert.equal(all.length, 4);
  assert.equal(all[0].banner_result?.outcome, 'guaranteed');
  assert.equal(all[0].banner_result?.featured_pity, 3);
  const summary = engine.rewards(profile.id, 3, ['Elite'], 0, 1).featured;
  assert.equal(summary?.guaranteed, 1);
  assert.deepEqual(engine.rewards(profile.id, 3, ['Standard'], 0, 1).featured, summary);
  assert.deepEqual(engine.exportState(), archive);
  assert.deepEqual(new LocalEngine(archive).overview(profile.id), all);
});

test('production fixed-loss rules preserve browser/server parity and a continuous summary window', async () => {
  const { default: sample } = await import('./fixed-loss-parity.json', { with: { type: 'json' } });
  const { analyzeHistory } = await import('../src/lib/statistics/history.ts');
  const rows = sample.chronological
    .map((row, i) =>
      pull(i + 1, {
        ...row,
        rarity: row.rarity as Pull['rarity'],
        pool_id: 999999,
        timestamp: '2026-09-01T00:00:00Z'
      })
    )
    .reverse();
  annotateBannerOutcomes(rows, host);
  const results = [...rows].reverse().map((row) => row.banner_result!);
  assert.deepEqual(
    results.map((row) => row.outcome),
    sample.outcomes
  );
  assert.deepEqual(
    results.map((row) => row.guarantee_after),
    sample.guarantee_after
  );
  assert.deepEqual(
    results.map((row) => row.featured_pity),
    sample.featured_pity
  );
  const summary = analyzeHistory(rows);
  assert.equal(summary.windows.featured?.budget, 5);
  assert.equal(summary.windows.featured?.count, 2);
  assert.equal(summary.unknownFeaturedCount, 0);
});
