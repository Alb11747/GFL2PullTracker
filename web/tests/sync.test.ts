import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createDriveSync, type SyncStore } from '../src/lib/sync/controller.ts';
import { canonical, reconcile } from '../src/lib/sync/reconcile.ts';
import {
  createDriveTransport,
  digest,
  DriveError,
  DRIVE_SCOPE,
  type Revision,
  type RevisionTransport
} from '../src/lib/sync/drive.ts';
import {
  emptyState,
  identityKey,
  type PortableProfile,
  type PortableState,
  type SourceSnapshot
} from '../src/lib/local/types.ts';
import { LocalEngine, validateState, digest as archiveDigest } from '../src/lib/local/engine.ts';
import { encodeBackup, decodeBackup } from '../src/lib/local/backup.ts';

const time = '2026-09-20T10:00:00.000Z';
function snapshot(digest: string): SourceSnapshot {
  return {
    id: digest,
    digest,
    document: { schema_version: 1, records: [] },
    manifest: null,
    raw_pages: null,
    imported_at: time
  };
}
function profile(name = 'Account', snapshots = [snapshot('first')]): PortableProfile {
  return {
    id: 'profile-one',
    aliases: ['profile-one'],
    name,
    account_fingerprint: 'account-one',
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    server: '1',
    game_channel_id: '1',
    created_at: time,
    updated_at: time,
    snapshots
  };
}
function state(profiles = [profile()]): PortableState {
  return { ...emptyState(), profiles };
}
function memoryStore(initial: PortableState) {
  let current = structuredClone(initial);
  let revision = 0;
  const listeners = new Set<() => void>();
  const store: SyncStore & { edit(next: PortableState): void; beforeReplace?: () => void } = {
    async revision() {
      return revision;
    },
    async validateState(next) {
      return structuredClone(next);
    },
    async exportState() {
      return structuredClone(current);
    },
    async replaceState(next, expected) {
      store.beforeReplace?.();
      if (expected && canonical(expected) !== canonical(current))
        throw new Error('Local history changed during sync. Retry sync.');
      current = structuredClone(next);
      revision++;
      for (const listener of listeners) listener();
      return structuredClone(current);
    },
    async encodeBackup(next) {
      return new TextEncoder().encode(canonical(next));
    },
    async decodeBackup(bytes) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        const error = new Error('Invalid archive JSON.');
        error.name = 'InvalidBackupError';
        throw error;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(next) {
      current = structuredClone(next);
      revision++;
      for (const listener of listeners) listener();
    }
  };
  return store;
}
function cloud() {
  const files = new Map<string, { revision: Revision; bytes: Uint8Array }>();
  let failUpload: Error | null = null;
  let committedButUnconfirmed = false;
  let uploads = 0;
  const transport: RevisionTransport = {
    async delete(fileId) {
      files.delete(fileId);
    },
    async list() {
      return [...files.values()].map((file) => structuredClone(file.revision));
    },
    async download(revision) {
      return files.get(revision.id)!.bytes;
    },
    async upload(revision, bytes) {
      uploads++;
      if (failUpload) throw failUpload;
      files.set(revision.id, {
        revision: { ...structuredClone(revision), fileId: revision.id, contentVersion: '1' },
        bytes
      });
      if (committedButUnconfirmed) {
        committedButUnconfirmed = false;
        throw new Error('Connection lost after upload');
      }
      return { fileId: revision.id, contentVersion: '1' };
    }
  };
  return {
    files,
    transport,
    get uploads() {
      return uploads;
    },
    set fail(value: Error | null) {
      failUpload = value;
    },
    interruptUpload() {
      committedButUnconfirmed = true;
    }
  };
}
function client(store: SyncStore, transport: RevisionTransport) {
  return createDriveSync({
    store,
    transport,
    clientId: 'test-client',
    authorize: async () => ({ token: 'secret-google-token', expiresIn: 3600 })
  });
}

test('snapshot union retains duplicate occurrences within each immutable source and never syncs consent settings', () => {
  const duplicateSource = snapshot('duplicates');
  duplicateSource.document = { records: [{ id: 1 }, { id: 1 }] };
  const local = state([profile('Account', [duplicateSource])]);
  local.settings = {
    theme: 'dark',
    saveServerBackup: true,
    contribute: true,
    access_token: 'secret'
  };
  const merged = reconcile(
    local,
    state([profile('Account', [duplicateSource, snapshot('incremental')])])
  ).state;
  assert.equal(merged.profiles[0].snapshots.length, 2);
  assert.equal((merged.profiles[0].snapshots[0].document.records as unknown[]).length, 2);
  assert.deepEqual(merged.settings, { theme: 'dark' });
});

test('full identity matches independently created profiles while partial identities stay separate', () => {
  const left = state();
  const right = state();
  right.profiles[0].id = 'other-device';
  right.profiles[0].aliases = ['other-device'];
  assert.equal(reconcile(left, right).state.profiles.length, 1);
  left.profiles[0].server = null;
  right.profiles[0].server = null;
  assert.equal(reconcile(left, right).state.profiles.length, 2);
});

