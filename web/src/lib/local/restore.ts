import { emptyState, type PortableState } from './types.ts';
import {
  reconcile,
  PORTABLE_SETTINGS,
  type Resolutions,
  type SyncConflict
} from '../sync/reconcile.ts';

export interface BackupPreview {
  id: string;
  revision: number;
  conflicts: SyncConflict[];
}

/** Runs in the archive worker, against an immutable inspected local revision. */
export function prepareBackupRestore(
  local: PortableState,
  incoming: PortableState,
  replace: boolean,
  resolutions: Resolutions = {}
): { state: PortableState; conflicts: SyncConflict[] } {
  const result = replace
    ? { state: structuredClone(incoming), conflicts: [] }
    : reconcile(local, incoming, emptyState(), resolutions);
  // Backups may carry portable display preferences, never consent or device settings.
  const portable = new Set<string>(PORTABLE_SETTINGS);
  result.state.settings = {
    ...Object.fromEntries(Object.entries(local.settings).filter(([key]) => !portable.has(key))),
    ...Object.fromEntries(
      Object.entries(result.state.settings).filter(([key]) => portable.has(key))
    )
  };
  return result;
}
