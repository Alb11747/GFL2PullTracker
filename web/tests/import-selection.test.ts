import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { classifyImportFiles } from '../src/lib/import-selection.ts';
import { encodeBackup, MAX_COMPRESSED_BYTES } from '../src/lib/local/backup.ts';
import { MAX_STATE_BYTES } from '../src/lib/local/engine.ts';
import { emptyState } from '../src/lib/local/types.ts';

async function backup(name = 'archive.json.gz') {
  return new File([new Uint8Array(await encodeBackup(emptyState()))], name);
}
function compressed(value: unknown) {
  return new File([gzipSync(JSON.stringify(value))], 'backup.gz');
}

test('unified picker recognizes backup bytes regardless of extension', async () => {
  for (const name of ['archive.json.gz', 'archive.gz', 'archive.gzip', 'renamed.json']) {
    assert.equal(await classifyImportFiles([await backup(name)], true), 'backup');
  }
});

test('JSON selections remain on existing export validation path, including misleading names', async () => {
  assert.equal(
    await classifyImportFiles([new File(['{"records":[]}'], 'records.json')], true),
    'export'
  );
  assert.equal(
    await classifyImportFiles([new File(['{"records":[]}'], 'renamed.gz')], true),
    'export'
  );
  assert.equal(
    await classifyImportFiles(
      [new File(['{}'], 'records.json'), new File(['{}'], 'manifest.json')],
      false
    ),
    'export'
  );
  // The classifier never replaces collector/Exilium schema validation.
  assert.equal(await classifyImportFiles([new File(['invalid'], 'bad.json')], true), 'export');
});

test('mixed exports and archives and multiple archives are rejected before restoration', async () => {
  const archive = await backup();
  await assert.rejects(
    classifyImportFiles([archive, new File(['{}'], 'records.json')], true),
    /one tracker backup by itself/
  );
  await assert.rejects(
    classifyImportFiles([archive, archive], true),
    /one tracker backup by itself/
  );
  await assert.rejects(classifyImportFiles([], true), /Choose an export/);
});

test('local server mode explains unsupported archive restoration', async () => {
  await assert.rejects(classifyImportFiles([await backup()], false), /browser-local tracker/);
});

test('corrupt gzip, format, version, schema and checksum failures never reach restore', async () => {
  await assert.rejects(
    classifyImportFiles([new File([new Uint8Array([0x1f, 0x8b, 0])], 'broken.gz')], true),
    /damaged/
  );
  const envelope = {
    format: 'gfl2-pull-tracker-backup',
    version: 1,
    state: emptyState(),
    sha256: 'wrong'
  };
  await assert.rejects(classifyImportFiles([compressed(envelope)], true), /integrity/);
  await assert.rejects(classifyImportFiles([compressed({ ...envelope, format: 'other' })], true), /format/);
  await assert.rejects(classifyImportFiles([compressed({ ...envelope, version: 3 })], true),
    { name: 'UnsupportedArchiveVersionError' });
  await assert.rejects(classifyImportFiles([compressed({ ...envelope, state: null })], true));
});

test('compressed size is checked before reading an entire archive', async () => {
  let wholeFileRead = false;
  const file = {
    size: MAX_COMPRESSED_BYTES + 1,
    slice: () => new Blob([new Uint8Array([0x1f, 0x8b])]),
    arrayBuffer: async () => {
      wholeFileRead = true;
      return new ArrayBuffer(0);
    }
  } as unknown as File;
  await assert.rejects(classifyImportFiles([file], true), /16 MiB/);
  assert.equal(wholeFileRead, false);
});

test('highly compressed content cannot bypass expanded archive limit', async () => {
  const bytes = gzipSync(new Uint8Array(MAX_STATE_BYTES + 1));
  await assert.rejects(
    classifyImportFiles([new File([bytes], 'large.gz')], true),
    /expanded size limit/
  );
});