test('causal renames merge; simultaneous rename and incompatible identity require explicit choices', () => {
  const base = state();
  const local = state([profile('Alice')]);
  const remote = state([profile('Bob')]);
  assert.equal(reconcile(local, base, base).state.profiles[0].name, 'Alice');
  const conflict = reconcile(local, remote, base);
  assert.equal(conflict.conflicts[0].kind, 'rename');
  assert.equal(
    reconcile(local, remote, base, {
      [conflict.conflicts[0].id]: {
        choice: 'remote',
        fingerprint: conflict.conflicts[0].fingerprint
      }
    }).state.profiles[0].name,
    'Bob'
  );
  remote.profiles[0].account_fingerprint = 'other-account';
  assert.equal(reconcile(local, remote, base).conflicts[0].kind, 'identity');
});

test('transitive ID and identity matches never combine histories of incompatible accounts', () => {
  const first = profile('First', [snapshot('first-account')]);
  const other = profile('Second', [snapshot('second-account')]);
  other.id = 'profile-two';
  other.aliases = ['profile-two'];
  other.account_fingerprint = 'account-two';
  const spoof = structuredClone(other);
  spoof.id = first.id;
  spoof.aliases = [first.id];
  const local = state([first, other]);
  const remote = state([spoof]);
  const pending = reconcile(local, remote);
  assert.equal(pending.conflicts[0].kind, 'identity');
  const resolved = reconcile(local, remote, emptyState(), {
    [pending.conflicts[0].id]: { choice: 'local', fingerprint: pending.conflicts[0].fingerprint }
  });
  assert.equal(resolved.state.profiles.length, 2);
  assert.deepEqual(
    resolved.state.profiles.map((p) => p.snapshots.map((s) => s.digest)),
    [['first-account'], ['second-account']]
  );
});

test('multiple local profiles of one complete account retain every source snapshot during sync', () => {
  const one = profile('Account', [snapshot('one')]);
  const two = profile('Account', [snapshot('two')]);
  two.id = 'profile-two';
  two.aliases = ['profile-two'];
  const result = reconcile(state([one, two]), emptyState());
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(
    result.state.profiles[0].snapshots.map((s) => s.digest),
    ['one', 'two']
  );
});

test('deletion propagates to unchanged profiles and conflicts with concurrent edits', () => {
  const base = state();
  const deleted = emptyState();
  deleted.tombstones = [
    {
      profile_id: base.profiles[0].id,
      aliases: [base.profiles[0].id],
      identity: identityKey(base.profiles[0]),
      deleted_at: time
    }
  ];
  assert.equal(reconcile(base, deleted, base).state.profiles.length, 0);
  const edited = state([profile('Edited')]);
  const pending = reconcile(edited, deleted, base);
  assert.equal(pending.conflicts[0].kind, 'delete-edit');
  const resolved = reconcile(edited, deleted, base, {
    [pending.conflicts[0].id]: { choice: 'local', fingerprint: pending.conflicts[0].fingerprint }
  });
  assert.equal(resolved.state.profiles[0].name, 'Edited');
  assert.deepEqual(resolved.state.tombstones, []);
});

