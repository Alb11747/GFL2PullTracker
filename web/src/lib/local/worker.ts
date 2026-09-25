import { canonical, engineDiagnostics, LocalEngine } from './engine.ts';
import { decodeBackup } from './backup.ts';
import { createBackupCodec, type CodecMethod } from './codec.ts';
import {
  readArchive,
  readRevision,
  recoverySnapshot,
  writeArchive,
  type StoredArchive
} from './storage.ts';
import { STABLE_ARCHIVE_NAMESPACE, type PortableState } from './types.ts';
import { prepareBackupRestore } from './restore.ts';
import type { Resolutions, SyncConflict } from '../sync/reconcile.ts';
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
  previewConsumer?: string;
}
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (data: unknown) => void;
};
const updates =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(`${STABLE_ARCHIVE_NAMESPACE}-updates`)
    : null;
updates?.addEventListener('message', ({ data }: MessageEvent<{ revision: number }>) => {
  if (Number.isSafeInteger(data?.revision) && data.revision >= 0)
    scope.postMessage({ changed: true, revision: data.revision });
});
let cached: { stored: StoredArchive; engine: LocalEngine } | undefined;
let archiveReads = 0;
// A preview is bounded to one validated backup and never authorizes a stale write.
let backupPreview:
  | {
      id: string;
      revision: number;
      state: PortableState;
      incoming: PortableState;
      conflicts: SyncConflict[];
    }
  | undefined;
