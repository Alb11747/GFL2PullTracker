import { canonical, LocalEngine, validateState } from './engine.ts';
import { decodeBackup, encodeBackup } from './backup.ts';
import { readArchive, recoverySnapshot, writeArchive } from './storage.ts';
import type { PortableState } from './types.ts';
import {
  applyExclusions,
  removeFromDevice,
  restoreExclusions,
  retainExclusionAliases
} from './device.ts';
import { readExport, inspectExiliumProfiles } from '../import-files.ts';

interface Request {
  id: number;
  method: string;
  args: unknown[];
}
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (data: unknown) => void;
};
const updates =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gfl2-archive-updates') : null;
updates?.addEventListener('message', () => scope.postMessage({ changed: true }));
const mutations = new Set([
  'createProfile',
  'renameProfile',
  'deleteProfile',
  'importRecords',
  'mergeState',
  'replaceState',
  'importBackup',
  'setPreferences'
]);
const allowed = new Set([
  ...mutations,
  'profiles',
  'history',
  'overview',
  'statistics',
  'filterOptions',
  'exportState',
  'exportBackup',
  'encodeBackup',
  'decodeBackup',
  'validateState',
  'preferences',
  'recoverySnapshot',
  'readExport',
  'inspectExiliumProfiles'
]);
async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  if (!allowed.has(method)) throw new Error('Unknown local archive operation.');
  if (method === 'readExport' || method === 'inspectExiliumProfiles') {
    // File custom properties are not preserved by structured clone. Paths travel
    // separately while bytes are read and parsed exclusively inside this worker.
    const files = (args[0] as { file: File; path: string }[]).map(({ file, path }) => ({
      name: file.name,
      size: file.size,
      webkitRelativePath: path,
      text: () => file.text()
    }));
    return method === 'readExport'
      ? readExport(files, args[1] as string, args[2] as string | undefined)
      : inspectExiliumProfiles(files);
  }
  if (method === 'encodeBackup') return encodeBackup(args[0] as PortableState);
  if (method === 'decodeBackup')
    return decodeBackup(args[0] as Uint8Array, args[1] as 1 | 2 | undefined);
  if (method === 'validateState') return validateState(args[0]);
  if (method === 'recoverySnapshot') return recoverySnapshot();
  const stored = await readArchive();
  const originalExclusions = canonical(stored.exclusions);
  const engine = new LocalEngine(stored.state);
  let result: unknown;
  let replacement = false;
  let recovery: PortableState | null | undefined;
  if (method === 'exportBackup') return encodeBackup(engine.exportState());
  if (method === 'importBackup') {
    const state = await decodeBackup(args[0] as Uint8Array);
    replacement = args[1] === true;
    result = replacement ? await engine.replaceState(state) : await engine.mergeState(state);
    stored.exclusions = restoreExclusions(stored.exclusions, state);
  } else if (method === 'replaceState') {
    if (args[1] !== undefined && canonical(stored.state) !== canonical(args[1]))
      throw new Error('The local archive changed during sync. Run sync again.');
    result = await engine.replaceState(args[0]);
    replacement = true;
    if (args[1] !== undefined) {
      stored.exclusions = retainExclusionAliases(engine.exportState(), stored.exclusions);
      result = await engine.replaceState(applyExclusions(engine.exportState(), stored.exclusions));
    } else stored.exclusions = restoreExclusions(stored.exclusions, engine.exportState());
  } else if (method === 'deleteProfile' && args[1] === false) {
    const removed = removeFromDevice(engine.exportState(), args[0] as string, stored.exclusions);
    stored.exclusions = removed.exclusions;
    await engine.replaceState(removed.state);
    const previousRecovery = await recoverySnapshot();
    recovery =
      previousRecovery === null ? null : applyExclusions(previousRecovery, stored.exclusions);
  } else {
    const operation = engine[method as keyof LocalEngine];
    if (typeof operation !== 'function') throw new Error('Unknown local archive operation.');
    result = await (operation as (...args: unknown[]) => unknown).apply(engine, args);
    if (method === 'mergeState')
      stored.exclusions = restoreExclusions(stored.exclusions, args[0] as PortableState);
    if (method === 'importRecords')
      stored.exclusions = restoreExclusions(stored.exclusions, engine.exportState());
    if (method === 'deleteProfile') {
      const removed = removeFromDevice(stored.state, args[0] as string, []);
      const previousRecovery = await recoverySnapshot();
      recovery =
        previousRecovery === null ? null : applyExclusions(previousRecovery, removed.exclusions);
    }
  }
  if (mutations.has(method)) {
    const state = engine.exportState();
    if (
      canonical(state) === canonical(stored.state) &&
      canonical(stored.exclusions) === originalExclusions &&
      method === 'replaceState' &&
      args[1] !== undefined
    )
      return result;
    await writeArchive(
      { ...stored, state },
      stored.revision,
      recovery !== undefined ? recovery : replacement ? stored.state : undefined
    );
    updates?.postMessage({ changed: true });
    scope.postMessage({ changed: true });
  }
  return result;
}
let queue: Promise<unknown> = Promise.resolve();
scope.onmessage = ({ data }) => {
  // A single queue also prevents overlapping mutations within this worker.
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      try {
        const run = () => dispatch(data.method, data.args);
        const result =
          typeof navigator !== 'undefined' && navigator.locks
            ? await navigator.locks.request('gfl2-local-archive', run)
            : await run();
        scope.postMessage({ id: data.id, result });
      } catch (error) {
        scope.postMessage({
          id: data.id,
          error: error instanceof Error ? error.message : 'The local archive operation failed.'
        });
      }
    });
};