test('two offline devices publish branches and converge by merging immutable source histories', async () => {
  const drive = cloud();
  const a = memoryStore(state());
  const b = memoryStore(emptyState());
  const first = client(a, drive.transport);
  const second = client(b, drive.transport);
  try {
    await first.connect();
    await second.connect();
    assert.equal((await b.exportState()).profiles.length, 1, 'fresh-device recovery');
    a.edit(state([profile('Account', [snapshot('first'), snapshot('from-a')])]));
    b.edit(state([profile('Account', [snapshot('first'), snapshot('from-b')])]));
    await Promise.all([first.sync(), second.sync()]);
    assert.equal(drive.files.size, 3, 'both devices publish a child of the initial revision');
    await first.sync();
    await second.sync();
    assert.equal(first.status.phase, 'synced');
    assert.equal(second.status.phase, 'synced');
    assert.deepEqual(
      (await a.exportState()).profiles[0].snapshots.map((s) => s.digest),
      ['first', 'from-a', 'from-b']
    );
    assert.equal(canonical(await a.exportState()), canonical(await b.exportState()));
    assert.ok([...drive.files.values()].some((file) => file.revision.parents.length === 2));
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('real gzip archives restore duplicate pulls and overlapping sources through the browser engine', async () => {
  const engine = new LocalEngine();
  const account = engine.createProfile('Commander');
  const row = {
    source_type_id: 3,
    source_page: 1,
    record: { item: 11007, pool_id: 224001, item_num: 1, time: 1784800558 }
  };
  await engine.importRecords({
    profile_id: account.id,
    records_document: { schema_version: 1, exported_at: time, records: [row, row] }
  });
  const drive = cloud();
  const firstStore = memoryStore(engine.exportState());
  firstStore.validateState = validateState;
  firstStore.encodeBackup = encodeBackup;
  firstStore.decodeBackup = decodeBackup;
  const secondStore = memoryStore(emptyState());
  secondStore.validateState = validateState;
  secondStore.encodeBackup = encodeBackup;
  secondStore.decodeBackup = decodeBackup;
  const first = client(firstStore, drive.transport);
  const second = client(secondStore, drive.transport);
  try {
    await first.connect();
    const stored = [...drive.files.values()][0].bytes;
    assert.deepEqual([...stored.slice(0, 2)], [0x1f, 0x8b]);
    await second.connect();
    assert.equal(second.status.phase, 'synced');
    const recovered = new LocalEngine(await secondStore.exportState());
    const duplicate = await recovered.importRecords({
      profile_id: account.id,
      records_document: {
        schema_version: 1,
        exported_at: '2026-09-21T10:00:00.000Z',
        records: [row, row]
      }
    });
    assert.equal(duplicate.total, 2);
    assert.equal(duplicate.added_count, 0);
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('simultaneous rename conflicts preserve local data until resolved explicitly', async () => {
  const drive = cloud();
  const a = memoryStore(state());
  const b = memoryStore(emptyState());
  const first = client(a, drive.transport);
  const second = client(b, drive.transport);
  try {
    await first.connect();
    await second.connect();
    a.edit(state([profile('Alice')]));
    b.edit(state([profile('Bob')]));
    await Promise.all([first.sync(), second.sync()]);
    const before = canonical(await a.exportState());
    await first.sync();
    assert.equal(first.status.phase, 'conflict');
    assert.equal(canonical(await a.exportState()), before);
    for (let attempt = 0; attempt < 4 && first.status.phase === 'conflict'; attempt++) {
      await first.resolve({
        generation: first.status.resolutionGeneration,
        choices: Object.fromEntries(first.status.conflicts.map((c) => [c.id, 'local' as const]))
      });
    }
    assert.equal(first.status.phase, 'synced');
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('two-device concurrent deletion and offline edit require a choice before applying either branch', async () => {
  const drive = cloud();
  const a = memoryStore(state());
  const b = memoryStore(emptyState());
  const first = client(a, drive.transport);
  const second = client(b, drive.transport);
  try {
    await first.connect();
    await second.connect();
    const deleted = emptyState();
    deleted.tombstones = [
      {
        profile_id: 'profile-one',
        aliases: ['profile-one'],
        identity: identityKey(profile()),
        deleted_at: time
      }
    ];
    a.edit(deleted);
    b.edit(state([profile('Edited offline')]));
    await Promise.all([first.sync(), second.sync()]);
    await second.sync();
    assert.equal(second.status.phase, 'conflict');
    assert.ok(second.status.conflicts.some((conflict) => conflict.kind === 'delete-edit'));
    assert.equal((await b.exportState()).profiles[0].name, 'Edited offline');
    for (let attempt = 0; attempt < 4 && second.status.phase === 'conflict'; attempt++) {
      await second.resolve({
        generation: second.status.resolutionGeneration,
        choices: Object.fromEntries(
          second.status.conflicts.map((conflict) => [
            conflict.id,
            conflict.localLabel.startsWith('Keep ') ? ('local' as const) : ('remote' as const)
          ])
        )
      });
    }
    assert.equal(second.status.phase, 'synced');
    assert.equal((await b.exportState()).profiles[0].name, 'Edited offline');
    assert.deepEqual((await b.exportState()).tombstones, []);
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('upload quota and uncertain upload leave local data safe and explicit retry discovers committed revision', async () => {
  const drive = cloud();
  const store = memoryStore(state());
  const sync = client(store, drive.transport);
  try {
    drive.fail = new DriveError('quota', 'Storage quota exceeded');
    await sync.connect();
    assert.equal(sync.status.phase, 'error');
    assert.equal((await store.exportState()).profiles.length, 1);
    drive.fail = null;
    drive.interruptUpload();
    await sync.sync();
    assert.equal(sync.status.phase, 'error');
    assert.equal(drive.files.size, 1);
    const uploads = drive.uploads;
    await sync.sync();
    assert.equal(sync.status.phase, 'synced');
    assert.equal(drive.uploads, uploads, 'confirmed upload is not submitted twice');
  } finally {
    sync.destroy();
  }
});

test('revoked authorization pauses sync and never erases local data', async () => {
  const store = memoryStore(state());
  const drive = cloud();
  const sync = client(store, {
    ...drive.transport,
    async list() {
      throw new DriveError('reconnect', 'Reconnect');
    }
  });
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'reconnect');
    assert.equal((await store.exportState()).profiles.length, 1);
  } finally {
    sync.destroy();
  }
});

test('corrupted archives are deleted and missing parents preserve healthy local data', async () => {
  const drive = cloud();
  const store = memoryStore(state());
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    const file = [...drive.files.values()][0];
    file.bytes = new TextEncoder().encode('corrupt');
    sync.disconnect();
    await sync.connect();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.equal((await store.exportState()).profiles.length, 1);
    assert.ok(!drive.files.has(file.revision.id));
    const replacement = [...drive.files.values()][0];
    replacement.revision.parents = ['missing'];
    await sync.sync();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
  } finally {
    sync.destroy();
  }
});

test('long histories audit every file once and only cycle members are removed', async () => {
  const store = memoryStore(state());
  const bytes = await store.encodeBackup(state());
  const sha256 = await digest(bytes);
  let revisions: Revision[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `revision-${index}`,
    fileId: `file-${index}`,
    contentVersion: '1',
    parents: index ? [`revision-${index - 1}`] : [],
    createdAt: time,
    sha256
  }));
  let downloads = 0;
  const transport: RevisionTransport = {
    async delete(fileId) {
      revisions = revisions.filter((item) => item.fileId !== fileId);
    },
    async list() {
      return revisions;
    },
    async download() {
      downloads++;
      return bytes;
    },
    async upload() {
      throw new Error('Unchanged history must not upload');
    }
  };
  const sync = client(store, transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'synced');
    assert.equal(downloads, 2000, 'Every unseen physical file is audited before reporting success');
    await sync.sync();
    assert.equal(downloads, 2000, 'Unchanged generations never download again');
    revisions = [
      { id: 'a', fileId: 'a', contentVersion: '1', parents: ['b'], createdAt: time, sha256 },
      { id: 'b', fileId: 'b', contentVersion: '1', parents: ['a'], createdAt: time, sha256 },
      {
        id: 'healthy',
        fileId: 'healthy',
        contentVersion: '1',
        parents: ['a'],
        createdAt: time,
        sha256
      }
    ];
    await sync.sync();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.deepEqual(
      revisions.map((item) => item.id),
      ['healthy']
    );
    assert.equal((await store.exportState()).profiles.length, 1);
  } finally {
    sync.destroy();
  }
});

test('local edits during commit fail compare-and-swap rather than being overwritten', async () => {
  const drive = cloud();
  const seed = client(memoryStore(state()), drive.transport);
  await seed.connect();
  seed.destroy();
  const store = memoryStore(emptyState());
  store.beforeReplace = () => {
    store.beforeReplace = undefined;
    store.edit(state([profile('My latest edit')]));
  };
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'error');
    assert.equal((await store.exportState()).profiles[0].name, 'My latest edit');
  } finally {
    sync.destroy();
  }
});

test('Drive transport uses appDataFolder scope, bearer headers and immutable multipart upload without ambient cookies', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    return Response.json(
      init.method === 'POST' ? { id: 'new-file', version: '1', size: '12' } : { files: [] }
    );
  }) as typeof fetch;
  const transport = createDriveTransport(() => 'test-secret', fetcher);
  await transport.list();
  const bytes = new TextEncoder().encode('gzip-content');
  await transport.upload(
    { id: 'revision', parents: [], sha256: await digest(bytes), createdAt: time },
    bytes
  );
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.appdata');
  assert.match(requests[0].url, /spaces=appDataFolder/);
  for (const request of requests) {
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'error');
    assert.equal(
      (request.init.headers as Record<string, string>).Authorization,
      'Bearer test-secret'
    );
    assert.ok(!request.url.includes('test-secret'));
  }
  const body = await (requests[1].init.body as Blob).text();
  assert.match(body, /appDataFolder/);
  assert.ok(!body.includes('test-secret'));
  assert.equal(requests[1].init.method, 'POST');
});

