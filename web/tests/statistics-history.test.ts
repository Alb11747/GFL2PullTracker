import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './statistics-windows.json' with { type: 'json' };
import {
  analyzeHistory,
  STATISTICS_RULES_VERSION,
  type HistoryRow
} from '../src/lib/statistics/history.ts';
import { LocalEngine, engineDiagnostics } from '../src/lib/local/engine.ts';
import type { BannerResult } from '../src/lib/banner-outcomes.ts';
import type { ComparisonWindow } from '../src/lib/statistics/history-types.ts';

const shape = (window: ComparisonWindow | null) =>
  window && {
    budget: window.budget,
    count: window.count,
    startingPity: window.startingPity,
    guaranteed: window.guaranteed
  };
const fixtureRows = (index: number): HistoryRow[] =>
  structuredClone(fixtures.cases[index].rows) as HistoryRow[];

for (const fixture of fixtures.cases)
  test(`window parity: ${fixture.name}`, () => {
    const result = analyzeHistory(fixture.rows as HistoryRow[]);
    assert.equal(result.total, fixture.rows.length);
    assert.deepEqual(
      { elite: shape(result.windows.elite), featured: shape(result.windows.featured) },
      fixture.expected.windows
    );
    for (const key of [
      'currentPity',
      'currentGuarantee',
      'intervals',
      'featuredIntervals',
      'wins',
      'excludedCount',
      'featuredCount',
      'unknownFeaturedCount'
    ] as const)
      assert.deepEqual(result[key], fixture.expected[key], key);
  });

test('explicit known start includes reward cost and trailing pulls for both windows', () => {
  const result = analyzeHistory(fixtureRows(0), { startingPity: 0, guaranteed: false });
  assert.deepEqual(shape(result.windows.elite), {
    budget: 14,
    count: 3,
    startingPity: 0,
    guaranteed: false
  });
  assert.deepEqual(shape(result.windows.featured), {
    budget: 14,
    count: 2,
    startingPity: 0,
    guaranteed: false
  });
  assert.deepEqual(result.intervals, [2, 3, 4]);
  assert.deepEqual(result.featuredIntervals, [2, 7]);
  assert.deepEqual(result.wins, { wins: 1, trials: 2, guaranteed: 1, unknown: 0 });
});

test('unknown item breaks both windows until later reward anchors', () => {
  const rows = fixtureRows(0);
  const chronological = [...rows].reverse();
  chronological[4].rarity = 'Unknown';
  chronological[4].banner_result!.reason = 'unknown_item';
  const result = analyzeHistory(rows, { startingPity: 0, guaranteed: false });
  assert.deepEqual(shape(result.windows.elite), {
    budget: 7,
    count: 1,
    startingPity: 0,
    guaranteed: false
  });
  assert.deepEqual(shape(result.windows.featured), {
    budget: 7,
    count: 1,
    startingPity: 0,
    guaranteed: false
  });
});

test('unavailable featured windows preserve their cause through unknown ordinary carry', () => {
  const reasons: [BannerResult['reason'], RegExp][] = [
    ['unknown_pool', /banner cannot be classified/],
    ['unknown_provider', /provider has no reviewed banner classification/],
    ['unknown_item', /unknown item interrupts/],
    ['guarantee_conflict', /conflicts with the expected guarantee/],
    ['unsupported_type', /not supported for this recruitment type/]
  ];
  for (const [reason, expected] of reasons) {
    const rows = fixtureRows(0);
    rows[2].banner_result = {
      featured: null,
      outcome: 'not_applicable',
      guarantee_before: null,
      guarantee_after: null,
      featured_pity: null,
      reason
    };
    rows[1].banner_result!.guarantee_after = null;
    rows[0].banner_result!.guarantee_after = null;
    const result = analyzeHistory(rows);
    assert.equal(result.windows.featured, null);
    assert.match(result.windowReasons.featured, expected);
    assert.notEqual(result.windows.elite, null);
  }
  const gap = analyzeHistory(fixtureRows(3));
  assert.match(gap.windowReasons.elite, /history gap/);
  assert.match(gap.windowReasons.featured, /history gap/);
});

