import test from 'node:test';
import assert from 'node:assert/strict';
import { savedServerChoices, serverCapabilities } from '../src/lib/import-policy.ts';
import type { PublicConfig } from '../src/lib/public-api.ts';
const config: PublicConfig = {
  mode: 'public',
  csrf_token: 'synthetic',
  accounts: [],
  limits: {},
  identity_verification: { available: true, reason: null },
  features: { server_backup: true, community_contribution: true, relay_import: true }
};
test('first use and unavailable configuration always choose browser-only imports', () => {
  assert.deepEqual(savedServerChoices(config, null, null), {
    saveBackup: false,
    contribute: false
  });
  assert.deepEqual(savedServerChoices(undefined, 'true', 'true'), {
    saveBackup: false,
    contribute: false
  });
  assert.deepEqual(
    savedServerChoices(
      { ...config, identity_verification: { available: false, reason: 'Disabled' } },
      'true',
      'true'
    ),
    { saveBackup: false, contribute: false }
  );
});
test('saved explicit choices require each individual capability', () => {
  assert.deepEqual(savedServerChoices(config, 'true', 'false'), {
    saveBackup: true,
    contribute: false
  });
  assert.deepEqual(
    savedServerChoices(
      { ...config, features: { ...config.features, server_backup: false } },
      'true',
      'true'
    ),
    { saveBackup: false, contribute: true }
  );
  assert.equal(
    serverCapabilities({ ...config, identity_verification: { available: false, reason: null } })
      .relay,
    true
  );
});
