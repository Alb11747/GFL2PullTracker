import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalEngine,
  canonical,
  digest,
  mergeSourceOrder,
  validateState
} from '../src/lib/local/engine.ts';
import { decodeBackup, encodeBackup } from '../src/lib/local/backup.ts';
import type { Filters, ImportInput } from '../src/lib/api.ts';
import fixtures from './local-parity.json' with { type: 'json' };
import {
  applyExclusions,
  removeFromDevice,
  restoreExclusions,
  retainExclusionAliases
} from '../src/lib/local/device.ts';
import { MAX_PROFILE_ALIASES } from '../src/lib/local/types.ts';

export function record(
  item = 11007,
  options: { time?: number; page?: number; type?: number; quantity?: number } = {}
) {
  return {
    source_type_id: options.type || 3,
    source_page: options.page || 1,
    record: {
      item,
      pool_id: 224001,
      item_num: options.quantity ?? 1,
      time: options.time ?? 1784800558
    }
  };
}
function document(records: ReturnType<typeof record>[], extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    exported_at: '2026-07-26T17:57:48Z',
    account_fingerprint: `sha256:${'a'.repeat(64)}`,
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    records,
    ...extra
  };
}
function filters(profile_id: string, changes: Partial<Filters> = {}): Filters {
  return {
    profile_id,
    q: '',
    rarity: '',
    kind: '',
    type_id: '',
    pool_id: '',
    date_from: '',
    date_to: '',
    page: 1,
    page_size: 500,
    ...changes
  };
}
async function setup() {
  const engine = new LocalEngine();
  const profile = engine.createProfile('Commander');
  return { engine, id: profile.id };
}

test('overview returns all UI rows only for its selected profile', async () => {
  const { engine, id } = await setup();
  const other = engine.createProfile('Other');
  await engine.importRecords({
    profile_id: id,
    records_document: document([record(1013), record(11007)])
  });
  await engine.importRecords({ profile_id: other.id, records_document: document([record(1015)]) });
  const rows = engine.overview(id);
  assert.deepEqual(rows, engine.history(filters(id)).items);
  assert.deepEqual(
    rows.map((row) => row.item_id),
    [1013, 11007]
  );
  for (const row of rows)
    for (const internal of ['key', 'occurrence', 'token', 'raw_record', 'account_fingerprint'])
      assert.equal(internal in row, false);
  assert.throws(() => engine.overview('missing'));
});

test('checkbox filters combine OR values and AND fields without changing pity', async () => {
  const { engine, id } = await setup();
  const rows = [record(1013), record(11007), record(1015, { type: 6 }), record(11008, { type: 6 })];
  rows[3].record.pool_id = 224002;
  await engine.importRecords({ profile_id: id, records_document: document(rows) });
  const all = engine.history(filters(id));
  const selected = engine.history(
    filters(id, {
      type_id: ['3', '6'],
      pool_id: ['224001'],
      kind: ['doll', 'weapon'],
      rarity: ['Elite']
    })
  );
  const expected = all.items.filter((row) => row.pool_id === 224001 && row.rarity === 'Elite');
  assert.equal(expected.length, 2);
  assert.deepEqual(selected.items, expected);
  assert.equal(engine.statistics(filters(id, { rarity: ['Elite'] })).total, 2);
  for (const key of ['rarity', 'kind', 'type_id', 'pool_id'] as const) {
    assert.equal(engine.history(filters(id, { [key]: [] })).total, 0);
    assert.equal(engine.statistics(filters(id, { [key]: [] })).total, 0);
    assert.equal(engine.history(filters(id, { [key]: '' })).total, 4);
  }
  assert.equal(engine.history(filters(id, { type_id: '6' })).total, 2);
});