test('Drive transport rejects oversized downloads and deletes owned invalid metadata', async () => {
  const oversize = createDriveTransport(
    () => 'test',
    (async () =>
      new Response('x', {
        headers: { 'content-length': String(100 * 1024 * 1024) }
      })) as typeof fetch
  );
  await assert.rejects(
    oversize.download({
      id: 'revision',
      fileId: 'file',
      contentVersion: '1',
      parents: [],
      createdAt: time,
      sha256: '0'.repeat(64)
    }),
    /size limit/
  );
  const deleted: string[] = [];
  const invalid = createDriveTransport(() => 'test', (async (url, init) => {
    if (init?.method === 'DELETE') {
      deleted.push(String(url));
      return new Response(null, { status: 204 });
    }
    return Response.json({
      files: [
        {
          id: 'file',
          description: '{}',
          appProperties: { tracker: 'gfl2-v1' },
          version: '1',
          size: '1'
        }
      ]
    });
  }) as typeof fetch);
  assert.deepEqual(await invalid.list(), []);
  assert.deepEqual(deleted, ['https://www.googleapis.com/drive/v3/files/file']);
});

async function seedRevision(
  drive: ReturnType<typeof cloud>,
  id: string,
  archive: PortableState,
  parents: string[] = [],
  encode: (archive: PortableState) => Promise<Uint8Array> = async (value) =>
    new TextEncoder().encode(canonical(value))
) {
  const bytes = await encode(archive);
  drive.files.set(id, {
    revision: {
      id,
      fileId: id,
      contentVersion: '1',
      parents,
      createdAt: time,
      sha256: await digest(bytes)
    },
    bytes
  });
}

async function resolveAll(sync: ReturnType<typeof client>, choice: 'local' | 'remote') {
  assert.equal(sync.status.phase, 'conflict');
  await sync.resolve({
    generation: sync.status.resolutionGeneration,
    choices: Object.fromEntries(sync.status.conflicts.map((conflict) => [conflict.id, choice]))
  });
}

