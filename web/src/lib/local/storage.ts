import {
  emptyState,
  profileIds,
  identityKey,
  MAX_PROFILE_ALIASES,
  type PortableState
} from './types.ts';
import { validateState } from './engine.ts';
import type { DeviceExclusion } from './device.ts';

export interface StoredArchive {
  state: PortableState;
  revision: number;
  exclusions: DeviceExclusion[];
}
const DATABASE = 'gfl2-pull-tracker';
const STORE = 'archive';
let opened: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise((resolve, reject) => {
      // Version-one workers cannot reopen this database after an upgrade.
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          opened = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        opened = undefined;
        reject(new Error('Browser storage could not be opened. Check site storage permissions.'));
      };
      request.onblocked = () => {
        opened = undefined;
        reject(new Error('Close other tracker tabs to finish upgrading browser storage.'));
      };
    });
  return opened;
}
export async function readArchive(): Promise<StoredArchive> {
  const db = await database();
  const saved = await new Promise<{ archive: StoredArchive; recovery: PortableState | null }>(
    (resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get('current');
      const recovery = transaction.objectStore(STORE).get('recovery');
      transaction.oncomplete = () =>
        resolve({
          archive: request.result
            ? { ...request.result, exclusions: request.result.exclusions || [] }
            : { state: emptyState(), revision: 0, exclusions: [] },
          recovery: recovery.result || null
        });
      transaction.onerror = () => reject(new Error('Browser storage could not be read.'));
    }
  );
  const { archive, recovery } = saved;
  if (archive.state.version === 2 && (!recovery || recovery.version === 2)) return archive;
  // Hash validation runs outside IndexedDB transactions. The revision guard below
  // atomically commits all migration outputs or leaves the previous bytes intact.
  const state = await validateState(archive.state);
  const migratedRecovery = recovery === null ? null : await validateState(recovery);
  if (!Array.isArray(archive.exclusions) || archive.exclusions.length > MAX_PROFILE_ALIASES)
    throw new Error('Invalid device exclusions.');
  let references = 0;
  const exclusions: DeviceExclusion[] = [];
  for (const exclusion of archive.exclusions) {
    const aliases = [...new Set([exclusion.profile_id, ...(exclusion.aliases || [])])].sort();
    for (const profile of [...state.profiles, ...(migratedRecovery?.profiles || [])]) {
      if (
        profileIds(profile).some((id) => aliases.includes(id)) ||
        (exclusion.identity !== null && exclusion.identity === identityKey(profile))
      )
        aliases.push(...profileIds(profile));
    }
    const normalized = { ...exclusion, aliases: [...new Set(aliases)].sort() };
    references += normalized.aliases.length;
    if (references > MAX_PROFILE_ALIASES) throw new Error('Too many device exclusion aliases.');
    await validateState({
      ...emptyState(),
      tombstones: [{ ...normalized, deleted_at: '1970-01-01T00:00:00Z' }]
    });
    exclusions.push(normalized);
  }
  await writeArchive({ ...archive, state, exclusions }, archive.revision, migratedRecovery);
  return { state, exclusions, revision: archive.revision + 1 };
}
export async function recoverySnapshot(): Promise<PortableState | null> {
  await readArchive();
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('recovery');
    transaction.oncomplete = () => resolve(request.result || null);
    transaction.onerror = () => reject(new Error('Recovery snapshot could not be read.'));
  });
}
/** The transaction compares a revision so even browsers without Web Locks cannot lose another tab's writes. */
export async function writeArchive(
  archive: StoredArchive,
  expectedRevision: number,
  recovery?: PortableState | null
): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get('current');
    let changed = false;
    request.onsuccess = () => {
      if ((request.result?.revision || 0) !== expectedRevision) {
        changed = true;
        transaction.abort();
        return;
      }
      if (recovery !== undefined) store.put(recovery, 'recovery');
      store.put({ ...archive, revision: expectedRevision + 1 }, 'current');
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        new Error(
          changed
            ? 'The archive changed in another tab. Refresh and try again.'
            : 'Browser storage could not save this change. Your previous archive is intact; check available storage.'
        )
      );
    transaction.onerror = () => {
      /* onabort reports the transaction outcome, including quota failures. */
    };
  });
}
