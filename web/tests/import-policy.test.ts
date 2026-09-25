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
  features: { submit_history: true, relay_import: true }
};
test('submission defaults on and remembers explicit opt-out', () => {
  assert.deepEqual(savedServerChoices(config, null), { submitHistory: true });
  assert.deepEqual(savedServerChoices(config, 'true'), { submitHistory: true });
  assert.deepEqual(savedServerChoices(config, 'false'), { submitHistory: false });
});
test('submission requires both a feature and the provider verification gate', () => {
  assert.deepEqual(savedServerChoices(undefined, 'true'), { submitHistory: false });
  assert.deepEqual(
    savedServerChoices(
      { ...config, identity_verification: { available: false, reason: 'Disabled' } },
      null
    ),
    { submitHistory: false }
  );
  assert.deepEqual(
    savedServerChoices(
      { ...config, features: { ...config.features, submit_history: false } },
      'true'
    ),
    { submitHistory: false }
  );
  assert.equal(
    serverCapabilities({ ...config, identity_verification: { available: false, reason: null } })
      .relay,
    true
  );
});