test('remote rename choices survive successive cloud-branch and device conflict dialogs', async () => {
  const drive = cloud();
  await seedRevision(drive, 'root', state());
  await seedRevision(drive, 'a', state([profile('Alice')]), ['root']);
  await seedRevision(drive, 'b', state([profile('Bob')]), ['root']);
  const store = memoryStore(state([profile('Alice')]));
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    for (let attempt = 0; attempt < 3 && sync.status.phase === 'conflict'; attempt++)
      await resolveAll(sync, 'remote');
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.equal((await store.exportState()).profiles[0].name, 'Bob');
    const uploads = drive.uploads;
    await sync.sync();
    assert.equal(sync.status.phase, 'synced');
    assert.equal((await store.exportState()).profiles[0].name, 'Bob');
    assert.equal(drive.uploads, uploads);
  } finally {
    sync.destroy();
  }
});

test('a deletion decision is invalidated when an import arrives during the next cloud read', async () => {
  const drive = cloud();
  const deleted = emptyState();
  deleted.tombstones = [
    {
      profile_id: 'profile-one',
      aliases: ['profile-one'],
      identity: identityKey(profile()),
      deleted_at: time
    }
  ];
  await seedRevision(drive, 'root', state());
  await seedRevision(drive, 'deleted', deleted, ['root']);
  const store = memoryStore(state([profile('Edited offline')]));
  let duringRead: (() => void) | undefined;
  const sync = client(store, {
    ...drive.transport,
    async list() {
      await Promise.resolve();
      duringRead?.();
      duringRead = undefined;
      return drive.transport.list();
    }
  });
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'conflict');
    const generation = sync.status.resolutionGeneration;
    duringRead = () =>
      store.edit(state([profile('Edited offline', [snapshot('first'), snapshot('new-import')])]));
    await resolveAll(sync, 'remote');
    assert.equal(sync.status.phase, 'conflict');
    assert.notEqual(sync.status.resolutionGeneration, generation);
    assert.deepEqual(
      (await store.exportState()).profiles[0].snapshots.map((item) => item.digest),
      ['first', 'new-import']
    );
    assert.equal(drive.uploads, 0);
    await resolveAll(sync, 'remote');
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.equal((await store.exportState()).profiles.length, 0);
  } finally {
    sync.destroy();
  }
});

test('stale dialog generations and reconnects never reuse an earlier decision', async () => {
  const drive = cloud();
  await seedRevision(drive, 'bob', state([profile('Bob')]));
  const store = memoryStore(state([profile('Alice')]));
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    const original = sync.status;
    assert.equal(original.phase, 'conflict');
    await sync.sync();
    assert.notEqual(sync.status.resolutionGeneration, original.resolutionGeneration);
    await sync.resolve({
      generation: original.resolutionGeneration,
      choices: Object.fromEntries(original.conflicts.map((conflict) => [conflict.id, 'remote']))
    });
    assert.equal(sync.status.phase, 'conflict');
    assert.equal((await store.exportState()).profiles[0].name, 'Alice');
    assert.equal(drive.uploads, 0);
    const beforeReconnect = sync.status;
    sync.disconnect();
    await sync.connect();
    await sync.resolve({
      generation: beforeReconnect.resolutionGeneration,
      choices: Object.fromEntries(
        beforeReconnect.conflicts.map((conflict) => [conflict.id, 'remote'])
      )
    });
    assert.equal(sync.status.phase, 'conflict');
    await resolveAll(sync, 'remote');
    assert.equal(sync.status.phase, 'synced');
    assert.equal((await store.exportState()).profiles[0].name, 'Bob');
  } finally {
    sync.destroy();
  }
});

