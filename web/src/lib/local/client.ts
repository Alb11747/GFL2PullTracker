import type {
  Filters,
  FilterOptions,
  History,
  ImportInput,
  ImportResult,
  Profile,
  Pull,
  Statistics
} from '../api.ts';
import type { PortableState } from './types.ts';
import type { ExiliumProfile } from '../exilium-import.ts';
export type { PortableState, PortableProfile, SourceSnapshot } from './types.ts';

function transferableFilters(filters: Filters): Filters {
  // Svelte state uses deep proxies; spreading the object alone leaves selection
  // arrays uncloneable by postMessage. Copy their primitive values at this boundary.
  const copy = { ...filters };
  for (const key of ['rarity', 'kind', 'type_id', 'pool_id'] as const) {
    const value = filters[key];
    copy[key] = Array.isArray(value) ? [...value] : value;
  }
  return copy;
}

/** Lazy worker creation keeps SSR free of browser globals. All personal data stays in this origin's IndexedDB. */
export function createLocalClient() {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<() => void>();
  function activeWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({
        data
      }: MessageEvent<{ id?: number; result?: unknown; error?: string; changed?: boolean }>) => {
        if (data.changed) {
          for (const listener of listeners) listener();
          return;
        }
        const request = pending.get(data.id!);
        if (!request) return;
        pending.delete(data.id!);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.result);
      };
      worker.onerror = () => {
        for (const request of pending.values())
          request.reject(
            new Error('The local archive worker stopped. Reload before trying again.')
          );
        pending.clear();
        worker?.terminate();
        worker = undefined;
      };
    }
    return worker;
  }
  function call<T>(method: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      try {
        const target = activeWorker();
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        target.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  return {
    profiles: () => call<Profile[]>('profiles'),
    createProfile: (name: string) => call<Profile>('createProfile', name),
    renameProfile: (id: string, name: string) => call<Profile>('renameProfile', id, name),
    deleteProfile: (id: string, acrossDevices = true) =>
      call<void>('deleteProfile', id, acrossDevices),
    history: (filters: Filters) => call<History>('history', transferableFilters(filters)),
    overview: (profileId: string) => call<Pull[]>('overview', profileId),
    statistics: (filters: Filters) => call<Statistics>('statistics', transferableFilters(filters)),
    filterOptions: (id: string) => call<FilterOptions>('filterOptions', id),
    importRecords: (input: ImportInput) => call<ImportResult>('importRecords', input),
    readExport: (files: File[], profileId: string, exiliumProfileId?: string) =>
      call<ImportInput>(
        'readExport',
        files.map((file) => ({ file, path: file.webkitRelativePath || file.name })),
        profileId,
        exiliumProfileId
      ),
    inspectExiliumProfiles: (files: File[]) =>
      call<ExiliumProfile[]>(
        'inspectExiliumProfiles',
        files.map((file) => ({ file, path: file.webkitRelativePath || file.name }))
      ),
    exportState: () => call<PortableState>('exportState'),
    validateState: (state: unknown) => call<PortableState>('validateState', state),
    mergeState: (state: PortableState) => call<PortableState>('mergeState', state),
    replaceState: (state: PortableState, expectedState?: PortableState) =>
      call<PortableState>('replaceState', state, expectedState),
    exportBackup: () => call<Uint8Array>('exportBackup'),
    importBackup: (bytes: Uint8Array, replace = false) =>
      call<PortableState>('importBackup', bytes, replace),
    encodeBackup: (state: PortableState) => call<Uint8Array>('encodeBackup', state),
    decodeBackup: (bytes: Uint8Array, expectedVersion?: 1 | 2) =>
      call<PortableState>('decodeBackup', bytes, expectedVersion),
    recoverySnapshot: () => call<PortableState | null>('recoverySnapshot'),
    preferences: () => call<Record<string, string | number | boolean>>('preferences'),
    setPreferences: (settings: Record<string, string | number | boolean>) =>
      call<void>('setPreferences', settings),
    subscribe(listener: () => void) {
      listeners.add(listener);
      activeWorker();
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      worker?.terminate();
      worker = undefined;
      for (const request of pending.values()) request.reject(new Error('Archive closed.'));
      pending.clear();
      listeners.clear();
    }
  };
}
export type LocalClient = ReturnType<typeof createLocalClient>;
