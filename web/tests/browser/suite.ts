import { mount, unmount, tick } from 'svelte';
import ArchiveSettings from '../../src/lib/components/ArchiveSettings.svelte';
import { createLocalClient, type LocalClient } from '../../src/lib/local/client.ts';
import type { StoredArchive } from '../../src/lib/local/storage.ts';
import { emptyState, identityKey, type PortableState } from '../../src/lib/local/types.ts';
import { createDriveSync, type SyncStatus } from '../../src/lib/sync/controller.ts';
import { digest, type Revision, type RevisionTransport } from '../../src/lib/sync/drive.ts';
import { canonical } from '../../src/lib/sync/reconcile.ts';

const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const results = document.querySelector<HTMLElement>('#results')!;
const fixture = document.querySelector<HTMLElement>('#fixture')!;
const databaseName = 'gfl2-pull-tracker';
const timestamp = '2026-09-20T12:00:00.000Z';
const clients: LocalClient[] = [];
const controllers: ReturnType<typeof createDriveSync>[] = [];
let mounted: ReturnType<typeof mount> | undefined;
const runtimeErrors: string[] = [];
let observingRun = false;

function recordRuntimeError(error: unknown) {
  if (!observingRun) return;
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  runtimeErrors.push(detail);
  // Keep watching after completion so a late exception cannot leave a false PASS.
  summary.textContent = 'FAIL: uncaught browser runtime error';
  log(`RUNTIME ERROR ${detail}`);
}
window.addEventListener('error', (event) => recordRuntimeError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => recordRuntimeError(event.reason));

async function settleRuntime() {
  // Flush component effects and allow the browser to dispatch uncaught errors
  // and unhandled promise rejections before reporting each assertion group.
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(runtimeErrors.length === 0, `${runtimeErrors.length} uncaught browser runtime error(s)`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function log(message: string) {
  results.textContent += `${message}\n`;
}
function state(name = 'Account'): PortableState {
  return {
    ...emptyState(),
    profiles: [
      {
        id: 'browser-profile',
        aliases: ['browser-profile'],
        name,
        account_fingerprint: `sha256:${'b'.repeat(64)}`,
        endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
        server: '1',
        game_channel_id: '1',
        created_at: timestamp,
        updated_at: timestamp,
        snapshots: []
      }
    ]
  };
}
function client() {
  const value = createLocalClient();
  clients.push(value);
  return value;
}
async function clean() {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  for (const controller of controllers.splice(0)) controller.destroy();
  for (const local of clients.splice(0)) local.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Test database remained open after worker shutdown.'));
  });
}
async function rawArchive(seed?: { current: unknown; recovery: unknown }, version = 2) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, seed ? version : undefined);
    request.onupgradeneeded = () => request.result.createObjectStore('archive');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ current: StoredArchive; recovery: PortableState | null }>(
      (resolve, reject) => {
        const transaction = db.transaction('archive', seed ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('archive');
        if (seed) {
          store.put(seed.current, 'current');
          store.put(seed.recovery, 'recovery');
        }
        const current = store.get('current');
        const recovery = store.get('recovery');
        transaction.oncomplete = () =>
          resolve({ current: current.result, recovery: recovery.result });
        transaction.onerror = () => reject(transaction.error);
      }
    );
  } finally {
    db.close();
  }
}
async function eventually(check: () => boolean, description: string) {
  const deadline = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await tick();
}
function button(label: string) {
  const element = [...fixture.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label
  );
  assert(element, `Missing production button: ${label}`);
  return element;
}
function choose(label: string) {
  const option = [...fixture.querySelectorAll('label')].find(
    (item) => item.querySelector('input[type=radio]') && item.textContent?.trim().endsWith(label)
  );
  assert(option, `Missing production conflict option ending with ${label}`);
  const radio = option.querySelector<HTMLInputElement>('input')!;
  radio.click();
  log(`  UI chose ${option.textContent?.trim().replace(/\s+/g, ' ')}`);
}
function cloud() {
  const files = new Map<string, { revision: Revision; bytes: Uint8Array }>();
  const counts = { list: 0, download: 0, upload: 0, deletion: 0, authorization: 0 };
  let nextList: (() => Promise<void>) | undefined;
  const transport: RevisionTransport = {
    async list() {
      counts.list++;
      const hook = nextList;
      nextList = undefined;
      await hook?.();
      return [...files.values()].map(({ revision }) => structuredClone(revision));
    },
    async download(revision) {
      counts.download++;
      assert(files.has(revision.id), 'Missing synthetic cloud revision');
      return files.get(revision.id)!.bytes.slice();
    },
    async delete(fileId) {
      counts.deletion++;
      for (const [id, file] of files) if (file.revision.fileId === fileId) files.delete(id);
    },
    async upload(revision, bytes) {
      counts.upload++;
      files.set(revision.id, {
        revision: { ...revision, fileId: revision.id, contentVersion: '1' },
        bytes: bytes.slice()
      });
      return { fileId: revision.id, contentVersion: '1' };
    }
  };
  return {
    transport,
    counts,
    onNextList(hook: () => Promise<void>) {
      nextList = hook;
    },
    async add(local: LocalClient, id: string, value: PortableState, parents: string[] = []) {
      const bytes = await local.encodeBackup(value);
      assert(bytes[0] === 0x1f && bytes[1] === 0x8b, 'Revision must use real gzip encoding');
      files.set(id, {
        revision: {
          id,
          parents,
          fileId: id,
          contentVersion: '1',
          createdAt: timestamp,
          sha256: await digest(bytes)
        },
        bytes
      });
    }
  };
}
async function dialog(local: LocalClient, remote: ReturnType<typeof cloud>) {
  let status: SyncStatus;
  const drive = createDriveSync({
    clientId: 'synthetic-browser-client',
    store: local,
    transport: remote.transport,
    authorize: async () => {
      remote.counts.authorization++;
      return { token: 'synthetic-token', expiresIn: 3600 };
    },
    intervalMs: 3_600_000,
    onStatus(next) {
      status = next;
      log(
        `  controller ${next.phase}: ${next.conflicts.map((item) => item.id).join(', ') || next.message}`
      );
    }
  });
  controllers.push(drive);
  mounted = mount(ArchiveSettings, {
    target: fixture,
    props: {
      local,
      profiles: await local.profiles(),
      activeProfileId: 'browser-profile',
      googleClientId: 'synthetic-browser-client',
      drive,
      section: 'backup',
      onchanged: async () => {}
    }
  });
  await tick();
  button('Connect Google Drive').click();
  await eventually(
    () => status?.phase === 'conflict' && !!fixture.querySelector('fieldset'),
    'initial conflict dialog'
  );
  assert(button('Apply choices and sync').disabled, 'Conflict submission must start disabled');
  return {
    drive,
    get status() {
      return status!;
    }
  };
}
async function applyAndWait(view: Awaited<ReturnType<typeof dialog>>) {
  await tick();
  const submit = button('Apply choices and sync');
  assert(!submit.disabled, 'Complete selection must enable submission');
  const previous = view.status.resolutionGeneration;
  submit.click();
  await eventually(
    () =>
      view.status.phase === 'synced' ||
      view.status.phase === 'error' ||
      (view.status.phase === 'conflict' && view.status.resolutionGeneration !== previous),
    'resolved dialog result'
  );
  assert(view.status.phase !== 'error', view.status.message);
  // ArchiveSettings awaits its action before clearing busy state.
  await eventually(
    () =>
      view.status.phase !== 'conflict' ||
      !fixture.querySelector<HTMLInputElement>('input[type=radio]:checked'),
    'fresh dialog choices'
  );
}