test('concurrent portable settings converge and stop uploading, including after reconnect', async () => {
  const drive = cloud();
  const initial = state();
  initial.settings = { theme: 'system', locale: 'en', page_size: 20 };
  const a = memoryStore(initial);
  const b = memoryStore(emptyState());
  const first = client(a, drive.transport);
  const second = client(b, drive.transport);
  try {
    await first.connect();
    await second.connect();
    const left = await a.exportState();
    left.settings = { theme: 'dark', locale: 'ja', page_size: 50 };
    const right = await b.exportState();
    right.settings = { theme: 'light', locale: 'ko', page_size: 100 };
    a.edit(left);
    b.edit(right);
    await Promise.all([first.sync(), second.sync()]);
    await first.sync();
    assert.equal(first.status.phase, 'conflict');
    assert.ok(first.status.conflicts.every((conflict) => conflict.kind === 'setting'));
    for (let attempt = 0; attempt < 3 && first.status.phase === 'conflict'; attempt++) {
      await first.resolve({
        generation: first.status.resolutionGeneration,
        choices: Object.fromEntries(
          first.status.conflicts.map((conflict) => [
            conflict.id,
            ['dark', 'ja', '50'].includes(conflict.localLabel) ? 'local' : 'remote'
          ])
        )
      });
    }
    assert.equal(first.status.phase, 'synced', first.status.message);
    await second.sync();
    assert.equal(second.status.phase, 'synced', second.status.message);
    assert.deepEqual((await b.exportState()).settings, left.settings);
    const uploads = drive.uploads;
    for (let attempt = 0; attempt < 3; attempt++) {
      await first.sync();
      await second.sync();
    }
    first.disconnect();
    second.disconnect();
    await first.connect();
    await second.connect();
    assert.equal(first.status.phase, 'synced');
    assert.equal(second.status.phase, 'synced');
    assert.equal(drive.uploads, uploads);
    assert.equal(canonical(await a.exportState()), canonical(await b.exportState()));
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('an import immediately after the resolution snapshot cannot be deleted by the accepted stale choice', async () => {
  const drive = cloud();
  const deleted = emptyState();
  deleted.tombstones = [
    {
      profile_id: 'profile-one',
      aliases: ['profile-one'],
      identity: identityKey(profile()),
      deleted_at: time
    }
  ];
  await seedRevision(drive, 'root', state());
  await seedRevision(drive, 'deleted', deleted, ['root']);
  const store = memoryStore(state([profile('Edited offline')]));
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'conflict');
    const originalExport = store.exportState;
    let injectImport = true;
    store.exportState = async () => {
      const snapshot = await originalExport();
      if (injectImport) {
        injectImport = false;
        // The caller receives its old snapshot, but the archive changes before
        // its next continuation. This reproduces the original two-export gap.
        queueMicrotask(() =>
          store.edit(
            state([
              profile('Edited offline', [
                ...snapshot.profiles[0].snapshots,
                { ...snapshot.profiles[0].snapshots[0], id: 'new-import', digest: 'new-import' }
              ])
            ])
          )
        );
      }
      return snapshot;
    };
    await resolveAll(sync, 'remote');
    assert.ok(['error', 'conflict'].includes(sync.status.phase), sync.status.message);
    const saved = await store.exportState();
    assert.equal(saved.profiles.length, 1);
    assert.deepEqual(
      saved.profiles[0].snapshots.map((item) => item.digest),
      ['first', 'new-import']
    );
    assert.equal(drive.uploads, 0, 'a stale deletion must never reach Drive');
  } finally {
    sync.destroy();
  }
});

test('unchanged sync performs no archive export, merge validation, download, or upload', async () => {
  const drive = cloud();
  const store = memoryStore(state());
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    const uploaded = drive.uploads;
    store.exportState = async () => {
      throw new Error('Unexpected full export');
    };
    store.validateState = async () => {
      throw new Error('Unexpected validation');
    };
    store.encodeBackup = async () => {
      throw new Error('Unexpected compression');
    };
    drive.transport.download = async () => {
      throw new Error('Unexpected download');
    };
    await sync.sync();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.equal(drive.uploads, uploaded);
  } finally {
    sync.destroy();
  }
});

test('a corrupt non-head is removed without deleting its healthy descendant', async () => {
  const drive = cloud();
  await seedRevision(drive, 'old', state());
  await seedRevision(drive, 'healthy', state(), ['old']);
  drive.files.get('old')!.bytes = new TextEncoder().encode('corrupted');
  const sync = client(memoryStore(state()), drive.transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.ok(!drive.files.has('old'));
    assert.ok(drive.files.has('healthy'));
    assert.equal(drive.uploads, 0);
  } finally {
    sync.destroy();
  }
});

test('payload corruption removes the file but network and worker failures never do', async () => {
  for (const error of [
    new DriveError('network', 'offline'),
    new Error('The local worker stopped')
  ]) {
    const drive = cloud();
    await seedRevision(drive, 'healthy', state());
    const store = memoryStore(state());
    if (error instanceof DriveError)
      drive.transport.download = async () => {
        throw error;
      };
    else
      store.decodeBackup = async () => {
        throw error;
      };
    const sync = client(store, drive.transport);
    try {
      await sync.connect();
      assert.equal(sync.status.phase, 'error');
      assert.ok(drive.files.has('healthy'));
      assert.equal(drive.uploads, 0);
    } finally {
      sync.destroy();
    }
  }
});

test('failed corrupt-file deletion leaves local state intact and blocks publication', async () => {
  const drive = cloud();
  await seedRevision(drive, 'bad', state());
  drive.files.get('bad')!.bytes = new Uint8Array([0]);
  drive.transport.delete = async () => {
    throw new DriveError('quota', 'Deletion denied');
  };
  const store = memoryStore(state());
  const original = canonical(await store.exportState());
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'error');
    assert.equal(canonical(await store.exportState()), original);
    assert.ok(drive.files.has('bad'));
    assert.equal(drive.uploads, 0);
  } finally {
    sync.destroy();
  }
});

function driveMetadata(id: string, revision = id, extra: Record<string, unknown> = {}) {
  return {
    id,
    appProperties: { tracker: 'gfl2', revision },
    version: '1',
    size: '100',
    description: JSON.stringify({
      format: 'gfl2-drive-revision',
      id: revision,
      parents: [],
      createdAt: time,
      sha256: 'a'.repeat(64),
      ...extra
    })
  };
}

test('versioned app files are deleted only after the entire listing validates', async () => {
  for (const malformed of [false, true]) {
    const deleted: string[] = [];
    let page = 0;
    const transport = createDriveTransport(() => 'token', (async (url, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(url));
        return new Response(null, { status: 204 });
      }
      page++;
      if (page === 1)
        return Response.json({
          files: [
            {
              ...driveMetadata('old', 'old', { version: 2 }),
              appProperties: { tracker: 'gfl2-v1', revision: 'old' }
            }
          ],
          nextPageToken: 'next'
        });
      return Response.json(malformed ? { files: null } : { files: [driveMetadata('healthy')] });
    }) as typeof fetch);
    if (malformed) {
      await assert.rejects(transport.list(), /invalid revision metadata/);
      assert.equal(deleted.length, 0);
    } else {
      assert.deepEqual(
        (await transport.list()).map((item) => item.id),
        ['healthy']
      );
      assert.equal(deleted.length, 1);
      assert.ok(deleted[0].endsWith('/old'));
    }
  }
});

