import { emptyState, type PortableState } from './types.ts';
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
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
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
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('current');
    transaction.oncomplete = () =>
      resolve(
        request.result
          ? { ...request.result, exclusions: request.result.exclusions || [] }
          : { state: emptyState(), revision: 0, exclusions: [] }
      );
    transaction.onerror = () => reject(new Error('Browser storage could not be read.'));
  });
}
export async function recoverySnapshot(): Promise<PortableState | null> {
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
