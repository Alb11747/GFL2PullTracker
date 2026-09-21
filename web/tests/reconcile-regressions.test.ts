import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical,
  reconcile,
  type Resolutions,
  type SyncConflict
} from '../src/lib/sync/reconcile.ts';
import {
  emptyState,
  identityKey,
  profileIds,
  deletionIds,
  type PortableProfile,
  type PortableState
} from '../src/lib/local/types.ts';
import { validateState } from '../src/lib/local/engine.ts';

const time = '2026-09-20T10:00:00.000Z';
function profile(id = 'profile-a', name = 'Account'): PortableProfile {
  return {
    id,
    aliases: [id],
    name,
    account_fingerprint: 'sha256:' + 'a'.repeat(64),
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    server: '1',
    game_channel_id: '1',
    created_at: time,
    updated_at: time,
    snapshots: []
  };
}
function state(...profiles: PortableProfile[]): PortableState {
  return { ...emptyState(), profiles };
}
function choose(conflict: SyncConflict, choice: 'local' | 'remote'): Resolutions {
  return { [conflict.id]: { choice, fingerprint: conflict.fingerprint } };
}

test('portable settings merge per key and converge after an explicit concurrent choice', () => {
  const base = state();
  base.settings = { theme: 'light', locale: 'en', page_size: 25 };
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.settings = { ...base.settings, theme: 'dark', page_size: 50, contribute: true };
  remote.settings = { ...base.settings, theme: 'system', locale: 'ja', saveServerBackup: true };
  const pending = reconcile(local, remote, base);
  assert.deepEqual(
    pending.conflicts.map((c) => c.id),
    ['setting:theme']
  );
  const result = reconcile(local, remote, base, choose(pending.conflicts[0], 'remote'));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.state.settings, { theme: 'system', locale: 'ja', page_size: 50 });
  for (const device of [local, remote]) {
    const converged = reconcile(device, result.state, device);
    assert.equal(converged.conflicts.length, 0);
    assert.equal(canonical(converged.state), canonical(result.state));
  }
});

test('missing preferences adopt the available value and consent never travels', () => {
  const local = state();
  const remote = state();
  local.settings = { theme: 'dark', contribute: true };
  remote.settings = { locale: 'ja', page_size: 50, access_token: 'not-portable' };
  const result = reconcile(local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.state.settings, { theme: 'dark', locale: 'ja', page_size: 50 });
});

test('delete choice is invalidated by an intervening history import despite unchanged labels', () => {
  const base = state(profile());
  const local = state(profile('profile-a', 'Edited'));
  const remote = state();
  remote.tombstones = [
    {
      profile_id: 'profile-a',
      aliases: ['profile-a'],
      identity: identityKey(base.profiles[0]),
      deleted_at: time
    }
  ];
  const pending = reconcile(local, remote, base);
  const choice = choose(pending.conflicts[0], 'remote');
  local.profiles[0].snapshots.push({
    id: 'new-import',
    digest: 'new-digest',
    document: { records: [] },
    manifest: null,
    raw_pages: null,
    imported_at: time
  });
  const refreshed = reconcile(local, remote, base, choice);
  assert.equal(refreshed.conflicts.length, 1);
  assert.equal(refreshed.conflicts[0].id, pending.conflicts[0].id);
  assert.equal(refreshed.conflicts[0].localLabel, pending.conflicts[0].localLabel);
  assert.notEqual(refreshed.conflicts[0].fingerprint, pending.conflicts[0].fingerprint);
});

test('signed rename choices cannot be reused when actual account alternatives change', () => {
  const base = state(profile());
  const local = state(profile('profile-a', 'Alice'));
  const remote = state(profile('profile-a', 'Bob'));
  const pending = reconcile(local, remote, base);
  const resolutions = choose(pending.conflicts[0], 'remote');
  assert.equal(reconcile(local, remote, base, resolutions).state.profiles[0].name, 'Bob');
  remote.profiles[0].updated_at = '2026-09-21T10:00:00.000Z';
  assert.equal(reconcile(local, remote, base, resolutions).conflicts.length, 1);
});