test('conflicting revision IDs remove all conflicting copies and preserve unrelated files', async () => {
  const deleted: string[] = [];
  const transport = createDriveTransport(() => 'token', (async (url, init) => {
    if (init?.method === 'DELETE') {
      deleted.push(String(url).split('/').at(-1)!);
      return new Response(null, { status: 204 });
    }
    return Response.json({
      files: [
        driveMetadata('a', 'same'),
        driveMetadata('b', 'same', { sha256: 'b'.repeat(64) }),
        driveMetadata('healthy')
      ]
    });
  }) as typeof fetch);
  assert.deepEqual(
    (await transport.list()).map((item) => item.id),
    ['healthy']
  );
  assert.deepEqual(deleted.sort(), ['a', 'b']);
});

test('unowned file metadata and invalid list responses never authorize deletion', async () => {
  const deleted: string[] = [];
  const transport = createDriveTransport(() => 'token', (async (url, init) => {
    if (init?.method === 'DELETE') {
      deleted.push(String(url));
      return new Response(null, { status: 204 });
    }
    return Response.json({
      files: [driveMetadata('old', 'old', { version: 1 }), { id: 'foreign', description: '{}' }]
    });
  }) as typeof fetch);
  await assert.rejects(transport.list(), /outside this tracker/);
  assert.deepEqual(deleted, []);
});

test('identical metadata copies stay visible so neither payload escapes validation', async () => {
  const transport = createDriveTransport(() => 'token', (async () =>
    Response.json({
      files: [driveMetadata('a', 'same'), driveMetadata('b', 'same')]
    })) as typeof fetch);
  assert.deepEqual(
    (await transport.list()).map((item) => item.fileId),
    ['a', 'b']
  );
});

test('a committed delete whose response was lost can be retried safely after relisting', async () => {
  const transport = createDriveTransport(
    () => 'token',
    (async () => new Response(null, { status: 404 })) as typeof fetch
  );
  await transport.delete('already-gone');
});

test('current aliases prevent an offline partial profile from resurrecting a deleted merged account', async () => {
  const drive = cloud();
  const old = profile('Account', []);
  old.id = 'z-offline';
  old.aliases = ['z-offline'];
  old.server = null;
  const deleted = emptyState();
  deleted.tombstones = [
    {
      profile_id: 'a-canonical',
      aliases: ['a-canonical', 'z-offline'],
      identity: identityKey(profile()),
      deleted_at: time
    }
  ];
  await seedRevision(drive, 'deleted', deleted);
  const store = memoryStore(state([old]));
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    if (sync.status.phase === 'conflict') await resolveAll(sync, 'remote');
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    const saved = await store.exportState();
    assert.equal(saved.profiles.length, 0);
    assert.deepEqual(saved.tombstones[0].aliases, ['a-canonical', 'z-offline']);
  } finally {
    sync.destroy();
  }
});

test('invalid gzip, backup versions, and archive structure are deleted using real backup validation', async () => {
  const account = profile('Account', []);
  account.account_fingerprint = `sha256:${'a'.repeat(64)}`;
  const original = state([account]);
  const envelope = {
    format: 'gfl2-pull-tracker-backup',
    sha256: await archiveDigest(original),
    state: original
  };
  const payloads = [
    new Uint8Array([0x1f, 0x8b, 0]),
    gzipSync(JSON.stringify({ ...envelope, version: 2 })),
    gzipSync(JSON.stringify({ ...envelope, state: { ...original, profiles: 'broken' } })),
    gzipSync(JSON.stringify({ ...envelope, sha256: '0'.repeat(64) }))
  ];
  for (const bytes of payloads) {
    const drive = cloud();
    drive.files.set('bad', {
      revision: {
        id: 'bad',
        fileId: 'bad',
        contentVersion: '1',
        parents: [],
        createdAt: time,
        sha256: await digest(bytes)
      },
      bytes
    });
    const store = memoryStore(original);
    store.decodeBackup = decodeBackup;
    store.encodeBackup = encodeBackup;
    store.validateState = validateState;
    const sync = client(store, drive.transport);
    try {
      await sync.connect();
      assert.equal(sync.status.phase, 'synced', sync.status.message);
      assert.ok(!drive.files.has('bad'));
      assert.equal(canonical(await store.exportState()), canonical(original));
      assert.equal(drive.uploads, 1);
    } finally {
      sync.destroy();
    }
  }
});

test('a malformed pagination cursor never authorizes cleanup queued on that page', async () => {
  let deletes = 0;
  const transport = createDriveTransport(() => 'token', (async (_url, init) => {
    if (init?.method === 'DELETE') {
      deletes++;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      files: [driveMetadata('old', 'old', { version: 2 })],
      nextPageToken: false
    });
  }) as typeof fetch);
  await assert.rejects(transport.list(), /invalid page cursor/);
  assert.equal(deletes, 0);
});

