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
import { applyExclusions, removeFromDevice, restoreExclusions } from '../src/lib/local/device.ts';

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
  await assert.rejects(() => validateState({ ...state, version: 2 }), /Unsupported/);
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
  assert.deepEqual(Object.keys(removed.exclusions[0]).sort(), ['identity', 'profile_id']);
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
