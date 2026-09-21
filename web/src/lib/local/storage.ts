import {
  emptyState,
  requireArchiveVersion,
  UnsupportedArchiveVersionError,
  type PortableState
} from './types.ts';
import type { DeviceExclusion } from './device.ts';

export interface StoredArchive {
  state: PortableState;
  revision: number;
  exclusions: DeviceExclusion[];
}
export const DATABASE = 'gfl2-pull-tracker-stable';
const STORE = 'archive';
let opened: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise((resolve, reject) => {
      // Stable storage is isolated from prerelease workers. Future upgrades require
      // explicit, tested migrations; never delete an existing store to open it.
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
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
        reject(
          request.error?.name === 'VersionError'
            ? new UnsupportedArchiveVersionError(
                'Unsupported browser archive version. Update the tracker; existing data is unchanged.'
              )
            : new Error('Browser storage could not be opened. Check site storage permissions.')
        );
      };
      request.onblocked = () => {
        opened = undefined;
        reject(new Error('Close other tracker tabs to finish upgrading browser storage.'));
      };
    });
  return opened;
}

/** This small key lets warm queries check freshness without cloning the complete archive. */
export async function readRevision(): Promise<number> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('revision');
    transaction.oncomplete = () => resolve(request.result ?? 0);
    transaction.onerror = () => reject(new Error('Browser storage could not be read.'));
  });
}

export async function readArchive(): Promise<StoredArchive> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('current');
    transaction.oncomplete = () => {
      const archive = request.result ?? { state: emptyState(), revision: 0, exclusions: [] };
      try {
        requireArchiveVersion(archive.state?.version);
        resolve(archive);
      } catch (error) {
        reject(error);
      }
    };
    transaction.onerror = () => reject(new Error('Browser storage could not be read.'));
  });
}

export async function recoverySnapshot(): Promise<PortableState | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('recovery');
    transaction.oncomplete = () => {
      try {
        if (request.result) requireArchiveVersion(request.result.version);
        resolve(request.result ?? null);
      } catch (error) {
        reject(error);
      }
    };
    transaction.onerror = () => reject(new Error('Recovery snapshot could not be read.'));
  });
}

/** Metadata and archive are committed together; revision guards also work without Web Locks. */
export async function writeArchive(
  archive: StoredArchive,
  expectedRevision: number,
  recovery?: PortableState | null
): Promise<void> {
  requireArchiveVersion(archive.state.version);
  if (recovery) requireArchiveVersion(recovery.version);
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const current = store.get('current');
    let unsupported: unknown;
    current.onsuccess = () => {
      try {
        if (current.result) requireArchiveVersion(current.result.state?.version);
      } catch (error) {
        unsupported = error;
        transaction.abort();
      }
    };
    const request = store.get('revision');
    let changed = false;
    request.onsuccess = () => {
      if ((request.result ?? 0) !== expectedRevision) {
        changed = true;
        transaction.abort();
        return;
      }
      if (recovery !== undefined) store.put(recovery, 'recovery');
      store.put({ ...archive, revision: expectedRevision + 1 }, 'current');
      store.put(expectedRevision + 1, 'revision');
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        unsupported ??
          Object.assign(
            new Error(
              changed
                ? 'The archive changed in another tab. Refresh and try again.'
                : 'Browser storage could not save this change. Your previous archive is intact; check available storage.'
            ),
            { name: changed ? 'ArchiveRevisionConflictError' : 'Error' }
          )
      );
    transaction.onerror = () => {
      /* onabort reports transaction failures, including quota errors. */
    };
  });
}