test('unknown featured identity has a distinct unavailable reason', () => {
  const rows = fixtureRows(6);
  rows[0].banner_result = {
    featured: null,
    outcome: 'unknown',
    guarantee_before: null,
    guarantee_after: null,
    featured_pity: null,
    reason: null
  };
  const result = analyzeHistory(rows);
  assert.equal(result.windows.featured, null);
  assert.match(result.windowReasons.featured, /unknown featured identity/);
  assert.deepEqual(shape(result.windows.elite), {
    budget: 0,
    count: 0,
    startingPity: 0,
    guaranteed: false
  });
});

function document(
  items: number[],
  type = 3,
  host = 'gf2-gacha-record-us.sunborngame.com',
  time = 1770642000
) {
  return {
    schema_version: 1,
    exported_at: '2026-02-10T00:00:00Z',
    endpoint_host: host,
    records: items.map((item) => ({
      source_type_id: type,
      source_page: 1,
      record: { item, pool_id: 224001, item_num: 1, time }
    }))
  };
}

test('empty profiles return explicit empty aggregate state', () => {
  const engine = new LocalEngine();
  const profile = engine.createProfile('Empty');
  const result = engine.statisticsSummary(profile.id, null);
  assert.deepEqual(result.types, []);
  assert.equal(result.selectedType, null);
  assert.equal(result.summary.typeId, null);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.currentPity, null);
  assert.equal(result.summary.currentGuarantee, null);
  assert.deepEqual(result.summary.windows, { elite: null, featured: null });
  assert.equal(result.rulesVersion, STATISTICS_RULES_VERSION);
  assert.deepEqual(result.identity, {
    endpoint_host: null,
    account_fingerprint: null,
    server: null,
    game_channel_id: null
  });
});

test('statistics preserve stable timestamp ties and full history independently of reward paging', async () => {
  const engine = new LocalEngine();
  const profile = engine.createProfile('Synthetic');
  await engine.importRecords({
    profile_id: profile.id,
    records_document: document([11007, 1013, 11007, 11007, 1015])
  });
  await engine.importRecords({ profile_id: profile.id, records_document: document([11007], 4) });
  const result = engine.statisticsSummary(profile.id, null);
  assert.deepEqual(result.types, [3, 4]);
  assert.equal(result.selectedType, 3);
  assert.equal(result.summary.total, 5);
  assert.equal(result.summary.currentPity, 1);
  assert.deepEqual(result.summary.intervals, [3]);
  assert.deepEqual(shape(result.summary.windows.elite), {
    budget: 4,
    count: 1,
    startingPity: 0,
    guaranteed: false
  });
  engine.rewards(profile.id, 3, ['Standard'], 1, 1);
  assert.strictEqual(engine.statisticsSummary(profile.id, 3).summary, result.summary);
  assert.equal(engine.statisticsSummary(profile.id, 4).summary.total, 1);
  assert.equal(engine.statisticsSummary(profile.id, 99).selectedType, 3);
  const serialized = JSON.stringify(result);
  for (const privateKey of ['snapshots', 'records', 'item_id', 'timestamp', 'token', 'document'])
    assert.equal(serialized.includes(`"${privateKey}"`), false, privateKey);
});

test('statistics cache survives unrelated revisions and invalidates profile imports and replacement', async () => {
  const engine = new LocalEngine();
  const profile = engine.createProfile('Synthetic');
  await engine.importRecords({ profile_id: profile.id, records_document: document([11007, 1015]) });
  const original = engine.statisticsSummary(profile.id, 3).summary;
  const builds = engineDiagnostics.rowBuilds;
  const candidate = engine.fork();
  candidate.renameProfile(profile.id, 'Renamed');
  candidate.createProfile('Other');
  assert.strictEqual(candidate.statisticsSummary(profile.id, 3).summary, original);
  assert.equal(engineDiagnostics.rowBuilds, builds);
  await candidate.importRecords({
    profile_id: profile.id,
    records_document: document([11007, 11007, 1015])
  });
  assert.equal(candidate.statisticsSummary(profile.id, 3).summary.total, 3);
  assert.strictEqual(engine.statisticsSummary(profile.id, 3).summary, original);
  assert.equal(original.total, 2);
  const replaced = await engine.replaceState(candidate.exportState());
  assert.equal(engine.statisticsSummary(profile.id, 3).summary.total, 3);
  const current = engine.statisticsSummary(profile.id, 3).summary;
  replaced.profiles[0].account_fingerprint = `sha256:${'a'.repeat(64)}`;
  const identityOnly = engine.fork(replaced);
  assert.strictEqual(identityOnly.statisticsSummary(profile.id, 3).summary, current);
  assert.equal(
    identityOnly.statisticsSummary(profile.id, 3).identity.account_fingerprint,
    `sha256:${'a'.repeat(64)}`
  );
  const changedHost = identityOnly.exportState();
  changedHost.profiles[0].endpoint_host = 'gf2-gacha-record-intl.haoplay.com';
  assert.notStrictEqual(
    identityOnly.fork(changedHost).statisticsSummary(profile.id, 3).summary,
    current
  );
  engine.deleteProfile(profile.id);
  assert.throws(() => engine.statisticsSummary(profile.id, 3), /Profile not found/);
});