for (const fixture of fixtures)
  test(`shared Python/browser fixture: ${fixture.name}`, async () => {
    const { engine, id } = await setup();
    for (const snapshot of fixture.snapshots)
      await engine.importRecords({
        profile_id: id,
        records_document: document(
          snapshot.map((row) =>
            record(row.item, row as { time?: number; page?: number; type?: number })
          )
        )
      });
    const history = engine.history(filters(id));
    assert.equal(history.total, fixture.expected_total);
    assert.deepEqual(
      history.items.map((row) => row.item_id),
      fixture.expected_items
    );
    if (fixture.expected_pity)
      assert.deepEqual(
        history.items.map((row) => row.pity),
        fixture.expected_pity
      );
    if (fixture.expected_uncertain)
      assert.deepEqual(
        history.items.map((row) => row.pity_uncertain),
        fixture.expected_uncertain
      );
    if (fixture.expected_gaps)
      assert.deepEqual(
        history.items.map((row) => row.gap_before),
        fixture.expected_gaps
      );
    const restored = new LocalEngine(await validateState(engine.exportState()));
    assert.deepEqual(restored.history(filters(id)), history);
  });

test('duplicate snapshots retain legitimate repeats and quantity does not multiply pulls', async () => {
  const { engine, id } = await setup();
  const input = {
    profile_id: id,
    records_document: document([record(11007, { quantity: 5 }), record(11007, { quantity: 5 })])
  };
  assert.equal((await engine.importRecords(input)).added_count, 2);
  assert.equal((await engine.importRecords(input)).duplicate, true);
  assert.equal(engine.statistics(filters(id)).total, 2);
  assert.equal(engine.history(filters(id)).items[0].quantity, 5);
});
test('converted Exilium snapshots are oldest-first with occurrence preservation', async () => {
  const { engine, id } = await setup();
  await engine.importRecords({
    profile_id: id,
    records_document: document([record(11007), record(11008), record(11007), record(11009)], {
      external_source: { source: 'https://exilium.xyz' }
    })
  });
  assert.deepEqual(
    engine.history(filters(id)).items.map((row) => row.item_id),
    [11009, 11007, 11008, 11007]
  );
  assert.equal(
    (
      await engine.importRecords({
        profile_id: id,
        records_document: document([record(11009), record(11007), record(11008), record(11007)])
      })
    ).added_count,
    0
  );
});
test('pity is calculated before filters and pagination, and a bridge heals a prior gap', async () => {
  const { engine, id } = await setup();
  const older = [record(11007, { time: 1700000002 }), record(1013, { time: 1700000001 })];
  const newer = [record(1015, { time: 1700000004 }), record(11007, { time: 1700000003 })];
  for (const rows of [older, newer])
    await engine.importRecords({ profile_id: id, records_document: document(rows) });
  const selection = filters(id, { rarity: 'Elite', page_size: 1 });
  assert.equal(engine.history(selection).items[0].pity, 3);
  assert.equal(engine.history(selection).items[0].pity_uncertain, true);
  await engine.importRecords({ profile_id: id, records_document: document([newer[1], older[0]]) });
  assert.equal(engine.history(selection).items[0].pity_uncertain, false);
});
test('validated empty raw pages bridge incremental page-number jumps', async () => {
  const { engine, id } = await setup();
  const rows = [
    record(11007, { page: 1, time: 1700000002 }),
    record(1013, { page: 3, time: 1700000001 })
  ];
  const raw = Object.fromEntries(
    [1, 2, 3].map((page) => [
      `raw/type_0003/page_000${page}.json`,
      JSON.stringify({
        data: { list: rows.filter((r) => r.source_page === page).map((r) => r.record) }
      })
    ])
  );
  await engine.importRecords({ profile_id: id, records_document: document(rows), raw_pages: raw });
  assert.equal(engine.history(filters(id)).items[0].gap_before, false);
  assert.equal(engine.history(filters(id)).items[0].pity_uncertain, false);
});
test('invalid manifest, mismatched identity and credentials never partly bind a profile', async () => {
  const { engine, id } = await setup();
  const original = engine.exportState();
  const badInputs: ImportInput[] = [
    { profile_id: id, records_document: document([record()], { schema_version: 3 }) },
    { profile_id: id, records_document: document([record()], { token: 'secret' }) },
    {
      profile_id: id,
      records_document: document([record()]),
      manifest: { schema_version: 1, complete: true }
    },
    {
      profile_id: id,
      records_document: document([record()]),
      raw_pages: {
        'raw/type_3/page_1.json': JSON.stringify({
          token: 'secret',
          data: { list: [record().record] }
        })
      }
    }
  ];
  for (const input of badInputs) {
    await assert.rejects(() => engine.importRecords(input));
    assert.deepEqual(engine.exportState(), original);
  }
  await engine.importRecords({
    profile_id: id,
    records_document: document([record()], {
      schema_version: 2,
      server: '10',
      game_channel_id: '5'
    })
  });
  const bound = engine.exportState();
  await assert.rejects(
    () =>
      engine.importRecords({
        profile_id: id,
        records_document: document([record()], {
          schema_version: 2,
          server: '11',
          game_channel_id: '5'
        })
      }),
    /different account/
  );
  assert.deepEqual(engine.exportState(), bound);
});
test('unknown metadata, partial histories, and profile-specific filtering remain separate', async () => {
  const { engine, id } = await setup();
  const second = engine.createProfile('Second');
  await engine.importRecords({
    profile_id: id,
    records_document: document([record(999999), record()])
  });
  await engine.importRecords({ profile_id: second.id, records_document: document([record(1001)]) });
  const stats = engine.statistics(filters(id));
  assert.equal(stats.unknown_total, 1);
  assert.equal(stats.known_total, 1);
  assert.equal(stats.latest_import_complete, null);
  assert.equal(engine.history(filters(id, { q: '999999' })).items[0].rarity, 'Unknown');
  assert.equal(engine.statistics(filters(second.id)).total, 1);
});
test('gzip round-trip preserves sources and rejects corruption, credentials, and future versions', async () => {
  const { engine, id } = await setup();
  await engine.importRecords({ profile_id: id, records_document: document([record(), record()]) });
  const state = engine.exportState();
  const bytes = await encodeBackup(state);
  assert.deepEqual(await decodeBackup(bytes), state);
  assert.ok(bytes.length < new TextEncoder().encode(canonical(state)).length);
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] ^= 0xff;
  await assert.rejects(() => decodeBackup(corrupt));
  await assert.rejects(() => decodeBackup(new Uint8Array([1, 2, 3])), /gzip/);
  await assert.rejects(() => validateState({ ...state, version: 3 }), /Unsupported/);
  await assert.rejects(
    () => validateState({ ...state, settings: { access_token: 'private' } }),
    /credentials/
  );
  await assert.rejects(
    () => validateState({ ...state, settings: { saveServerBackup: true } }),
    /device/
  );
  const edited = structuredClone(state);
  (edited.profiles[0].snapshots[0].document.records as unknown[]).push(record(1001));
  await assert.rejects(() => validateState(edited), /integrity/);
});
test('same complete identity merges across devices, partial identities do not', async () => {
  const left = new LocalEngine();
  const right = new LocalEngine();
  const a = left.createProfile('Commander');
  const b = right.createProfile('Commander');
  for (const [engine, profile] of [
    [left, a],
    [right, b]
  ] as const)
    await engine.importRecords({
      profile_id: profile.id,
      records_document: document([record()], {
        schema_version: 2,
        server: '10',
        game_channel_id: '5'
      })
    });
  await left.mergeState(right.exportState());
  assert.equal(left.profiles().length, 1);
  assert.equal(left.history(filters(a.id)).total, 1);
  const unbound = new LocalEngine();
  unbound.createProfile('Commander');
  await left.mergeState(unbound.exportState());
  assert.equal(left.profiles().length, 2);
});
test('rename, deletion, and identity conflicts fail atomically for explicit resolution', async () => {
  const { engine, id } = await setup();
  const remote = new LocalEngine(engine.exportState());
  remote.renameProfile(id, 'New name');
  const original = engine.exportState();
  await assert.rejects(() => engine.mergeState(remote.exportState()), /names conflict/);
  assert.deepEqual(engine.exportState(), original);
  remote.deleteProfile(id);
  await assert.rejects(() => engine.mergeState(remote.exportState()), /deletion conflicts/);
  assert.deepEqual(engine.exportState(), original);
  engine.deleteProfile(id);
  assert.equal(engine.profiles().length, 0);
  assert.equal(engine.exportState().tombstones[0].profile_id, id);
  await assert.rejects(() => engine.mergeState(original), /conflicts with a deletion/);
});
test('linear source merging preserves known anchors and appends unanchored records', () => {
  assert.deepEqual(mergeSourceOrder(['a', 'b', 'c'], ['b', 'x', 'c']), ['a', 'b', 'x', 'c']);
  assert.deepEqual(mergeSourceOrder(['a', 'b', 'c'], ['c', 'a']), ['a', 'b', 'c']);
  assert.deepEqual(mergeSourceOrder(['a', 'b'], ['x']), ['a', 'b', 'x']);
});
test('canonical hashes preserve snapshot identity independent of JSON property order', async () => {
  assert.equal(await digest({ b: 2, a: [1, 'x'] }), await digest({ a: [1, 'x'], b: 2 }));
});
test('device removal purges history without publishing a deletion and blocks automatic rehydration', async () => {
  const { engine, id } = await setup();
  await engine.importRecords({
    profile_id: id,
    records_document: document([record()], {
      schema_version: 2,
      server: '10',
      game_channel_id: '5'
    })
  });
  const cloud = engine.exportState();
  const removed = removeFromDevice(cloud, id, []);
  assert.equal(removed.state.profiles.length, 0);
  assert.equal(removed.state.tombstones.length, 0);
  assert.deepEqual(Object.keys(removed.exclusions[0]).sort(), [
    'aliases',
    'identity',
    'profile_id'
  ]);
  assert.equal(applyExclusions(cloud, removed.exclusions).profiles.length, 0);
  // The same game identity arriving under a different device's profile ID is also excluded.
  const otherDevice = structuredClone(cloud);
  otherDevice.profiles[0].id = 'other-device';
  assert.equal(applyExclusions(otherDevice, removed.exclusions).profiles.length, 0);
  assert.equal(restoreExclusions(removed.exclusions, cloud).length, 0);
  assert.deepEqual(applyExclusions(cloud, restoreExclusions(removed.exclusions, cloud)), cloud);
});
test('duplicate account assignment and implicit resurrection cannot invalidate portable archives', async () => {
  const { engine, id } = await setup();
  const doc = document([record()], { schema_version: 2, server: '10', game_channel_id: '5' });
  await engine.importRecords({ profile_id: id, records_document: doc });
  const other = engine.createProfile('Other');
  const before = engine.exportState();
  await assert.rejects(
    () => engine.importRecords({ profile_id: other.id, records_document: doc }),
    /already belongs/
  );
  assert.deepEqual(engine.exportState(), before);
  engine.deleteProfile(id);
  await assert.rejects(
    () => engine.importRecords({ profile_id: other.id, records_document: doc }),
    /synced deletion/
  );
  await validateState(engine.exportState());
});

