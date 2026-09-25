import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionIdentity, snapshotSubmissionIdentity } from '../src/lib/submission-policy.ts';
import { trackerPages } from '../src/lib/tracker-routes.ts';
const verified = {
  account_fingerprint: 'fingerprint',
  endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
  server: '10',
  game_channel_id: '1'
};

test('bound profiles still require confirmation for legacy snapshots and reject embedded conflicts', () => {
  const account = { ...verified, uid: '12345' };
  assert.equal(
    snapshotSubmissionIdentity([{ records_document: { ...verified } }], account),
    'matched'
  );
  assert.equal(snapshotSubmissionIdentity([{ records_document: {} }], account), 'associate');
  assert.equal(
    snapshotSubmissionIdentity(
      [{ records_document: { external_source: { source: 'https://exilium.xyz' } } }],
      account
    ),
    'associate'
  );
  assert.equal(
    snapshotSubmissionIdentity(
      [{ records_document: { ...verified }, manifest: { uid: 'other' } }],
      account
    ),
    'conflict'
  );
  assert.equal(
    snapshotSubmissionIdentity([{ records_document: { ...verified, server: '99' } }], account),
    'conflict'
  );
});
test('complete identity matches while an incomplete identity requires explicit association', () => {
  assert.equal(submissionIdentity(verified, verified), 'matched');
  assert.equal(
    submissionIdentity({ ...verified, account_fingerprint: null }, verified),
    'associate'
  );
  assert.equal(
    submissionIdentity(
      { account_fingerprint: null, endpoint_host: null, server: null, game_channel_id: null },
      verified
    ),
    'associate'
  );
});
test('known identity conflicts cannot use incomplete identity association', () => {
  for (const field of Object.keys(verified)) {
    assert.equal(submissionIdentity({ ...verified, [field]: 'different' }, verified), 'conflict');
  }
  assert.equal(
    submissionIdentity({ ...verified, account_fingerprint: null, server: '99' }, verified),
    'conflict'
  );
});
test('Statistics follows My history and retains its route', () => {
  assert.deepEqual(
    trackerPages.slice(0, 2).map(({ slug, label }) => ({ slug, label })),
    [
      { slug: 'history', label: 'My history' },
      { slug: 'statistics', label: 'Statistics' }
    ]
  );
});
