import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalEngine } from '../src/lib/local/engine.ts';
import { emptyState } from '../src/lib/local/types.ts';
import { prepareBackupRestore } from '../src/lib/local/restore.ts';

function fixture() {
  const engine = new LocalEngine(emptyState());
  const profile = engine.createProfile('Original account');
  const backup = engine.exportState();
  engine.renameProfile(profile.id, 'Renamed account');
  return { local: engine.exportState(), backup, id: profile.id };
}

test('offline renames offer fingerprinted device and backup choices without Drive', () => {
  const { local, backup } = fixture();
  const preview = prepareBackupRestore(local, backup, false);
  assert.equal(preview.conflicts.length, 1);
  const conflict = preview.conflicts[0];
  assert.equal(conflict.kind, 'rename');
  for (const choice of ['local', 'remote'] as const) {
    const resolved = prepareBackupRestore(local, backup, false, {
      [conflict.id]: { choice, fingerprint: conflict.fingerprint }
    });
    assert.deepEqual(resolved.conflicts, []);
    assert.equal(
      resolved.state.profiles[0].name,
      choice === 'local' ? 'Renamed account' : 'Original account'
    );
  }
  assert.equal(local.profiles[0].name, 'Renamed account');
  assert.equal(backup.profiles[0].name, 'Original account');
});

test('stale offline choices cannot silently select changed alternatives', () => {
  const { local, backup } = fixture();
  const conflict = prepareBackupRestore(local, backup, false).conflicts[0];
  local.profiles[0].name = 'Changed again';
  const refreshed = prepareBackupRestore(local, backup, false, {
    [conflict.id]: { choice: 'remote', fingerprint: conflict.fingerprint }
  });
  assert.equal(refreshed.conflicts.length, 1);
  assert.notEqual(refreshed.conflicts[0].fingerprint, conflict.fingerprint);
});

test('offline merge resolves local deletion versus saved profile', () => {
  const { local, backup, id } = fixture();
  const engine = new LocalEngine(local);
  engine.deleteProfile(id);
  const deleted = engine.exportState();
  const conflict = prepareBackupRestore(deleted, backup, false).conflicts[0];
  assert.equal(conflict.kind, 'delete-edit');
  for (const choice of ['local', 'remote'] as const) {
    const restored = prepareBackupRestore(deleted, backup, false, {
      [conflict.id]: { choice, fingerprint: conflict.fingerprint }
    });
    assert.equal(restored.conflicts.length, 0);
    assert.equal(restored.state.profiles.length, choice === 'remote' ? 1 : 0);
  }
});

test('restore preserves local device settings but never imports backup consent', () => {
  const { local, backup } = fixture();
  local.settings = { saveServerBackup: false, theme: 'dark' };
  backup.settings = { saveServerBackup: true, contribute: true, theme: 'light' };
  const replacement = prepareBackupRestore(local, backup, true);
  assert.deepEqual(replacement.conflicts, []);
  assert.deepEqual(replacement.state.settings, { saveServerBackup: false, theme: 'light' });
  const merged = prepareBackupRestore(local, backup, false);
  assert.equal(merged.state.settings.saveServerBackup, false);
  assert.equal(merged.state.settings.contribute, undefined);
  assert.ok(merged.conflicts.some((conflict) => conflict.kind === 'setting'));
});