test('identity choice continues to a deletion decision and either choice validates', async () => {
  const selected = profile('shared-id', 'Selected');
  const rejected = profile('shared-id', 'Other account');
  rejected.account_fingerprint = 'sha256:' + 'b'.repeat(64);
  const local = state(selected);
  const remote = state(rejected);
  remote.tombstones = [
    {
      profile_id: 'old-profile-id',
      aliases: ['old-profile-id'],
      identity: identityKey(selected),
      deleted_at: time
    }
  ];
  const first = reconcile(local, remote);
  assert.equal(first.conflicts[0].kind, 'identity');
  const identityChoice = choose(first.conflicts[0], 'local');
  const second = reconcile(local, remote, emptyState(), identityChoice);
  assert.deepEqual(
    second.conflicts.map((c) => c.kind),
    ['delete-edit']
  );
  for (const choice of ['local', 'remote'] as const) {
    const result = reconcile(local, remote, emptyState(), {
      ...identityChoice,
      ...choose(second.conflicts[0], choice)
    });
    assert.equal(result.conflicts.length, 0);
    await validateState(result.state);
    assert.equal(result.state.profiles.length, choice === 'local' ? 1 : 0);
    assert.equal(result.state.tombstones.length, choice === 'local' ? 0 : 1);
    const ids =
      choice === 'local'
        ? profileIds(result.state.profiles[0])
        : deletionIds(result.state.tombstones[0]);
    assert.deepEqual(ids, ['old-profile-id', 'shared-id']);
  }
});

test('aliases stop an offline partial identity from silently resurrecting deleted history', async () => {
  const one = profile('profile-a');
  const two = profile('profile-b');
  const merged = reconcile(state(one), state(two)).state;
  assert.deepEqual(profileIds(merged.profiles[0]), ['profile-a', 'profile-b']);
  const deleted = state();
  deleted.tombstones = [
    {
      profile_id: merged.profiles[0].id,
      aliases: merged.profiles[0].aliases,
      identity: identityKey(merged.profiles[0]),
      deleted_at: time
    }
  ];
  const stale = structuredClone(two);
  stale.server = null;
  const pending = reconcile(state(stale), deleted);
  assert.equal(pending.conflicts[0].kind, 'delete-edit');
  const result = reconcile(
    state(stale),
    deleted,
    emptyState(),
    choose(pending.conflicts[0], 'remote')
  );
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.profiles.length, 0);
  assert.deepEqual(deletionIds(result.state.tombstones[0]), ['profile-a', 'profile-b']);
  await validateState(result.state);
});

test('deletions retain aliases learned while accepting a causal deletion', () => {
  const one = profile('profile-a');
  const two = profile('profile-b');
  const base = state(one);
  const deleted = state();
  deleted.tombstones = [
    { profile_id: one.id, aliases: [one.id], identity: identityKey(one), deleted_at: time }
  ];
  const result = reconcile(state(two), deleted, base);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.profiles.length, 0);
  assert.deepEqual(deletionIds(result.state.tombstones[0]), ['profile-a', 'profile-b']);
});

test('transitive identity collision keeps chosen incompatible accounts and their snapshots separate', async () => {
  const one = profile('profile-a');
  const two = profile('profile-b');
  two.account_fingerprint = 'sha256:' + 'b'.repeat(64);
  const foreign = structuredClone(two);
  foreign.id = one.id;
  foreign.aliases = [one.id];
  const local = state(one, two);
  const remote = state(foreign);
  const pending = reconcile(local, remote);
  const result = reconcile(local, remote, emptyState(), choose(pending.conflicts[0], 'local'));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(
    result.state.profiles.map((p) => [p.id, p.account_fingerprint, p.aliases]),
    [
      ['profile-a', 'sha256:' + 'a'.repeat(64), ['profile-a']],
      ['profile-b', 'sha256:' + 'b'.repeat(64), ['profile-b']]
    ]
  );
  await validateState(result.state);
});