const cases: [string, () => Promise<void>][] = [
  [
    'unchanged sync lists metadata without exporting, encoding, downloading or writing',
    async () => {
      const local = client(), remote = cloud();
      await local.replaceState(state());
      const calls = { exports: 0, encodes: 0, replacements: 0 };
      const store: LocalClient = {
        ...local,
        exportState: () => { calls.exports++; return local.exportState(); },
        encodeBackup: (value) => { calls.encodes++; return local.encodeBackup(value); },
        replaceState: (value, expected) => { calls.replacements++; return local.replaceState(value, expected); }
      };
      const drive = createDriveSync({ clientId: 'synthetic-browser-client', store,
        transport: remote.transport, authorize: async () => ({ token: 'synthetic-token', expiresIn: 3600 }),
        intervalMs: 3_600_000 });
      controllers.push(drive);
      await drive.connect();
      assert(drive.status.phase === 'synced', drive.status.message);
      const previous = { ...calls, ...remote.counts };
      for (let repeat = 0; repeat < 3; repeat++) await drive.sync();
      assert(calls.exports === previous.exports && calls.encodes === previous.encodes &&
        calls.replacements === previous.replacements, 'Unchanged sync serialized or rewrote the archive');
      assert(remote.counts.download === previous.download && remote.counts.upload === previous.upload,
        'Unchanged sync transferred immutable archive contents');
      assert(remote.counts.list === previous.list + 3, 'Unchanged sync skipped metadata freshness checks');
      log(`  Three unchanged syncs; mock-only counters ${JSON.stringify({ ...calls, ...remote.counts })}`);
    }
  ],
  ...([1, 2] as const).map((version): [string, () => Promise<void>] => [
    `IndexedDB ${version} resets prerelease history and recovery`,
    async () => {
      const original = state();
      // Both obsolete archive formats are intentionally discarded, including
      // malformed records that previously caused migration to reject startup.
      const obsolete = { ...original, version, settings: { theme: 'dark' } };
      obsolete.profiles[0].name = '';
      localStorage.setItem('gfl2.browser-test-display', 'retained');
      await rawArchive({
        current: {
          state: obsolete, revision: 7,
          exclusions: [{ profile_id: 'browser-profile', identity: identityKey(original.profiles[0]) }]
        },
        recovery: { ...state('Recovery'), version }
      }, version);
      const local = client();
      const reset = await local.exportState();
      assert(reset.profiles.length === 0 && reset.tombstones.length === 0,
        'Obsolete history survived the prerelease reset');
      assert(!('version' in reset), 'Portable archive retained a version marker');
      assert(await local.recoverySnapshot() === null, 'Obsolete recovery survived reset');
      assert(localStorage.getItem('gfl2.browser-test-display') === 'retained',
        'Reset cleared unrelated display storage');
      const saved = await rawArchive();
      assert(!saved.current || saved.current.exclusions.length === 0,
        'Obsolete device exclusions survived reset');
      const decoded = await local.decodeBackup(await local.exportBackup());
      assert(canonical(decoded) === canonical(reset), 'Real gzip round trip changed reset state');
      let oldWriterRejected = false;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(databaseName, version);
        request.onerror = () => { oldWriterRejected = request.error?.name === 'VersionError'; resolve(); };
        request.onsuccess = () => { request.result.close(); reject(new Error('Obsolete database writer reopened')); };
      });
      assert(oldWriterRejected, 'An obsolete worker can reopen the upgraded database');
      localStorage.removeItem('gfl2.browser-test-display');
    }
  ]),
  [
    'device removal preserves exclusion aliases through cloud replacement',
    async () => {
      const local = client();
      const original = state();
      original.profiles[0].aliases.push('previous-profile');
      await local.replaceState(original);
      await local.deleteProfile('browser-profile', false);
      const removed = await local.exportState();
      assert(removed.profiles.length === 0 && removed.tombstones.length === 0,
        'Device-only removal became an account deletion');
      await local.replaceState(original, removed);
      assert((await local.profiles()).length === 0, 'Cloud replacement restored an excluded profile');
      const saved = await rawArchive();
      assert(saved.current.exclusions.some((entry) => entry.aliases?.includes('previous-profile')),
        'Device exclusion lost historical aliases');
    }
  ],
  [
    'rejected replacement preserves archive, recovery and device exclusions',
    async () => {
      const local = client();
      await local.replaceState(state());
      await local.deleteProfile('browser-profile', false);
      await local.createProfile('Retained profile');
      const previous = await rawArchive();
      const malformed = state();
      malformed.profiles[0].name = '';
      let rejected = false;
      try { await local.replaceState(malformed); } catch { rejected = true; }
      assert(rejected, 'Invalid replacement was accepted');
      assert(canonical(await rawArchive()) === canonical(previous),
        'Rejected replacement changed saved archive, recovery or exclusions');
      assert((await local.profiles())[0].name === 'Retained profile',
        'Rejected replacement poisoned the worker cache');
    }
  ],
  [
    'two real workers preserve concurrent edits and reject stale replacement',
    async () => {
      assert('locks' in navigator, 'This regression requires real Web Locks');
      const first = client(),
        second = client();
      await first.replaceState(state());
      const stale = await first.exportState();
      await second.renameProfile('browser-profile', 'Edited in second worker');
      let rejected = false;
      try {
        await first.replaceState(emptyState(), stale);
      } catch (error) {
        rejected = /changed/.test(String(error));
      }
      assert(rejected, 'Stale replacement should reject');
      assert(
        (await second.exportState()).profiles[0].name === 'Edited in second worker',
        'Stale replacement discarded another worker edit'
      );
      await Promise.all([first.createProfile('Parallel A'), second.createProfile('Parallel B')]);
      assert((await first.profiles()).length === 3, 'Concurrent worker mutations lost a profile');
      log('  Both concurrent creations persisted; stale compare-and-swap rejected.');
    }
  ],
  [
    'successive cloud and device rename dialogs converge to Bob',
    async () => {
      const local = client(),
        remote = cloud();
      await local.replaceState(state('Alice'));
      await remote.add(local, 'base', state());
      await remote.add(local, 'a', state('Alice'), ['base']);
      await remote.add(local, 'b', state('Bob'), ['base']);
      const view = await dialog(local, remote);
      assert(
        view.status.conflicts.some((item) => item.id.startsWith('branch:')),
        'Expected cloud branch conflict'
      );
      choose('Bob');
      await applyAndWait(view);
      assert(
        view.status.phase === 'conflict' &&
          view.status.conflicts.every((item) => item.id.startsWith('device:')),
        'Expected second device/cloud dialog'
      );
      assert(
        button('Apply choices and sync').disabled,
        'Previous dialog selection leaked into new generation'
      );
      choose('Bob');
      await applyAndWait(view);
      assert(
        view.drive.status.phase === 'synced',
        'Rename resolution did not finish in two rounds'
      );
      assert(
        (await local.exportState()).profiles[0].name === 'Bob',
        'Final archive should use Bob'
      );
      const uploads = remote.counts.upload;
      await view.drive.sync();
      assert(remote.counts.upload === uploads, 'Converged rename created another revision');
      log(`  Final name Bob; mock-only counters ${JSON.stringify(remote.counts)}`);
    }
  ],
  [
    'concurrent edit invalidates a rendered deletion choice',
    async () => {
      const local = client(),
        second = client(),
        remote = cloud();
      await local.replaceState(state('Edited'));
      const deleted = emptyState();
      deleted.tombstones = [
        {
          profile_id: 'browser-profile',
          aliases: ['browser-profile'],
          identity: identityKey(state().profiles[0]),
          deleted_at: timestamp
        }
      ];
      await remote.add(local, 'deleted', deleted);
      const view = await dialog(local, remote);
      const conflict = view.status.conflicts.find((item) => item.kind === 'delete-edit');
      assert(conflict, 'Expected deletion conflict');
      choose(conflict.remoteLabel);
      remote.onNextList(async () => {
        await second.renameProfile('browser-profile', 'Changed while reading Drive');
      });
      await applyAndWait(view);
      assert(
        view.status.phase === 'conflict',
        'Stale deletion choice should produce a fresh conflict'
      );
      assert(
        (await local.profiles())[0]?.name === 'Changed while reading Drive',
        'Stale deletion removed concurrent edit'
      );
      assert(button('Apply choices and sync').disabled, 'Stale deletion remained selected');
      choose(view.status.conflicts[0].localLabel);
      await applyAndWait(view);
      assert(view.drive.status.phase === 'synced', 'Keeping the newer edit failed');
      log(`  Concurrent worker edit retained; mock-only counters ${JSON.stringify(remote.counts)}`);
    }
  ],
  [
    'rendered preference choices converge without revision churn',
    async () => {
      const local = client(),
        remote = cloud();
      const initial = state(),
        cloudState = state();
      initial.settings = { theme: 'dark' };
      cloudState.settings = { theme: 'light' };
      await local.replaceState(initial);
      await remote.add(local, 'settings', cloudState);
      const view = await dialog(local, remote);
      assert(view.status.conflicts[0].kind === 'setting', 'Expected preference conflict');
      assert(fixture.textContent?.includes('Different preferences'), 'Preference legend absent');
      choose(view.status.conflicts[0].remoteLabel);
      await applyAndWait(view);
      assert(
        view.status.phase === 'synced' && (await local.exportState()).settings.theme === 'light',
        'Selected preference did not converge'
      );
      const uploads = remote.counts.upload;
      for (let repeat = 0; repeat < 3; repeat++) await view.drive.sync();
      assert(remote.counts.upload === uploads, 'Unchanged preferences uploaded extra revisions');
      log(`  Three unchanged syncs; mock-only counters ${JSON.stringify(remote.counts)}`);
    }
  ]
];

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  results.textContent = '';
  summary.textContent = 'Running';
  runtimeErrors.length = 0;
  observingRun = true;
  let passed = 0;
  let failed = false;
  try {
    assert(
      location.origin === 'http://127.0.0.1:14194',
      'Use the isolated test origin http://127.0.0.1:14194'
    );
    for (const [name, run] of cases) {
      await clean();
      log(`RUN ${name}`);
      await run();
      await settleRuntime();
      passed++;
      log(`PASS ${name}`);
    }
  } catch (error) {
    failed = true;
    summary.textContent = `FAIL after ${passed}/${cases.length} browser regressions`;
    log(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    try {
      for (const controller of controllers.splice(0)) controller.destroy();
      for (const local of clients.splice(0)) local.close();
      await settleRuntime();
    } catch (error) {
      failed = true;
      summary.textContent = `FAIL after ${passed}/${cases.length} browser regressions`;
      log(error instanceof Error ? error.stack || error.message : String(error));
    }
    if (!failed) summary.textContent = `PASS ${passed}/${cases.length} browser regressions`;
    runButton.disabled = false;
  }
});

if (new URLSearchParams(location.search).get('autorun') === '1') runButton.click();
