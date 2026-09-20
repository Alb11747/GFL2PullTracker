import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { LocalEngine } from '../src/lib/local/engine.ts';
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
  const listeners = new Set<() => void>();
  const store: SyncStore & { edit(next: PortableState): void; beforeReplace?: () => void } = {
    async exportState() {
      return structuredClone(current);
    },
    async replaceState(next, expected) {
      store.beforeReplace?.();
      if (expected && canonical(expected) !== canonical(current))
        throw new Error('Local history changed during sync. Retry sync.');
      current = structuredClone(next);
      for (const listener of listeners) listener();
      return structuredClone(current);
    },
    async encodeBackup(next) {
      return new TextEncoder().encode(canonical(next));
    },
    async decodeBackup(bytes) {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(next) {
      current = structuredClone(next);
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
        revision: { ...structuredClone(revision), fileId: revision.id },
        bytes
      });
      if (committedButUnconfirmed) {
        committedButUnconfirmed = false;
        throw new Error('Connection lost after upload');
      }
      return revision.id;
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
    reconcile(local, remote, base, { [conflict.conflicts[0].id]: 'remote' }).state.profiles[0].name,
    'Bob'
  );
  remote.profiles[0].account_fingerprint = 'other-account';
  assert.equal(reconcile(local, remote, base).conflicts[0].kind, 'identity');
});

test('transitive ID and identity matches never combine histories of incompatible accounts', () => {
  const first = profile('First', [snapshot('first-account')]);
  const other = profile('Second', [snapshot('second-account')]);
  other.id = 'profile-two';
  other.account_fingerprint = 'account-two';
  const spoof = structuredClone(other);
  spoof.id = first.id;
  const local = state([first, other]);
  const remote = state([spoof]);
  const pending = reconcile(local, remote);
  assert.equal(pending.conflicts[0].kind, 'identity');
  const resolved = reconcile(local, remote, emptyState(), { [pending.conflicts[0].id]: 'local' });
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
    { profile_id: base.profiles[0].id, identity: identityKey(base.profiles[0]), deleted_at: time }
  ];
  assert.equal(reconcile(base, deleted, base).state.profiles.length, 0);
  const edited = state([profile('Edited')]);
  const pending = reconcile(edited, deleted, base);
  assert.equal(pending.conflicts[0].kind, 'delete-edit');
  const resolved = reconcile(edited, deleted, base, { [pending.conflicts[0].id]: 'local' });
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
  firstStore.encodeBackup = encodeBackup;
  firstStore.decodeBackup = decodeBackup;
  const secondStore = memoryStore(emptyState());
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
      await first.resolve(
        Object.fromEntries(first.status.conflicts.map((c) => [c.id, 'local' as const]))
      );
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
      { profile_id: 'profile-one', identity: identityKey(profile()), deleted_at: time }
    ];
    a.edit(deleted);
    b.edit(state([profile('Edited offline')]));
    await Promise.all([first.sync(), second.sync()]);
    await second.sync();
    assert.equal(second.status.phase, 'conflict');
    assert.ok(second.status.conflicts.some((conflict) => conflict.kind === 'delete-edit'));
    assert.equal((await b.exportState()).profiles[0].name, 'Edited offline');
    for (let attempt = 0; attempt < 4 && second.status.phase === 'conflict'; attempt++) {
      await second.resolve(
        Object.fromEntries(
          second.status.conflicts.map((conflict) => [
            conflict.id,
            conflict.localLabel.startsWith('Keep ') ? ('local' as const) : ('remote' as const)
          ])
        )
      );
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

test('corrupted archives and missing ancestors fail without replacing local data', async () => {
  const drive = cloud();
  const store = memoryStore(state());
  const sync = client(store, drive.transport);
  try {
    await sync.connect();
    const file = [...drive.files.values()][0];
    file.bytes = new TextEncoder().encode('corrupt');
    sync.disconnect();
    await sync.connect();
    assert.equal(sync.status.phase, 'error');
    assert.equal((await store.exportState()).profiles.length, 1);
    file.revision.parents = ['missing'];
    await sync.sync();
    assert.match(sync.status.message, /incomplete/);
  } finally {
    sync.destroy();
  }
});

test('long immutable histories are traversed iteratively and cycles are rejected', async () => {
  const store = memoryStore(state());
  const bytes = await store.encodeBackup(state());
  const sha256 = await digest(bytes);
  let revisions: Revision[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `revision-${index}`,
    fileId: `file-${index}`,
    parents: index ? [`revision-${index - 1}`] : [],
    createdAt: time,
    sha256
  }));
  const transport: RevisionTransport = {
    async list() {
      return revisions;
    },
    async download() {
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
    revisions = [
      { id: 'a', fileId: 'a', parents: ['b'], createdAt: time, sha256 },
      { id: 'b', fileId: 'b', parents: ['a'], createdAt: time, sha256 }
    ];
    await sync.sync();
    assert.equal(sync.status.phase, 'error');
    assert.match(sync.status.message, /cycle/);
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
    return Response.json(init.method === 'POST' ? { id: 'new-file' } : { files: [] });
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

test('Drive transport rejects oversized downloads and invalid metadata', async () => {
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
      parents: [],
      createdAt: time,
      sha256: '0'.repeat(64)
    }),
    /size limit/
  );
  const invalid = createDriveTransport(() => 'test', (async () =>
    Response.json({ files: [{ id: 'file', description: '{}' }] })) as typeof fetch);
  await assert.rejects(invalid.list(), /unsupported or damaged/);
});