test('conflict fingerprints retain source identity without copying source documents into the dialog', () => {
  const source = snapshot('immutable-digest');
  source.document = { schema_version: 1, records: [], padding: 'x'.repeat(1_000_000) };
  const local = state([profile('Alice', [source])]);
  const remote = state([profile('Bob', [source])]);
  const result = reconcile(local, remote, emptyState());
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.conflicts[0].fingerprint.length < 3000);
  const changed = structuredClone(remote);
  changed.profiles[0].snapshots[0].digest = 'new-immutable-digest';
  assert.notEqual(
    reconcile(local, changed, emptyState()).conflicts[0].fingerprint,
    result.conflicts[0].fingerprint
  );
});

test('a file changing metadata across listing pages delays cleanup until a consistent listing', async () => {
  let deletes = 0;
  let page = 0;
  const transport = createDriveTransport(() => 'token', (async (_url, init) => {
    if (init?.method === 'DELETE') {
      deletes++;
      return new Response(null, { status: 204 });
    }
    page++;
    return Response.json(
      page === 1
        ? { files: [driveMetadata('changing', 'old', { version: 2 })], nextPageToken: 'next' }
        : { files: [driveMetadata('changing', 'new')] }
    );
  }) as typeof fetch);
  await assert.rejects(transport.list(), /metadata changed/);
  assert.equal(deletes, 0);
});

test('a previously audited file changed in place is revalidated using Drive-observed generation', async () => {
  const bytes = new TextEncoder().encode(canonical(state()));
  const sha256 = await digest(bytes);
  const root = driveMetadata('root', 'root', { sha256 });
  const head = driveMetadata('head', 'head', { sha256, parents: ['root'] });
  root.size = head.size = String(bytes.byteLength);
  const files = new Map([
    ['root', { metadata: root, bytes }],
    ['head', { metadata: head, bytes }]
  ]);
  const deleted: string[] = [];
  let downloads = 0;
  const transport = createDriveTransport(() => 'token', (async (input, init) => {
    const url = new URL(String(input));
    const id = url.pathname.split('/').at(-1)!;
    if (init?.method === 'DELETE') {
      deleted.push(id);
      files.delete(id);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get('alt') === 'media') {
      downloads++;
      return new Response(files.get(id)!.bytes);
    }
    assert.notEqual(init?.method, 'POST', 'Healthy head already contains the local archive');
    assert.match(url.searchParams.get('fields') ?? '', /version,size/);
    return Response.json({ files: [...files.values()].map((file) => file.metadata) });
  }) as typeof fetch);
  const sync = client(memoryStore(state()), transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    const originalDescription = root.description;
    const observedDownloads = downloads;
    files.get('root')!.bytes = new Uint8Array([0]);
    root.version = '2';
    root.size = '1';
    await sync.sync();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.equal(root.description, originalDescription);
    assert.equal(downloads, observedDownloads + 1);
    assert.deepEqual(deleted, ['root']);
    assert.ok(files.has('head'));
  } finally {
    sync.destroy();
  }
});

test('all invalid non-head files are removed before sync reports success', async () => {
  const drive = cloud();
  for (let index = 0; index < 17; index++) {
    const id = `bad-${index}`;
    await seedRevision(drive, id, state(), index ? [`bad-${index - 1}`] : []);
    drive.files.get(id)!.bytes = new Uint8Array([0]);
  }
  await seedRevision(drive, 'healthy', state(), ['bad-16']);
  let activeDownloads = 0;
  let maxDownloads = 0;
  const originalDownload = drive.transport.download;
  drive.transport.download = async (revision) => {
    maxDownloads = Math.max(maxDownloads, ++activeDownloads);
    await Promise.resolve();
    try {
      return await originalDownload(revision);
    } finally {
      activeDownloads--;
    }
  };
  const sync = client(memoryStore(state()), drive.transport);
  try {
    await sync.connect();
    assert.equal(sync.status.phase, 'synced', sync.status.message);
    assert.deepEqual([...drive.files.keys()], ['healthy']);
    assert.equal(maxDownloads, 1, 'Full audit bounds in-flight snapshot memory');
    assert.equal(drive.uploads, 0);
  } finally {
    sync.destroy();
  }
});

test('oversized files identified by Drive metadata are deleted without downloading them', async () => {
  const deleted: string[] = [];
  const transport = createDriveTransport(() => 'token', (async (input, init) => {
    const url = new URL(String(input));
    assert.notEqual(url.searchParams.get('alt'), 'media');
    if (init?.method === 'DELETE') {
      deleted.push(url.pathname.split('/').at(-1)!);
      return new Response(null, { status: 204 });
    }
    return Response.json({
      files: [
        { ...driveMetadata('oversized'), size: '999999999999999999' },
        driveMetadata('healthy')
      ]
    });
  }) as typeof fetch);
  assert.deepEqual(
    (await transport.list()).map((revision) => revision.id),
    ['healthy']
  );
  assert.deepEqual(deleted, ['oversized']);
});
