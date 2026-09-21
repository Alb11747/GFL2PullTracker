import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { LocalEngine, digest, validateState } from '../src/lib/local/engine.ts';
import { decodeBackup, encodeBackup, InvalidBackupError } from '../src/lib/local/backup.ts';
import { emptyState, UnsupportedArchiveVersionError } from '../src/lib/local/types.ts';
import { createDriveTransport, DriveError, type NewRevision } from '../src/lib/sync/drive.ts';

const timestamp = '2026-09-21T12:00:00.000Z';
const revision: NewRevision = {
  id: 'stable-revision',
  parents: [],
  createdAt: timestamp,
  sha256: 'a'.repeat(64)
};
function file(id: string, version: number | undefined = 1) {
  return {
    id,
    version: '1',
    size: '100',
    appProperties: { tracker: 'gfl2-stable', revision: id },
    description: JSON.stringify({ ...revision, id, format: 'gfl2-drive-revision', version })
  };
}
const compressed = (envelope: unknown) => new Uint8Array(gzipSync(JSON.stringify(envelope)));

test('stable round trip retains aliases, tombstones, duplicate occurrences, and source ordering', async () => {
  const engine = new LocalEngine();
  const profile = engine.createProfile('Stable account');
  engine.state.profiles[0].aliases = [profile.id, 'earlier-account'].sort();
  await engine.importRecords({
    profile_id: profile.id,
    records_document: {
      schema_version: 1,
      exported_at: timestamp,
      records: [11007, 1013, 11007].map((item) => ({
        source_type_id: 3,
        source_page: 1,
        record: { item, pool_id: 224001, item_num: 1, time: 1784800558 }
      }))
    }
  });
  engine.state.tombstones.push({
    profile_id: 'deleted',
    aliases: ['deleted', 'older-deleted'],
    deleted_at: timestamp,
    identity: null
  });
  engine.state.settings.theme = 'dark';
  const before = structuredClone(engine.state);
  const decoded = await decodeBackup(await encodeBackup(before));
  assert.equal(decoded.version, 1);
  assert.deepEqual(decoded, before);
  assert.deepEqual(new LocalEngine(decoded).overview(profile.id), engine.overview(profile.id));
  assert.deepEqual(
    new LocalEngine(decoded).overview(profile.id).map((pull) => pull.item_id),
    [11007, 1013, 11007]
  );
});

test('prerelease and future archive versions are unsupported, never corrupt', async () => {
  for (const version of [undefined, 0, 2, '1']) {
    const state: Record<string, unknown> = { ...emptyState(), version };
    if (version === undefined) delete state.version;
    await assert.rejects(validateState(state), UnsupportedArchiveVersionError);
    await assert.rejects(
      decodeBackup(
        compressed({
          format: 'gfl2-pull-tracker-backup',
          version: 1,
          state,
          sha256: await digest(state)
        })
      ),
      (error: unknown) =>
        error instanceof UnsupportedArchiveVersionError && !(error instanceof InvalidBackupError)
    );
  }
  await assert.rejects(
    validateState({ ...emptyState(), version: 2, access_token: 'future-field' }),
    UnsupportedArchiveVersionError
  );
});

test('backup envelope version is checked independently from archive version and checksum', async () => {
  const state = emptyState();
  for (const version of [undefined, 2]) {
    await assert.rejects(
      decodeBackup(
        compressed({
          format: 'gfl2-pull-tracker-backup',
          version,
          state,
          sha256: await digest(state)
        })
      ),
      UnsupportedArchiveVersionError
    );
  }
  await assert.rejects(
    decodeBackup(
      compressed({ format: 'gfl2-pull-tracker-backup', version: 1, state, sha256: '0'.repeat(64) })
    ),
    InvalidBackupError
  );
  const output = await encodeBackup(state);
  const plain = await new Response(
    new Blob([new Uint8Array(output).buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).json();
  assert.equal(plain.version, 1);
  assert.equal(plain.state.version, 1);
  assert.equal(plain.sha256, await digest(state));
});

test('Drive stable ownership is excluded from prerelease cleanup markers', async () => {
  const calls: string[] = [];
  let uploaded = '';
  const transport = createDriveTransport(
    () => 'test-only',
    async (input, init = {}) => {
      calls.push(String(input));
      if (init.method === 'POST') {
        uploaded = await (init.body as Blob).text();
        return Response.json({ id: 'published', version: '3', size: '10' });
      }
      return Response.json({ files: [file('stable')] });
    }
  );
  await transport.list();
  assert.equal(
    new URL(calls[0]).searchParams.get('q'),
    "trashed = false and appProperties has { key='tracker' and value='gfl2-stable' }"
  );
  await transport.upload(revision, new Uint8Array([1]));
  assert.match(uploaded, /"tracker":"gfl2-stable"/);
  assert.match(uploaded, /\\"format\\":\\"gfl2-drive-revision\\",\\"version\\":1/);
  assert.doesNotMatch(uploaded, /"tracker":"gfl2(?:-v1)?"/);
});

test('Drive listing defers corrupt metadata cleanup until payload audit', async () => {
  const methods: string[] = [];
  const transport = createDriveTransport(
    () => 'test-only',
    async (input, init = {}) => {
      methods.push(init.method ?? 'GET');
      return Response.json({ files: [file('valid'), { ...file('corrupt'), description: '{}' }] });
    }
  );
  assert.deepEqual(
    (await transport.list()).map((value) => value.id),
    ['valid']
  );
  assert.deepEqual(transport.pendingInvalidFiles?.(), ['corrupt']);
  assert.deepEqual(methods, ['GET']);
  const copy = transport.pendingInvalidFiles?.() as string[];
  copy.length = 0;
  assert.deepEqual(transport.pendingInvalidFiles?.(), ['corrupt']);
});

test('future Drive metadata blocks cleanup across pages, including oversized revisions', async () => {
  const methods: string[] = [];
  let page = 0;
  const transport = createDriveTransport(
    () => 'test-only',
    async (input, init = {}) => {
      methods.push(init.method ?? 'GET');
      return Response.json(
        page++ === 0
          ? { files: [{ ...file('corrupt'), description: '{}' }], nextPageToken: 'next' }
          : { files: [{ ...file('future', 2), size: String(20 * 1024 * 1024) }] }
      );
    }
  );
  await assert.rejects(
    transport.list(),
    (error: unknown) => error instanceof DriveError && error.code === 'unsupported'
  );
  assert.deepEqual(transport.pendingInvalidFiles?.(), []);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('a failed listing clears earlier deferred cleanup', async () => {
  let calls = 0;
  const transport = createDriveTransport(
    () => 'test-only',
    async () =>
      Response.json({
        files: calls++ === 0 ? [{ ...file('corrupt'), description: '{}' }] : [file('future', 2)]
      })
  );
  await transport.list();
  assert.deepEqual(transport.pendingInvalidFiles?.(), ['corrupt']);
  await assert.rejects(transport.list());
  assert.deepEqual(transport.pendingInvalidFiles?.(), []);
});
