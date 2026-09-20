import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readExport, inspectExiliumProfiles, type ExportFile } from '../src/lib/import-files.ts';
import { decodeExilium } from '../src/lib/exilium-import.ts';

function file(path: string, value: unknown, exact = false): ExportFile {
  const text = exact ? String(value) : JSON.stringify(value);
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    size: Buffer.byteLength(text),
    text: async () => text
  };
}
function row(item = 10, time = 1733227200) {
  return {
    pool_id: 1001,
    item,
    time,
    type_id: 3,
    uid: 'synthetic-account',
    server: 'darkwinter',
    rarity: 4,
    pull_number: 1
  };
}
function profile(id = 'one', pulls = [row()]) {
  return {
    profile: { id, name: `Profile ${id}`, active: 1 },
    pulls: { '3': pulls },
    stats: {},
    inventory: {},
    achievements: [],
    planner: []
  };
}
function store(profilesData = { one: profile() }) {
  return { version: 1, state: { profilesData } };
}
/** Independent reproduction of the observed Exilium settings export protocol. */
function nativeBackup(value: unknown) {
  const opfsValue = gzipSync(JSON.stringify(value)).toString('base64');
  const exportInput = JSON.stringify(opfsValue);
  return {
    timestamp: 1770000000000,
    version: 2,
    compressed: true,
    data: gzipSync(JSON.stringify(exportInput)).toString('base64')
  };
}

test('single collector records document is recognized regardless of its filename', async () => {
  const document = { schema_version: 1, exported_at: '2026-01-01T00:00:00Z', records: [] };
  assert.deepEqual(
    (await readExport([file('download (2).json', document)], 'destination')).records_document,
    document
  );
  assert.deepEqual(await inspectExiliumProfiles([file('download.json', document)]), []);
});

test('incremental collector directories retain both transformed pages and exact response receipts', async () => {
  const response = '{ "data": {"list": []} }\r\n';
  const result = await readExport(
    [
      file('run/records.json', { schema_version: 2 }),
      file('run/raw/type_0003/page_0001.json', { data: { list: [] } }),
      file('run/responses/type_0003/page_0001.json', response, true)
    ],
    'destination'
  );
  assert.equal(result.raw_pages?.['responses/type_0003/page_0001.json'], response);
  assert.equal(Object.keys(result.raw_pages || {}).length, 2);
});

test('native Exilium v2 and recovered data-store v1 retain duplicate occurrences and oldest-first order', async () => {
  const input = store({ one: profile('one', [row(10), row(10), row(20)]) });
  for (const value of [input, nativeBackup(input)]) {
    const selected = [file('exilium-backup.json', value)];
    assert.deepEqual(await inspectExiliumProfiles(selected), [{ id: 'one', name: 'Profile one' }]);
    const converted = (await readExport(selected, 'destination')).records_document;
    assert.deepEqual(
      (converted.records as { record: { item: number } }[]).map((entry) => entry.record.item),
      [10, 10, 20]
    );
    assert.equal((converted.external_source as { source: string }).source, 'https://exilium.xyz');
    assert.equal(converted.account_fingerprint, undefined);
    assert.equal(converted.endpoint_host, undefined);
  }
});

test('multi-profile Exilium requires explicit source selection independently of destination', async () => {
  const input = [
    file(
      'backup.json',
      nativeBackup(
        store({ one: profile(), two: profile('two', [row(99)]) } as ReturnType<
          typeof store
        >['state']['profilesData'])
      )
    )
  ];
  await assert.rejects(readExport(input, 'destination'), /Select an Exilium source profile/);
  const result = await readExport(input, 'destination', 'two');
  assert.equal(result.profile_id, 'destination');
  assert.equal(
    (result.records_document.records as { record: { item: number } }[])[0].record.item,
    99
  );
  await assert.rejects(readExport(input, 'destination', 'missing'), /not in this backup/);
});

test('Exilium does not guess legacy versions, corrupt compression, or unknown envelopes', async () => {
  await assert.rejects(
    decodeExilium({ version: 1, data: '{}', compressed: false }),
    /Unsupported Exilium backup version/
  );
  await assert.rejects(decodeExilium({ ...nativeBackup(store()), version: 3 }), /Unsupported/);
  await assert.rejects(decodeExilium({ ...nativeBackup(store()), data: 'not base64!' }), /damaged/);
  await assert.rejects(
    decodeExilium(nativeBackup({ ...store(), version: 2 })),
    /data-store version/
  );
});

test('mixed identities and reordered Exilium records fail before producing an import', async () => {
  await assert.rejects(
    readExport(
      [
        file(
          'backup.json',
          store({ one: profile('one', [row(), { ...row(), uid: 'other-account' }]) })
        )
      ],
      'destination'
    ),
    /multiple accounts/
  );
  await assert.rejects(
    readExport(
      [file('backup.json', store({ one: profile('one', [row(10, 100), row(20, 99)]) }))],
      'destination'
    ),
    /oldest-first/
  );
});

test('credentials in retained metadata and raw receipts are rejected, including compressed payloads', async () => {
  await assert.rejects(
    readExport([file('records.json', { schema_version: 1, metadata: { token: 'secret' } })], 'p'),
    /credentials/
  );
  await assert.rejects(
    readExport(
      [
        file('records.json', {}),
        file('responses/type_3/page_1.json', { data: { authorization: 'hidden' } })
      ],
      'p'
    ),
    /credentials/
  );
  const source = store();
  Object.assign(source.state.profilesData.one, { metadata: { access_token: 'secret' } });
  await assert.rejects(readExport([file('backup.json', nativeBackup(source))], 'p'), /credentials/);
  await assert.rejects(
    readExport([file('records.json', { note: 'https://example.test/?token=secret' })], 'p'),
    /credentials/
  );
});

test('deep JSON and path traversal are rejected', async () => {
  let nested: unknown = {};
  for (let i = 0; i < 55; i++) nested = { child: nested };
  await assert.rejects(readExport([file('records.json', nested)], 'p'), /nested too deeply/);
  await assert.rejects(
    readExport([file('run/records.json', {}), file('run/responses/../page.json', {})], 'p'),
    /invalid file path/
  );
  await assert.rejects(
    readExport([file('records.json', {}), file('responses/type_3/page_1.json:extra', {})], 'p'),
    /invalid file path/
  );
});

test('compressed Exilium expansion is capped before JSON parsing', async () => {
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)).toString('base64');
  await assert.rejects(
    decodeExilium({ version: 2, compressed: true, timestamp: 1770000000000, data: bomb }),
    /64 MiB expanded limit/
  );
});