async function archive() {
  const revision = await readRevision();
  if (!cached || cached.stored.revision !== revision) {
    const stored = await readArchive();
    archiveReads++;
    const engine = cached ? cached.engine.fork(stored.state) : new LocalEngine(stored.state);
    cached = { stored: { ...stored, state: engine.state }, engine };
  }
  return cached;
}
const mutations = new Set([
  'createProfile',
  'renameProfile',
  'deleteProfile',
  'importRecords',
  'mergeState',
  'replaceState',
  'importBackup',
  'commitBackup',
  'setPreferences'
]);
const allowed = new Set([
  ...mutations,
  'profiles',
  'history',
  'overview',
  'rewards',
  'revision',
  'diagnostics',
  'statistics',
  'statisticsSummary',
  'filterOptions',
  'exportState',
  'exportBackup',
  'encodeBackup',
  'decodeBackup',
  'validateState',
  'preferences',
  'recoverySnapshot',
  'readExport',
  'inspectExiliumProfiles',
  'previewBackup'
]);
async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  if (!allowed.has(method)) throw new Error('Unknown local archive operation.');
  if (method === 'revision') return readRevision();
  if (method === 'diagnostics') return { archiveReads, ...engineDiagnostics };
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
  if (method === 'recoverySnapshot') return recoverySnapshot();
  if (method === 'previewBackup') {
    backupPreview = undefined;
    const incoming = await decodeBackup(args[0] as Uint8Array);
    const current = await archive();
    const prepared = await prepareBackupRestore(
      current.stored.state,
      incoming,
      args[1] === true,
      (args[2] ?? {}) as Resolutions
    );
    backupPreview = {
      ...prepared,
      incoming,
      id: crypto.randomUUID(),
      revision: current.stored.revision
    };
    return {
      id: backupPreview.id,
      revision: backupPreview.revision,
      conflicts: backupPreview.conflicts
    };
  }
  const current = await archive();
  // Read requests reuse immutable derived rows. Mutations are isolated until
  // the atomic revision-guarded write succeeds, including quota/error paths.
  const mutation = mutations.has(method);
  const stored = mutation
    ? { ...current.stored, exclusions: structuredClone(current.stored.exclusions) }
    : current.stored;
  const originalExclusions = canonical(stored.exclusions);
  const engine = mutation ? current.engine.fork() : current.engine;
  let result: unknown;
  let replacement = false;
  let recovery: PortableState | null | undefined;
  if (method === 'commitBackup') {
    const preview = backupPreview;
    if (!preview || preview.id !== args[0])
      throw Object.assign(new Error('Review this backup again before restoring.'), {
        name: 'StaleBackupPreviewError'
      });
    if (preview.revision !== stored.revision) {
      backupPreview = undefined;
      throw Object.assign(
        new Error('The archive changed. Review the backup conflicts again before restoring.'),
        { name: 'StaleBackupPreviewError' }
      );
    }
    if (preview.conflicts.length)
      throw new Error('Resolve every backup conflict before restoring.');
    result = await engine.replaceState(preview.state);
    replacement = true;
    stored.exclusions = restoreExclusions(stored.exclusions, preview.incoming);
  } else if (method === 'importBackup') {
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
    try {
      await writeArchive(
        { ...stored, state },
        stored.revision,
        recovery !== undefined ? recovery : replacement ? stored.state : undefined
      );
    } catch (cause) {
      if (
        method === 'commitBackup' &&
        cause instanceof Error &&
        cause.name === 'ArchiveRevisionConflictError'
      ) {
        backupPreview = undefined;
        throw Object.assign(
          new Error('The archive changed. Review the backup conflicts again before restoring.'),
          { name: 'StaleBackupPreviewError' }
        );
      }
      throw cause;
    }
    const revision = stored.revision + 1;
    if (method === 'commitBackup') backupPreview = undefined;
    cached = { stored: { ...stored, state: engine.state, revision }, engine };
    updates?.postMessage({ revision });
    scope.postMessage({ changed: true, revision });
  }
  return result;
}
let queue: Promise<unknown> = Promise.resolve();
const codec = createBackupCodec();
const codecMethods = new Set(['encodeBackup', 'decodeBackup', 'validateState']);
let mutationBarrier = 0;
const latestPreview = new Map<string, number>();
scope.onmessage = ({ data }) => {
  const enqueued = performance.now();
  if (mutations.has(data.method)) mutationBarrier++;
  const previewKey =
    data.method === 'rewards' &&
    typeof data.previewConsumer === 'string' &&
    data.previewConsumer.length > 0 &&
    data.previewConsumer.length <= 128
      ? `${mutationBarrier}:${data.previewConsumer}`
      : undefined;
  if (previewKey) latestPreview.set(previewKey, data.id);
  // A single queue also prevents overlapping mutations within this worker.
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      const started = performance.now();
      const reply = (result: unknown) =>
        scope.postMessage({
          id: data.id,
          result,
          timing: {
            queueMs: started - enqueued,
            executionMs: performance.now() - started,
            receivedAt: performance.timeOrigin + enqueued,
            startedAt: performance.timeOrigin + started,
            finishedAt: performance.timeOrigin + performance.now()
          }
        });
      const reject = (error: unknown) =>
        scope.postMessage({
          id: data.id,
          errorName: error instanceof Error ? error.name : 'Error',
          error: error instanceof Error ? error.message : 'The local archive operation failed.'
        });
      try {
        if (previewKey && latestPreview.get(previewKey) !== data.id)
          throw new DOMException('A newer reward selection replaced this preview.', 'AbortError');
        if (data.method === 'exportBackup' || codecMethods.has(data.method)) {
          // Snapshot at this exact FIFO position, after preceding mutations and
          // before following ones. Codec work uses only that immutable copy; its
          // reply may complete later without retaining the archive queue lock.
          const input =
            data.method === 'exportBackup' ? (await archive()).engine.exportState() : data.args[0];
          const method =
            data.method === 'exportBackup' ? 'encodeBackup' : (data.method as CodecMethod);
          void codec.call(method, input).then(reply, reject);
          return;
        }
        const run = () => dispatch(data.method, data.args);
        const result =
          mutations.has(data.method) && typeof navigator !== 'undefined' && navigator.locks
            ? await navigator.locks.request(`${STABLE_ARCHIVE_NAMESPACE}-archive`, run)
            : await run();
        reply(result);
      } catch (error) {
        reject(error);
      } finally {
        if (previewKey && latestPreview.get(previewKey) === data.id)
          latestPreview.delete(previewKey);
      }
    });
};