test('featured classification retains provider and supported-type boundaries', async () => {
  for (const [type, host, reason] of [
    [3, 'gf2-gacha-record-intl.haoplay.com', /provider has no reviewed/],
    [1, 'gf2-gacha-record-us.sunborngame.com', /not supported/]
  ] as const) {
    const engine = new LocalEngine();
    const profile = engine.createProfile('Synthetic');
    await engine.importRecords({
      profile_id: profile.id,
      records_document: document([11007, 1015], type, host)
    });
    const result = engine.statisticsSummary(profile.id, type).summary;
    assert.equal(result.windows.featured, null);
    assert.match(result.windowReasons.featured, reason);
    assert.notEqual(result.windows.elite, null);
  }
});

test('both targeted families use the fixed loss roster outside dated catalog bounds', async () => {
  for (const [type, pool, featured] of [
    [3, 9001, 1028],
    [4, 10001, 11056]
  ]) {
    for (const date of [
      '2025-02-28T16:59:59Z',
      '2025-02-28T17:00:00Z',
      '2025-03-19T06:59:59Z',
      '2025-03-19T07:00:00Z'
    ]) {
      const engine = new LocalEngine();
      const profile = engine.createProfile('Synthetic');
      const input = document(
        [11007, featured],
        type,
        'gf2-gacha-record-us.sunborngame.com',
        Date.parse(date) / 1000
      );
      input.records.forEach((entry) => (entry.record.pool_id = pool));
      await engine.importRecords({ profile_id: profile.id, records_document: input });
      const result = engine.statisticsSummary(profile.id, type).summary;
      assert.equal(result.featuredCount, 1, `${type}: ${date}`);
      assert.equal(result.unknownFeaturedCount, 0, `${type}: ${date}`);
      assert.deepEqual(shape(result.windows.featured), {
        budget: 1,
        count: 0,
        startingPity: 0,
        guaranteed: false
      });
      assert.equal(result.currentGuarantee, false);
    }
  }
});

test('each comparison window retains its own Elite denominator, excluding anchors and older gaps', () => {
  // Reviewed against chronological synthetic event sequences in the shared fixtures.
  const denominators = [
    [3, 2],
    [2, 2],
    [1, 1],
    [null, null],
    [0, null],
    [null, null],
    [0, 0],
    [3, 0],
    [null, null]
  ];
  fixtures.cases.forEach((fixture, index) => {
    const summary = analyzeHistory(fixture.rows as HistoryRow[]);
    assert.deepEqual(
      [summary.windows.elite?.eliteCount ?? null, summary.windows.featured?.eliteCount ?? null],
      denominators[index],
      fixture.name
    );
  });
  const established = analyzeHistory(fixtureRows(0), { startingPity: 0, guaranteed: false });
  assert.equal(established.windows.featured?.count, 2);
  assert.equal(established.windows.featured?.eliteCount, 3);
  const trailing = fixtureRows(0).slice(5);
  const beforeTrailing = analyzeHistory(trailing);
  const afterTrailing = analyzeHistory(fixtureRows(0));
  assert.equal(afterTrailing.windows.featured!.budget - beforeTrailing.windows.featured!.budget, 5);
  assert.equal(
    afterTrailing.windows.featured!.eliteCount,
    beforeTrailing.windows.featured!.eliteCount
  );
});
