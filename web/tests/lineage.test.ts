import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createLineageIndex } from '../src/lib/sync/lineage.ts';
import { canonical, type Resolutions } from '../src/lib/sync/reconcile.ts';
import { digest, validateState } from '../src/lib/local/engine.ts';
import { decodeBackup, encodeBackup } from '../src/lib/local/backup.ts';
import {
  emptyState,
  identityKey,
  type PortableProfile,
  type PortableState
} from '../src/lib/local/types.ts';

const time = '2026-09-20T10:00:00.000Z';
function profile(id: string, account = 'one'): PortableProfile {
  return {
    id,
    aliases: [id],
    name: `Account ${account}`,
    account_fingerprint: `sha256:${(account === 'one' ? 'a' : account === 'two' ? 'b' : 'c').repeat(64)}`,
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    server: '1',
    game_channel_id: '1',
    created_at: time,
    updated_at: time,
    snapshots: []
  };
}
const archive = (...profiles: PortableProfile[]): PortableState => ({ ...emptyState(), profiles });

async function legacyRoundTrip(state: PortableState): Promise<PortableState> {
  const legacy = structuredClone(state) as PortableState;
  legacy.version = 1;
  for (const profile of legacy.profiles) delete (profile as Partial<PortableProfile>).aliases;
  for (const deletion of legacy.tombstones) delete (deletion as { aliases?: string[] }).aliases;
  const wire = await validateState(legacy, { preserveVersion: true });
  return decodeBackup(
    gzipSync(
      canonical({
        format: 'gfl2-pull-tracker-backup',
        version: 1,
        state: wire,
        sha256: await digest(wire)
      })
    )
  );
}

test('legacy completion and canonical merge recover deleted aliases without restoring profiles', async () => {
  const partial = profile('z-old');
  partial.account_fingerprint = null;
  const oldDevice = await legacyRoundTrip(archive(partial));
  const completed = await legacyRoundTrip(archive(profile('z-old')));
  const merged = await legacyRoundTrip(archive(profile('a-canonical')));
  const deleted = await legacyRoundTrip({
    ...emptyState(),
    tombstones: [
      {
        profile_id: 'a-canonical',
        aliases: ['a-canonical'],
        deleted_at: time,
        identity: identityKey(profile('a-canonical'))
      }
    ]
  });
  const index = createLineageIndex();
  for (const state of [deleted, merged, completed, oldDevice]) index.add(state);
  const recovered = index.recover(deleted);
  assert.deepEqual(recovered.conflicts, []);
  assert.deepEqual(recovered.state.tombstones[0].aliases, ['a-canonical', 'z-old']);
  assert.deepEqual(recovered.state.profiles, []);
  const device = index.recover(oldDevice).state;
  assert.deepEqual(device.profiles[0].aliases, ['a-canonical', 'z-old']);
  assert.equal(device.profiles[0].account_fingerprint, null);
  assert.deepEqual(await decodeBackup(await encodeBackup(recovered.state)), recovered.state);
  assert.deepEqual(oldDevice.profiles[0].aliases, ['z-old']);
});

test('unrelated partial identities never establish historical aliases', () => {
  const first = profile('first');
  const second = profile('second');
  first.account_fingerprint = second.account_fingerprint = null;
  const index = createLineageIndex();
  index.add(archive(first, second));
  const result = index.recover(archive(first, second));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    result.state.profiles.map((p) => p.aliases),
    [['first'], ['second']]
  );
});

test('contradictory same-ID ancestry requires a scoped identity choice', () => {
  const old = profile('reused', 'one');
  const other = profile('reused', 'two');
  const partial = profile('reused');
  partial.account_fingerprint = null;
  const index = createLineageIndex();
  for (const p of [old, other, profile('one-peer', 'one'), profile('two-peer', 'two')])
    index.add(archive(p));
  const initial = index.recover(archive(partial));
  assert.equal(initial.conflicts.length, 1);
  const conflict = initial.conflicts[0];
  assert.equal(conflict.kind, 'identity');
  assert.deepEqual(index.recover(archive(other)).conflicts, initial.conflicts);
  const choice = conflict.remoteLabel.includes(other.account_fingerprint!) ? 'remote' : 'local';
  const resolutions: Resolutions = { [conflict.id]: { choice, fingerprint: conflict.fingerprint } };
  const resolved = index.recover(archive(partial), resolutions);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.state.profiles[0].aliases, ['reused', 'two-peer']);
  assert.equal(resolved.state.profiles[0].account_fingerprint, null);
  assert.deepEqual(index.recover(archive(old), resolutions).state.profiles[0].aliases, [
    'one-peer',
    'reused'
  ]);
  assert.equal(
    index.recover(archive(partial), {
      [conflict.id]: { choice, fingerprint: 'obsolete evidence' }
    }).conflicts.length,
    1
  );
});

test('new evidence invalidates historical identity choices', () => {
  const index = createLineageIndex();
  index.add(archive(profile('reused', 'one'), profile('reused', 'two')));
  const conflict = index.recover(emptyState()).conflicts[0];
  const resolutions: Resolutions = {
    [conflict.id]: { choice: 'local', fingerprint: conflict.fingerprint }
  };
  index.add(archive(profile('reused', 'three')));
  assert.ok(index.recover(emptyState(), resolutions).conflicts.length > 0);
});

test('download order and duplicate revisions do not affect historical recovery', () => {
  const states = [archive(profile('a')), archive(profile('b')), archive(profile('c'))];
  const forward = createLineageIndex();
  const reverse = createLineageIndex();
  states.forEach((state) => forward.add(state));
  [...states].reverse().forEach((state) => {
    reverse.add(state);
    reverse.add(state);
  });
  assert.deepEqual(forward.recover(states[0]), reverse.recover(states[0]));
  assert.deepEqual(forward.recover(states[0]).state.profiles[0].aliases, ['a', 'b', 'c']);
});

test('v2 checkpoints carry aliases forward without their old source documents', () => {
  const checkpoint = profile('canonical');
  checkpoint.aliases = ['canonical', 'legacy'];
  const index = createLineageIndex();
  index.add(archive(checkpoint));
  const partial = profile('legacy');
  partial.account_fingerprint = null;
  index.add(archive(partial));
  assert.deepEqual(index.recover(archive(partial)).state.profiles[0].aliases, [
    'canonical',
    'legacy'
  ]);
});

test('contradictory accounts connected by explicit partial aliases require a choice', () => {
  const index = createLineageIndex();
  index.add(archive(profile('a', 'one')));
  index.add(archive(profile('b', 'two')));
  const partial = profile('a');
  partial.account_fingerprint = null;
  partial.aliases = ['a', 'b'];
  index.add(archive(partial));
  const result = index.recover(archive(partial));
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  const resolved = index.recover(archive(partial), {
    [conflict.id]: { choice: 'local', fingerprint: conflict.fingerprint }
  });
  assert.equal(resolved.conflicts.length, 0);
  assert.deepEqual(resolved.state.profiles[0].aliases, ['a', 'b']);
});