test('legacy gzip checks its original checksum before migrating without changing source hashes', async () => {
  const { engine, id } = await setup();
  await engine.importRecords({ profile_id: id, records_document: document([record()]) });
  const original = engine.exportState();
  const legacy = structuredClone(original) as unknown as Record<string, unknown>;
  legacy.version = 1;
  for (const profile of legacy.profiles as Record<string, unknown>[]) delete profile.aliases;
  assert.deepEqual(await validateState(legacy, { preserveVersion: true }), legacy);
  async function compressed(sha256: string) {
    const envelope = { format: 'gfl2-pull-tracker-backup', version: 1, state: legacy, sha256 };
    return new Uint8Array(
      await new Response(
        new Blob([canonical(envelope)]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer()
    );
  }
  const legacyBytes = await compressed(await digest(legacy));
  const migrated = await decodeBackup(legacyBytes);
  await assert.rejects(() => decodeBackup(legacyBytes, 2), /metadata and backup versions/);
  const v2Bytes = await encodeBackup(original);
  await assert.rejects(() => decodeBackup(v2Bytes, 1), /metadata and backup versions/);
  assert.deepEqual(migrated, original);
  assert.deepEqual(migrated.profiles[0].snapshots, original.profiles[0].snapshots);
  const migratedHash = await digest(original);
  await assert.rejects(() => compressed(migratedHash).then(decodeBackup), /integrity/);
  assert.throws(
    () => new LocalEngine(legacy as unknown as typeof original),
    /validated and migrated/
  );
});

test('v2 rejects missing, duplicate, overlapping, oversized, and contradictory aliases', async () => {
  const { engine } = await setup();
  const original = engine.exportState();
  for (const aliases of [
    undefined,
    [],
    ['x'],
    ['x', 'x'],
    [
      original.profiles[0].id,
      ...Array.from({ length: MAX_PROFILE_ALIASES }, (_, i) => `alias-${i}`)
    ].sort()
  ]) {
    const state = structuredClone(original);
    (state.profiles[0] as unknown as Record<string, unknown>).aliases = aliases;
    await assert.rejects(() => validateState(state));
  }
  const overlap = structuredClone(original);
  overlap.profiles.push({
    ...structuredClone(overlap.profiles[0]),
    id: 'second',
    aliases: [...overlap.profiles[0].aliases, 'second'].sort()
  });
  await assert.rejects(() => validateState(overlap), /Duplicate profile/);
  const contradictory = structuredClone(original);
  contradictory.tombstones.push({
    profile_id: 'deleted',
    aliases: ['deleted', ...original.profiles[0].aliases].sort(),
    identity: null,
    deleted_at: '2026-09-20T00:00:00Z'
  });
  await assert.rejects(() => validateState(contradictory), /both a profile and its deletion/);
});

test('merges and deletion retain every historical ID for offline partial profiles and exclusions', async () => {
  const left = new LocalEngine();
  const right = new LocalEngine();
  const a = left.createProfile('Commander');
  const b = right.createProfile('Commander');
  const partial = right.exportState();
  for (const [engine, id] of [
    [left, a.id],
    [right, b.id]
  ] as const)
    await engine.importRecords({
      profile_id: id,
      records_document: document([record()], {
        schema_version: 2,
        server: '10',
        game_channel_id: '5'
      })
    });
  await left.mergeState(right.exportState());
  const merged = left.exportState();
  assert.deepEqual(merged.profiles[0].aliases, [a.id, b.id].sort());
  assert.equal(merged.profiles[0].id, [a.id, b.id].sort()[0]);
  const removed = removeFromDevice(merged, merged.profiles[0].id, []);
  assert.equal(applyExclusions(partial, removed.exclusions).profiles.length, 0);
  const priorExclusion = [{ profile_id: a.id, identity: null }];
  const learned = retainExclusionAliases(merged, priorExclusion);
  assert.deepEqual(learned[0].aliases, [a.id, b.id].sort());
  assert.equal(applyExclusions(partial, learned).profiles.length, 0);
  assert.deepEqual(priorExclusion, [{ profile_id: a.id, identity: null }]);
  left.deleteProfile(a.id);
  assert.deepEqual(left.exportState().tombstones[0].aliases, [a.id, b.id].sort());
  await assert.rejects(() => left.mergeState(partial), /conflicts with a deletion/);
  await validateState(left.exportState());
});

test('v1 duplicate deletion records migrate to a valid v2 deletion without losing the latest date', async () => {
  const legacy = {
    format: 'gfl2-pull-tracker',
    version: 1,
    profiles: [],
    settings: {},
    tombstones: [
      { profile_id: 'old', identity: null, deleted_at: '2026-09-19T00:00:00Z' },
      { profile_id: 'old', identity: null, deleted_at: '2026-09-20T00:00:00Z' }
    ]
  };
  assert.deepEqual(await validateState(legacy, { preserveVersion: true }), legacy);
  const migrated = await validateState(legacy);
  assert.equal(migrated.tombstones.length, 1);
  assert.deepEqual(migrated.tombstones[0].aliases, ['old']);
  assert.equal(migrated.tombstones[0].deleted_at, '2026-09-20T00:00:00Z');
  assert.deepEqual(await validateState(migrated), migrated);
});

test('imports refresh history cached through a retained profile alias', async () => {
  const { engine, id } = await setup();
  const state = engine.exportState();
  state.profiles[0].aliases = [id, 'retained-profile-id'].sort();
  await engine.replaceState(state);
  assert.equal(engine.history(filters('retained-profile-id')).total, 0);
  const imported = await engine.importRecords({
    profile_id: 'retained-profile-id',
    records_document: document([record()])
  });
  assert.equal(imported.profile_id, id);
  assert.equal(imported.added_count, 1);
  assert.equal(engine.history(filters('retained-profile-id')).total, 1);
  assert.deepEqual(engine.history(filters('retained-profile-id')), engine.history(filters(id)));
});
