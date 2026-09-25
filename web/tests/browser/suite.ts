import { mount, unmount, tick } from 'svelte';
import ArchiveSettings from '../../src/lib/components/ArchiveSettings.svelte';
import { createLocalClient, type LocalClient } from '../../src/lib/local/client.ts';
import { writeArchive, type StoredArchive } from '../../src/lib/local/storage.ts';
import { emptyState, identityKey, STABLE_ARCHIVE_NAMESPACE, type PortableState } from '../../src/lib/local/types.ts';
import { createDriveSync, type SyncStatus } from '../../src/lib/sync/controller.ts';
import { digest, type Revision, type RevisionTransport } from '../../src/lib/sync/drive.ts';
import { canonical } from '../../src/lib/sync/reconcile.ts';
import type { GoogleIdentity } from '../../src/lib/sync/identity.ts';
import { createPublicClient, type PublicConfig } from '../../src/lib/public-api.ts';

const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const results = document.querySelector<HTMLElement>('#results')!;
const fixture = document.querySelector<HTMLElement>('#fixture')!;
const databaseName = 'gfl2-pull-tracker-stable';
const prereleaseDatabaseName = 'gfl2-pull-tracker';
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
  await Promise.all(
    [databaseName, prereleaseDatabaseName].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () =>
            reject(new Error('Test database remained open after worker shutdown.'));
        })
    )
  );
}
async function rawArchive(
  seed?: { current: unknown; recovery: unknown },
  version = 1,
  name = databaseName
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, seed ? version : undefined);
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
    'server submission confirms incomplete original snapshots in a bound profile and one deletion removes all server history',
    async () => {
      const local = client();
      const initial = state('Imported export');
      await local.replaceState(initial);
      await local.importRecords({ profile_id: 'browser-profile', records_document: {
        schema_version: 1, exported_at: timestamp,
        records: [{ source_type_id: 3, source_page: 1,
          record: { item: 11007, pool_id: 224001, item_num: 1, time: 1784800558 } }]
      } });
      const before = canonical(await local.exportState());
      const config: PublicConfig = {
        mode: 'public', csrf_token: 'synthetic', limits: {},
        features: { submit_history: true, relay_import: true },
        identity_verification: { available: true, reason: null },
        accounts: [{ account_id: 'account', identity: { ...state().profiles[0], uid: '12345' }, history_version: 7 }]
      };
      const saves: Record<string, unknown>[] = [];
      let deletes = 0;
      const api = createPublicClient(async (path, options) => {
        if (String(path).endsWith('/config')) return Response.json(config);
        if (options?.method === 'PUT') {
          saves.push(JSON.parse(String(options.body)));
          return Response.json({ account_id: 'account', name: 'Imported export', snapshot_count: 1, record_count: 1 });
        }
        if (options?.method === 'DELETE') { deletes++; config.accounts[0].history_version++; return new Response(null, { status: 204 }); }
        throw new Error('Unexpected server request');
      });
      await api.config();
      mounted = mount(ArchiveSettings, { target: fixture, props: {
        local, profiles: await local.profiles(), activeProfileId: 'browser-profile',
        section: 'privacy', publicApi: api, publicConfig: config, onchanged: async () => {}
      } });
      await tick();
      const account = fixture.querySelector<HTMLSelectElement>('.server-data select')!;
      account.value = 'account'; account.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      button('Save profile to server').click();
      await eventually(() => fixture.textContent?.includes('Confirm association and submit') === true, 'original snapshot association confirmation');
      assert(saves.length === 0, 'Incomplete identity submitted without confirmation');
      assert(fixture.textContent?.includes('UID 12345'), 'Association did not identify authorized account');
      button('Confirm association and submit').click();
      await eventually(() => fixture.textContent?.includes('Server history saved') === true, 'confirmed profile saved');
      assert(Number(saves.length) === 1 && saves[0].associate === true && saves[0].expected_version === 7, 'Wrong submission authorization/version');
      assert(canonical(await local.exportState()) === before, 'Submission relabelled the local profile');
      button('Delete server history…').click(); await tick();
      assert(deletes === 0, 'Deletion bypassed confirmation');
      assert(fixture.textContent?.includes('excludes its history from future community statistics'), 'Deletion omits statistics');
      button('Confirm deletion').click();
      await eventually(() => fixture.textContent?.includes('Server history deleted') === true, 'unified server deletion');
      assert(Number(deletes) === 1, 'Expected exactly one server deletion');
      assert(canonical(await local.exportState()) === before, 'Server deletion changed the browser archive');
    }
  ],
  [
    'manual submission freezes deletion generation before async profile export and never retries',
    async () => {
      const local = client();
      await local.replaceState(state());
      await local.importRecords({ profile_id: 'browser-profile', records_document: {
        schema_version: 1, exported_at: timestamp,
        account_fingerprint: state().profiles[0].account_fingerprint,
        endpoint_host: state().profiles[0].endpoint_host,
        server: '1', game_channel_id: '1',
        records: [{ source_type_id: 3, source_page: 1,
          record: { item: 11007, pool_id: 224001, item_num: 1, time: 1784800558 } }]
      } });
      const config: PublicConfig = {
        mode: 'public', csrf_token: 'synthetic', limits: {},
        features: { submit_history: true, relay_import: true },
        identity_verification: { available: true, reason: null },
        accounts: [{ account_id: 'account', identity: { ...state().profiles[0], uid: '12345' }, history_version: 7 }]
      };
      let exporting = false, release!: () => void, mutations = 0, sentVersion: unknown;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const delayed = { ...local, exportState: async () => { exporting = true; await held; return local.exportState(); } };
      const api = createPublicClient(async (path, options) => {
        if (String(path).endsWith('/config')) return Response.json(config);
        mutations++; sentVersion = JSON.parse(String(options?.body)).expected_version;
        return Response.json({}, { status: 409 });
      });
      await api.config();
      mounted = mount(ArchiveSettings, { target: fixture, props: {
        local: delayed, profiles: await local.profiles(), activeProfileId: 'browser-profile',
        section: 'privacy', publicApi: api, publicConfig: config, onchanged: async () => {}
      } });
      await tick();
      const account = fixture.querySelector<HTMLSelectElement>('.server-data select')!;
      account.value = 'account'; account.dispatchEvent(new Event('change', { bubbles: true }));
      await tick(); button('Save profile to server').click();
      await eventually(() => exporting, 'manual export pending');
      config.accounts[0].history_version = 8; release();
      await eventually(() => fixture.textContent?.includes('The saved state changed.') === true, 'stale submission rejected');
      assert(sentVersion === 7 && mutations === 1, 'Stale upload adopted new deletion generation or retried');
    }
  ],
  [
    'restore refreshes a stale preview after another worker edits during recovery export',
    async () => {
      const local = client(), second = client();
      await local.replaceState(state('Backup name'));
      const bytes = await local.exportBackup();
      let exporting = false, release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let busy = false;
      const delayed: LocalClient = { ...local, exportBackup: async () => {
        const snapshot = await local.exportBackup();
        exporting = true;
        await held;
        return snapshot;
      } };
      mounted = mount(ArchiveSettings, { target: fixture, props: {
        local: delayed, profiles: await local.profiles(), activeProfileId: 'browser-profile',
        section: 'backup', onchanged: async () => {},
        onbusychange: (value) => { busy = value; }
      } });
      await tick();
      const file = fixture.querySelector<HTMLInputElement>('input[type="file"]')!;
      const selection = new DataTransfer();
      selection.items.add(new File([new Uint8Array(bytes)], 'delayed-recovery.json.gz'));
      file.files = selection.files;
      file.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (!this.download) anchorClick.call(this); };
      try {
        button('Merge archive').click();
        await eventually(() => exporting, 'recovery export has captured the preview snapshot');
        await second.renameProfile('browser-profile', 'Changed during recovery export');
        const before = canonical(await rawArchive());
        await eventually(() => fixture.textContent?.includes('Your archive changed.') === true,
          'cross-worker notification clears visible preview during export');
        release();
        await eventually(() => !busy && fixture.textContent?.includes('Review the refreshed preview') === true,
          'stale commit refreshes the conflict dialog');
        assert(fixture.textContent?.includes('Changed during recovery export'), 'Refreshed conflict omits concurrent edit');
        assert(fixture.querySelectorAll('input[type="radio"]').length === 2, 'Refreshed conflict choices missing');
        assert(!fixture.querySelector('input[type="radio"]:checked'), 'Old approval survived concurrent edit');
        assert(canonical(await rawArchive()) === before, 'Stale restore modified archive or recovery');
        assert(!fixture.textContent?.includes('Cannot read'), 'Recovery export dereferenced a cleared preview');
      } finally { release(); HTMLAnchorElement.prototype.click = anchorClick; }
    }
  ],
  [
    'sign-in cancellation unlocks settings and navigation ignores late Google callbacks',
    async () => {
      const local = client(), remote = cloud();
      await local.replaceState(state());
      const callbacks: Array<Parameters<GoogleIdentity['accounts']['oauth2']['initTokenClient']>[0]> = [];
      const previousGoogle = Object.getOwnPropertyDescriptor(window, 'google');
      Object.defineProperty(window, 'google', { configurable: true, value: {
        accounts: { oauth2: { initTokenClient(options: typeof callbacks[number]) {
          callbacks.push(options);
          return { requestAccessToken() {} };
        } } }
      } });
      const drive = createDriveSync({ clientId: 'synthetic-browser-client', store: local,
        transport: remote.transport, intervalMs: 3_600_000 });
      controllers.push(drive);
      let busy = false;
      const render = async (section: 'backup' | 'profiles') => {
        mounted = mount(ArchiveSettings, { target: fixture, props: {
          local, profiles: await local.profiles(), activeProfileId: 'browser-profile',
          section, drive, googleClientId: 'synthetic-browser-client', onchanged: async () => {},
          onbusychange: (value) => { busy = value; }
        } });
        await tick();
      };
      const token = { access_token: 'synthetic-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.appdata' };
      try {
        await render('backup');
        button('Connect Google Drive').click();
        await eventually(() => callbacks.length === 1 && busy, 'Google sign-in pending');
        const cancel = button('Cancel sign-in');
        assert(!cancel.matches(':disabled') && !cancel.closest('fieldset.settings'), 'Cancel sign-in is trapped in disabled settings');
        cancel.click();
        await eventually(() => !busy && drive.status.phase === 'disconnected', 'cancelled sign-in releases settings ownership');
        callbacks[0].callback(token);
        callbacks[0].error_callback();
        await settleRuntime();
        assert(drive.status.phase === 'disconnected' && remote.counts.list === 0, 'Cancelled callback connected to Drive');
        button('Connect Google Drive').click();
        await eventually(() => callbacks.length === 2 && busy, 'second Google sign-in pending');
        await unmount(mounted!);
        mounted = undefined;
        await render('profiles');
        await eventually(() => !busy && drive.status.phase === 'disconnected', 'leaving Backup cancels owned sign-in');
        callbacks[1].callback(token);
        await settleRuntime();
        assert(drive.status.phase === 'disconnected' && remote.counts.list === 0, 'Callback after navigation connected to Drive');
        assert(!fixture.querySelector<HTMLFieldSetElement>('fieldset.settings')?.disabled, 'Navigation left profile controls locked');
        await unmount(mounted!);
        mounted = undefined;
        await render('backup');
        button('Connect Google Drive').click();
        await eventually(() => callbacks.length === 3, 'fresh sign-in after cancellation');
        callbacks[2].callback(token);
        await eventually(() => drive.status.phase === 'synced' && !busy, 'new sign-in still succeeds');
      } finally {
        drive.disconnect();
        if (previousGoogle) Object.defineProperty(window, 'google', previousGoogle);
        else Reflect.deleteProperty(window, 'google');
      }
    }
  ],
  [
    'offline backup dialog invalidates stale choices and restores the selected version with recovery',
    async () => {
      const local = client(), second = client();
      await local.replaceState(state('Original backup name'));
      const bytes = await local.exportBackup();
      await local.renameProfile('browser-profile', 'Current device name');
      let changed = 0;
      // No Drive controller or Google configuration: downloadable backups are independent.
      mounted = mount(ArchiveSettings, {
        target: fixture,
        props: {
          local,
          profiles: await local.profiles(),
          activeProfileId: 'browser-profile',
          section: 'backup',
          onchanged: async () => { changed++; }
        }
      });
      await tick();
      const file = fixture.querySelector<HTMLInputElement>('input[type="file"]');
      assert(file, 'Backup file picker is present without Drive');
      const selection = new DataTransfer();
      selection.items.add(new File([new Uint8Array(bytes)], 'offline-browser-backup.json.gz', {
        type: 'application/gzip'
      }));
      file.files = selection.files;
      file.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      const downloads: Blob[] = [];
      const createObjectURL = URL.createObjectURL;
      const anchorClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob) downloads.push(blob);
        return createObjectURL(blob);
      };
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) anchorClick.call(this);
      };
      const settled = () => !fixture.querySelector<HTMLFieldSetElement>('fieldset.settings')?.disabled;
      try {
        button('Merge archive').click();
        await eventually(() => fixture.querySelectorAll('input[type="radio"]').length === 2 && settled(),
          'offline backup rename dialog');
        assert(fixture.textContent?.includes('This device: Current device name'), 'Device choice label is explicit');
        assert(fixture.textContent?.includes('Backup: Original backup name'), 'Backup choice label is explicit');
        assert(button('Apply backup choices').disabled, 'Unresolved offline choices cannot be applied');
        choose('Current device name');
        await tick();
        assert(!button('Apply backup choices').disabled, 'A device choice enables the offline action');

        await second.renameProfile('browser-profile', 'Concurrent device name');
        await eventually(() => fixture.textContent?.includes('Your archive changed.') === true &&
          !fixture.querySelector('input[type="radio"]'), 'concurrent revision invalidates rendered backup choices');
        assert(fixture.textContent?.includes('offline-browser-backup.json.gz'), 'Revision invalidation retains the selected file');
        assert(downloads.length === 0 && changed === 0, 'A stale choice neither downloads nor commits an archive');
        assert((await local.profiles())[0].name === 'Concurrent device name', 'Stale selection did not replace the concurrent edit');

        button('Merge archive').click();
        await eventually(() => fixture.querySelectorAll('input[type="radio"]').length === 2 && settled(),
          'refreshed offline backup conflict');
        assert(!fixture.querySelector('input[type="radio"]:checked'), 'Refreshed alternatives require a fresh choice');
        assert(button('Apply backup choices').disabled, 'The stale choice cannot enable the refreshed action');
        assert(fixture.textContent?.includes('This device: Concurrent device name'), 'The refreshed dialog shows the current device version');
        const previous = await local.exportState();
        choose('Original backup name');
        await tick();
        button('Apply backup choices').click();
        await eventually(() => changed === 1 && settled() && fixture.textContent?.includes('Archive merged.') === true,
          'offline backup choice commits');
        assert((await local.profiles())[0].name === 'Original backup name', 'Selected backup version was not restored');
        assert(canonical(await local.recoverySnapshot()) === canonical(previous), 'Offline merge lost its pre-restore recovery snapshot');
        assert(Number(downloads.length) === 1, 'Offline merge must download one independent recovery archive');
        const downloaded = await local.decodeBackup(new Uint8Array(await downloads[0].arrayBuffer()));
        assert(canonical(downloaded) === canonical(previous), 'Downloaded recovery does not contain the pre-restore archive');
        assert(!fixture.querySelector('input[type="radio"]'), 'Completed restore left stale choices visible');
      } finally {
        URL.createObjectURL = createObjectURL;
        HTMLAnchorElement.prototype.click = anchorClick;
      }
    }
  ],
  [
    'worker backup choices commit only resolved previews and retain recovery',
    async () => {
      const local = client();
      await local.replaceState(state('Original account'));
      const bytes = await local.exportBackup();
      await local.renameProfile('browser-profile', 'This device');
      const before = await rawArchive();
      const preview = await local.previewBackup(bytes);
      assert(preview.revision === before.current.revision, 'Preview did not bind its revision');
      assert(preview.conflicts.length === 1 && preview.conflicts[0].kind === 'rename', 'Missing backup rename choice');
      assert(canonical(await rawArchive()) === canonical(before), 'Preview changed the archive');
      let unresolved = false;
      try { await local.commitBackup(preview.id); } catch { unresolved = true; }
      assert(unresolved, 'Unresolved backup was committed');
      assert(canonical(await rawArchive()) === canonical(before), 'Unresolved commit changed storage');
      const conflict = preview.conflicts[0];
      const resolved = await local.previewBackup(bytes, false, {
        [conflict.id]: { choice: 'remote', fingerprint: conflict.fingerprint }
      });
      assert(resolved.conflicts.length === 0, 'Choice did not resolve backup rename');
      await local.commitBackup(resolved.id);
      assert((await local.profiles())[0].name === 'Original account', 'Backup choice was not restored');
      assert(canonical(await local.recoverySnapshot()) === canonical(before.current.state), 'Merge lost pre-restore recovery');
      assert((await local.revision()) === before.current.revision + 1, 'Restore did not commit once');
      let reused = false;
      try { await local.commitBackup(resolved.id); }
      catch (error) { reused = error instanceof Error && error.name === 'StaleBackupPreviewError'; }
      assert(reused, 'Completed backup preview could be reused');
    }
  ],
  [
    'offloaded backup keeps its FIFO snapshot while later edits and reward queries continue',
    async () => {
      const local = client();
      await local.replaceState(state('Initial name'));
      await local.importRecords({ profile_id: 'browser-profile', records_document: {
        schema_version: 1, exported_at: timestamp,
        records: [11007, 1013, 11007].map((item, index) => ({
          source_type_id: 3, source_page: 1,
          record: { item, pool_id: 224001, item_num: 1, time: 1784800558 - index }
        }))
      } });
      const preceding = local.renameProfile('browser-profile', 'Before export');
      const backup = local.exportBackup();
      const following = local.renameProfile('browser-profile', 'After export');
      const query = local.rewards('browser-profile', 3, ['Elite', 'Standard', 'Retired', 'Unknown'], 0, 20);
      const [, bytes, , rewards] = await Promise.all([preceding, backup, following, query]);
      const decoded = await local.decodeBackup(bytes);
      assert(decoded.profiles[0].name === 'Before export', 'Backup crossed a queued mutation boundary');
      assert((await local.profiles())[0].name === 'After export', 'Offloaded export discarded a later edit');
      assert(rewards.total === 3 && rewards.items.length === 3, 'Concurrent browsing lost saved rewards');
      const before = canonical(await rawArchive());
      const roundtrip = await local.decodeBackup(await local.encodeBackup(decoded));
      assert(canonical(roundtrip) === canonical(decoded), 'Codec altered the portable archive');
      assert(canonical(await rawArchive()) === before, 'Pure codec processing mutated local storage');
    }
  ],
  [
    'another worker invalidates backup previews and fingerprinted choices',
    async () => {
      const first = client(), second = client();
      await first.replaceState(state('Backup name'));
      const bytes = await first.exportBackup();
      await first.renameProfile('browser-profile', 'Initial local name');
      const initial = await first.previewBackup(bytes);
      const conflict = initial.conflicts[0];
      const choices = { [conflict.id]: { choice: 'remote' as const, fingerprint: conflict.fingerprint } };
      const resolved = await first.previewBackup(bytes, false, choices);
      await second.renameProfile('browser-profile', 'Concurrent name');
      const before = await rawArchive();
      let stale = false;
      try { await first.commitBackup(resolved.id); }
      catch (error) { stale = error instanceof Error && error.name === 'StaleBackupPreviewError'; }
      assert(stale, 'Concurrent edit lost typed stale-preview rejection');
      assert(canonical(await rawArchive()) === canonical(before), 'Stale preview changed storage');
      const refreshed = await first.previewBackup(bytes, false, choices);
      assert(refreshed.conflicts.length === 1 && refreshed.conflicts[0].fingerprint !== conflict.fingerprint,
        'Old choices authorized changed alternatives');
    }
  ],
  [
    'unsupported backup previews preserve storage and invalidate earlier approvals',
    async () => {
      const local = client();
      await local.replaceState(state());
      const valid = await local.previewBackup(await local.exportBackup(), true);
      const before = await rawArchive();
      for (const envelope of [
        { format: 'gfl2-pull-tracker-backup', version: 2, state: state(), sha256: 'irrelevant' },
        { format: 'gfl2-pull-tracker-backup', version: 1, state: { ...state(), version: 2 }, sha256: 'irrelevant' }
      ]) {
        const bytes = new Uint8Array(await new Response(new Blob([JSON.stringify(envelope)]).stream()
          .pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        let unsupported = false;
        try { await local.previewBackup(bytes, true); }
        catch (error) { unsupported = error instanceof Error && error.name === 'UnsupportedArchiveVersionError'; }
        assert(unsupported, 'Worker lost unsupported-version rejection identity');
        assert(canonical(await rawArchive()) === canonical(before), 'Unsupported backup changed storage');
      }
      let stale = false;
      try { await local.commitBackup(valid.id); }
      catch (error) { stale = error instanceof Error && error.name === 'StaleBackupPreviewError'; }
      assert(stale, 'Rejected backup left earlier approval available');
    }
  ],
  [
    'storage revision conflicts cannot replace history or recovery',
    async () => {
      const local = client();
      await local.replaceState(state());
      const stale = await rawArchive();
      await local.renameProfile('browser-profile', 'Newer archive');
      const before = await rawArchive();
      let rejected = false;
      try { await writeArchive(stale.current, stale.current.revision, emptyState()); }
      catch (error) { rejected = error instanceof Error && error.name === 'ArchiveRevisionConflictError'; }
      assert(rejected, 'IndexedDB CAS lost revision-conflict identity');
      assert(canonical(await rawArchive()) === canonical(before), 'Failed CAS changed storage');
    }
  ],
  [
    'queued previews coalesce per consumer without crossing writes or cancelling pages',
    async () => {
      assert('locks' in navigator, 'This regression requires Web Locks');
      const local = client();
      await local.replaceState(state());
      const records = [11007, 1013, 11007].map((item, index) => ({
        source_type_id: 3, source_page: 1,
        record: { item, pool_id: 224001, item_num: 1, time: 1784800558 - index }
      }));
      const document = { schema_version: 1, exported_at: timestamp, records };
      await local.importRecords({ profile_id: 'browser-profile', records_document: document });
      const rarities = ['Elite', 'Standard', 'Retired', 'Unknown'];
      const expected = await local.rewards('browser-profile', 3, rarities, 0, 10);
      let release!: () => void;
      let acquired!: () => void;
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const hold = navigator.locks.request(STABLE_ARCHIVE_NAMESPACE + '-archive', async () => {
        acquired();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await ready;
      const queuedWrite = local.setPreferences({ theme: 'dark' });
      const observe = <T,>(promise: Promise<T>) => promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
      try {
        const deadline = performance.now() + 5000;
        while (!(await navigator.locks.query()).pending?.some((lock) => lock.name === STABLE_ARCHIVE_NAMESPACE + '-archive')) {
          assert(performance.now() < deadline, 'Worker never reached held mutation lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const before = Array.from({ length: 20 }, () => observe(local.rewardPreview('browser-profile', 3, rarities, 0, 2, 'main-panel')));
        const separate = observe(local.rewardPreview('browser-profile', 3, rarities, 0, 2, 'other-panel'));
        const page = observe(local.rewards('browser-profile', 3, rarities, 1, 2));
        const newRecord = { ...records[0], record: { ...records[0].record, time: 1784800559 } };
        const mutation = observe(local.importRecords({ profile_id: 'browser-profile',
          records_document: { ...document, records: [newRecord, ...records] } }));
        const after = Array.from({ length: 20 }, () => observe(local.rewardPreview('browser-profile', 3, rarities, 0, 2, 'main-panel')));
        // Allow a task turn for selections to reach the worker blocked on the lock.
        await new Promise((resolve) => setTimeout(resolve, 100));
        release();
        await hold;
        await queuedWrite;
        const [earlier, later, isolated, paged, changed] = await Promise.all([
          Promise.all(before), Promise.all(after), separate, page, mutation
        ]);
        for (const batch of [earlier, later]) {
          assert(batch.slice(0, -1).every((result) => !result.ok && result.error instanceof Error && result.error.name === 'AbortError'),
            'Superseded previews ran or lost cancellation identity');
          assert(batch.at(-1)?.ok, 'Latest queued preview was cancelled');
        }
        const lastBefore = earlier.at(-1)!;
        const lastAfter = later.at(-1)!;
        assert(lastBefore.ok && lastBefore.value.total === expected.total, 'Preview crossed a mutation');
        assert(lastAfter.ok && lastAfter.value.total === expected.total + 1, 'Latest preview missed mutation');
        assert(changed.ok, 'Coalescing cancelled mutation');
        assert(isolated.ok && isolated.value.total === expected.total, 'Different component was cancelled');
        assert(paged.ok && canonical(paged.value.items) === canonical(expected.items.slice(1, 3)),
          'Show all page was cancelled or changed order/pity');
      } finally {
        release();
        await hold;
        await queuedWrite;
      }
    }
  ],
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
  ...([1, 2, 3] as const).map((version): [string, () => Promise<void>] => [
    `Stable storage leaves prerelease IndexedDB ${version} untouched`,
    async () => {
      const original = state();
      const oldState: Record<string, unknown> = { ...original, settings: { theme: 'dark' } };
      if (version === 3) delete oldState.version;
      else oldState.version = version;
      const seed = {
        current: {
          state: oldState,
          revision: 7,
          exclusions: [
            { profile_id: 'browser-profile', identity: identityKey(original.profiles[0]) }
          ]
        },
        recovery: oldState
      };
      localStorage.setItem('gfl2.browser-test-display', 'retained');
      await rawArchive(seed, version, prereleaseDatabaseName);
      const local = client();
      const fresh = await local.exportState();
      assert(
        fresh.version === 1 && fresh.profiles.length === 0 && fresh.tombstones.length === 0,
        'Stable namespace did not start with a fresh versioned archive'
      );
      assert(
        (await local.recoverySnapshot()) === null,
        'Prerelease recovery leaked into stable storage'
      );
      assert(
        localStorage.getItem('gfl2.browser-test-display') === 'retained',
        'Stable startup cleared unrelated display storage'
      );
      assert(
        canonical(await rawArchive(undefined, version, prereleaseDatabaseName)) === canonical(seed),
        'Stable startup changed prerelease data, recovery, or exclusions'
      );
      await local.replaceState(state('Stable account'));
      const changedOld = structuredClone(seed);
      changedOld.current.revision++;
      await rawArchive(changedOld, version, prereleaseDatabaseName);
      assert(
        (await local.exportState()).profiles[0].name === 'Stable account',
        'Prerelease writer changed the stable archive'
      );
      const decoded = await local.decodeBackup(await local.exportBackup());
      assert(
        canonical(decoded) === canonical(await local.exportState()),
        'Stable gzip round trip changed state'
      );
      localStorage.removeItem('gfl2.browser-test-display');
    }
  ]),
  [
    'unsupported stable archive versions preserve history and recovery',
    async () => {
      const future = { ...state('Future archive'), version: 2 };
      const seed = { current: { state: future, revision: 5, exclusions: [] }, recovery: future };
      await rawArchive(seed);
      const local = client();
      let rejected = false;
      try {
        await local.exportState();
      } catch (error) {
        rejected = error instanceof Error && /Unsupported.*version/.test(error.message);
      }
      assert(rejected, 'Future archive was accepted by an older reader');
      try {
        await local.replaceState(state('Overwrite attempt'));
      } catch {
        /* Expected rejection. */
      }
      assert(
        canonical(await rawArchive()) === canonical(seed),
        'Future archive was changed after rejection'
      );
    }
  ],
  [
    'future IndexedDB schema cannot be reopened or reset by the stable client',
    async () => {
      const seed = {
        current: { state: state('Future database'), revision: 2, exclusions: [] },
        recovery: state('Recovery')
      };
      await rawArchive(seed, 2);
      const local = client();
      let rejected = false;
      try {
        await local.exportState();
      } catch {
        rejected = true;
      }
      assert(rejected, 'An older client opened a future database schema');
      assert(
        canonical(await rawArchive()) === canonical(seed),
        'An older client reset the future database'
      );
    }
  ],
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
