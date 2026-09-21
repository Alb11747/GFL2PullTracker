import { emptyState, type PortableState } from '../local/types.ts';
import { canonical, type Choices, type Resolutions, type SyncConflict } from './reconcile.ts';
import { createMergeWorker } from './merge-worker.ts';
import { createLineageIndex } from './lineage.ts';
import {
  createDriveTransport,
  digest,
  DRIVE_SCOPE,
  DriveError,
  MAX_REVISIONS,
  type Revision,
  type RevisionTransport
} from './drive.ts';
export type { SyncConflict, Choices, Resolutions } from './reconcile.ts';

export interface SyncStore {
  exportState(): Promise<PortableState>;
  replaceState(state: PortableState, expectedState?: PortableState): Promise<PortableState>;
  encodeBackup(state: PortableState): Promise<Uint8Array>;
  decodeBackup(bytes: Uint8Array, expectedVersion?: 1 | 2): Promise<PortableState>;
  validateState(state: PortableState): Promise<PortableState>;
  subscribe(listener: () => void): () => void;
}
export interface SyncStatus {
  phase: 'disconnected' | 'connecting' | 'syncing' | 'synced' | 'conflict' | 'error' | 'reconnect';
  message: string;
  lastSyncedAt: string | null;
  conflicts: SyncConflict[];
  resolutionGeneration: string | null;
}
export interface ResolutionSubmission {
  generation: string | null;
  choices: Choices;
}
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(options: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: TokenResponse) => void;
        error_callback: () => void;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
}
type BrowserWithGoogle = Window & { google?: GoogleIdentity };
let identityLoading: Promise<GoogleIdentity> | null = null;
function loadIdentity(): Promise<GoogleIdentity> {
  if (typeof window === 'undefined')
    return Promise.reject(new Error('Google authorization requires a browser.'));
  const available = (window as BrowserWithGoogle).google;
  if (available) return Promise.resolve(available);
  if (!identityLoading)
    identityLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        const google = (window as BrowserWithGoogle).google;
        if (google) resolve(google);
        else {
          identityLoading = null;
          reject(new Error('Google authorization could not load.'));
        }
      };
      script.onerror = () => {
        identityLoading = null;
        script.remove();
        reject(
          new Error('Google authorization could not load. Check your connection and reconnect.')
        );
      };
      document.head.append(script);
    });
  return identityLoading;
}

function graph(revisions: Revision[]) {
  if (revisions.length > MAX_REVISIONS) throw new Error('Drive revision limit exceeded.');
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const parents = new Set(revisions.flatMap((revision) => revision.parents));
  const ancestors = new Map<string, Set<string>>();
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const revision of revisions) {
    const uniqueParents = new Set(revision.parents);
    remaining.set(revision.id, uniqueParents.size);
    for (const parent of uniqueParents) {
      if (!byId.has(parent))
        throw new Error(
          'Drive revision history is incomplete. Local data is safe; restore a downloaded backup.'
        );
      const next = children.get(parent) ?? [];
      next.push(revision.id);
      children.set(parent, next);
    }
  }
  // Iterative topological traversal also bounds deep histories without depending on JS stack size.
  const queue = revisions
    .filter((revision) => revision.parents.length === 0)
    .map((revision) => revision.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const result = new Set([id]);
    for (const parent of byId.get(id)!.parents)
      for (const ancestor of ancestors.get(parent)!) result.add(ancestor);
    ancestors.set(id, result);
    for (const child of children.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  if (ancestors.size !== revisions.length)
    throw new Error('Drive revision history contains a cycle. Local data is safe.');
  return {
    byId,
    heads: revisions
      .filter((revision) => !parents.has(revision.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ancestors
  };
}

export interface DriveSyncOptions {
  clientId: string;
  store: SyncStore;
  onStatus?: (status: SyncStatus) => void;
  /** Test injection; production creates the authenticated Drive transport. */
  transport?: RevisionTransport;
  authorize?: () => Promise<{ token: string; expiresIn: number }>;
  intervalMs?: number;
}

/** Browser lifecycle is owned here. Tokens and sync checkpoints live only in memory. */
export function createDriveSync(options: DriveSyncOptions) {
  let status: SyncStatus = {
    phase: 'disconnected',
    message: 'Drive is disconnected. Your history is saved on this device.',
    lastSyncedAt: null,
    conflicts: [],
    resolutionGeneration: null
  };
  const listeners = new Set<(status: SyncStatus) => void>();
  if (options.onStatus) listeners.add(options.onStatus);
  let accessToken = '';
  let expiresAt = 0;
  let epoch = 0;
  let disposed = false;
  let baseline = emptyState();
  let baselineHeads: string[] = [];
  let busy: Promise<void> | null = null;
  let applying = false;
  let dirty = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let resolutionSession: { key: string; choices: Resolutions } | null = null;
  let pendingUpload: { revision: Omit<Revision, 'fileId'>; bytes: Uint8Array } | null = null;
  let retryReadOnWake = false;
  const merger = createMergeWorker();
  const setStatus = (next: Partial<SyncStatus>) => {
    status = { ...status, ...next };
    for (const listener of listeners) listener(structuredClone(status));
  };
  const token = () => {
    if (!accessToken || Date.now() >= expiresAt)
      throw new DriveError('reconnect', 'Google authorization expired. Reconnect to resume sync.');
    return accessToken;
  };
  const transport = options.transport ?? createDriveTransport(token);
  const decoded = new Map<string, PortableState>();
  const decode = async (revision: Revision) => {
    const cacheKey = `${revision.formatVersion ?? 1}:${revision.id}:${revision.sha256}`;
    if (!decoded.has(cacheKey)) {
      const bytes = await transport.download(revision);
      if ((await digest(bytes)) !== revision.sha256)
        throw new DriveError(
          'invalid',
          'Drive backup integrity check failed. Local data is unchanged.'
        );
      decoded.set(cacheKey, await options.store.decodeBackup(bytes, revision.formatVersion ?? 1));
      if (decoded.size > 3) decoded.delete(decoded.keys().next().value!);
    }
    return decoded.get(cacheKey)!;
  };
  const active = (startedEpoch: number) => {
    if (disposed || epoch !== startedEpoch)
      throw new Error('Sync was disconnected. Local data is safe.');
    token();
  };
  function schedule() {
    if (
      disposed ||
      !accessToken ||
      ['conflict', 'reconnect'].includes(status.phase) ||
      (status.phase === 'error' && !retryReadOnWake)
    )
      return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void sync();
    }, 750);
  }
  async function perform(submission?: ResolutionSubmission) {
    const startedEpoch = epoch;
    // Submissions refer to the dialog the user actually saw, never a later dialog
    // that happens to reuse its IDs. Accepted decisions survive subsequent rounds.
    const offered = status.conflicts;
    const acceptsSubmission =
      status.phase === 'conflict' &&
      submission?.generation !== null &&
      submission?.generation === status.resolutionGeneration;
    let uploading = false;
    try {
      active(startedEpoch);
      setStatus({
        phase: 'syncing',
        message: 'Syncing your compressed Drive backup…',
        conflicts: [],
        resolutionGeneration: null
      });
      const revisions = await transport.list();
      active(startedEpoch);
      const history = graph(revisions);
      if (pendingUpload && history.byId.has(pendingUpload.revision.id)) pendingUpload = null;
      // Finish all network reads before binding decisions to the archive used by
      // the final compare-and-swap. V2 heads checkpoint retained aliases; legacy
      // ancestry is read once while upgrading, without retaining its snapshots.
      const lineage = createLineageIndex();
      const visited = new Set<string>();
      const pending = [...history.heads];
      const headStates = new Map<string, PortableState>();
      const headIds = new Set(history.heads.map((head) => head.id));
      while (pending.length) {
        const revision = pending.pop()!;
        if (visited.has(revision.id)) continue;
        visited.add(revision.id);
        const state = await decode(revision);
        active(startedEpoch);
        lineage.add(state);
        if (headIds.has(revision.id)) headStates.set(revision.id, state);
        if (revision.formatVersion !== 2)
          pending.push(...revision.parents.map((id) => history.byId.get(id)!));
      }
      const commonStates = new Map<string, PortableState>();
      const mergedHeads: string[] = [];
      for (const head of history.heads) {
        let common = emptyState();
        if (mergedHeads.length) {
          const candidates = [...history.ancestors.get(head.id)!].filter((id) =>
            mergedHeads.every((other) => history.ancestors.get(other)!.has(id))
          );
          const closest = candidates.filter(
            (id) =>
              !candidates.some((other) => other !== id && history.ancestors.get(other)!.has(id))
          );
          if (closest.length === 1) common = await decode(history.byId.get(closest[0])!);
        }
        commonStates.set(head.id, common);
        mergedHeads.push(head.id);
      }
      active(startedEpoch);
      const local = await options.store.exportState();
      const conflictKey = canonical({
        heads: history.heads.map(({ id, sha256, parents, formatVersion }) => ({
          id,
          sha256,
          parents,
          formatVersion: formatVersion ?? 1
        })),
        local
      });
      const sameSession = resolutionSession?.key === conflictKey;
      if (!sameSession) resolutionSession = { key: conflictKey, choices: {} };
      const resolutions = resolutionSession!.choices;
      if (sameSession && acceptsSubmission) {
        for (const conflict of offered) {
          const choice = submission!.choices[conflict.id];
          if (choice === 'local' || choice === 'remote')
            resolutions[conflict.id] = { choice, fingerprint: conflict.fingerprint };
        }
      }
      const choicesFor = (prefix: string): Resolutions =>
        Object.fromEntries(
          Object.entries(resolutions)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value])
        );
      const showConflicts = (conflicts: SyncConflict[]) => {
        setStatus({
          phase: 'conflict',
          message: 'Choose how to resolve these changes. Nothing has been replaced or uploaded.',
          conflicts: [...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values()],
          resolutionGeneration: crypto.randomUUID()
        });
      };
      lineage.add(local);
      const lineageChoices = choicesFor('lineage:');
      const recoveredLocal = lineage.recover(local, lineageChoices);
      const lineageConflicts = [...recoveredLocal.conflicts];
      for (const states of [headStates, commonStates]) {
        for (const [id, state] of states) {
          const recovered = lineage.recover(state, lineageChoices);
          states.set(id, recovered.state);
          lineageConflicts.push(...recovered.conflicts);
        }
      }
      if (lineageConflicts.length) {
        showConflicts(
          lineageConflicts.map((conflict) => ({ ...conflict, id: `lineage:${conflict.id}` }))
        );
        return;
      }
      let remote = emptyState();
      let conflicts: SyncConflict[] = [];
      for (const head of history.heads) {
        const prefix = `branch:${head.id}:`;
        const merged = await merger.reconcile(
          remote,
          headStates.get(head.id)!,
          commonStates.get(head.id)!,
          choicesFor(prefix)
        );
        conflicts.push(
          ...merged.conflicts.map((conflict) => ({ ...conflict, id: prefix + conflict.id }))
        );
        remote = merged.state;
      }
      active(startedEpoch);
      const knownBase = baselineHeads.every((id) => history.byId.has(id)) ? baseline : emptyState();
      const result = await merger.reconcile(
        recoveredLocal.state,
        remote,
        knownBase,
        choicesFor('device:')
      );
      conflicts = [
        ...conflicts,
        ...result.conflicts.map((conflict) => ({ ...conflict, id: `device:${conflict.id}` }))
      ];
      if (conflicts.length) {
        showConflicts(conflicts);
        return;
      }
      const state = await options.store.validateState(result.state);
      if (canonical(state) !== canonical(local)) {
        active(startedEpoch);
        applying = true;
        try {
          await options.store.replaceState(state, local);
        } finally {
          applying = false;
        }
      }
      active(startedEpoch);
      // Once data is safely local, quota/network failure can only delay its cloud publication.
      if (
        history.heads.length !== 1 ||
        history.heads[0].formatVersion !== 2 ||
        canonical(state) !== canonical(remote)
      ) {
        if (revisions.length >= MAX_REVISIONS)
          throw new DriveError(
            'quota',
            'Drive revision limit reached. Download a local backup before archiving cloud history.'
          );
        const bytes = await options.store.encodeBackup(state);
        active(startedEpoch);
        const sha256 = await digest(bytes);
        if (
          !pendingUpload ||
          pendingUpload.revision.sha256 !== sha256 ||
          canonical(pendingUpload.revision.parents) !== canonical(mergedHeads)
        ) {
          pendingUpload = {
            revision: {
              formatVersion: 2,
              id: crypto.randomUUID(),
              parents: mergedHeads,
              createdAt: new Date().toISOString(),
              sha256
            },
            bytes
          };
        }
        const upload = pendingUpload;
        uploading = true;
        await transport.upload(upload.revision, upload.bytes);
        uploading = false;
        active(startedEpoch);
        baselineHeads = [upload.revision.id];
        decoded.set(`2:${upload.revision.id}:${upload.revision.sha256}`, state);
        pendingUpload = null;
      } else baselineHeads = mergedHeads;
      baseline = structuredClone(state);
      resolutionSession = null;
      retryReadOnWake = false;
      setStatus({
        phase: 'synced',
        message: 'Saved on this device and synced to Google Drive.',
        lastSyncedAt: new Date().toISOString(),
        conflicts: [],
        resolutionGeneration: null
      });
    } catch (error) {
      if (epoch !== startedEpoch || disposed) return;
      const reconnect = error instanceof DriveError && error.code === 'reconnect';
      retryReadOnWake = error instanceof DriveError && error.code === 'network' && !uploading;
      if (reconnect) {
        accessToken = '';
        resolutionSession = null;
        clearTimeout(expiryTimer);
      }
      setStatus({
        phase: reconnect ? 'reconnect' : 'error',
        message: error instanceof Error ? error.message : 'Drive sync failed. Local data is safe.',
        conflicts: [],
        resolutionGeneration: null
      });
    }
  }
  function sync(submission?: ResolutionSubmission): Promise<void> {
    if (busy) {
      dirty = true;
      return busy;
    }
    busy = perform(submission).finally(() => {
      busy = null;
      if (dirty) {
        dirty = false;
        schedule();
      }
    });
    return busy;
  }
  const unsubscribeStore = options.store.subscribe(() => {
    if (!applying) {
      dirty = true;
      schedule();
    }
  });
  const onWake = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') schedule();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
  }
  const interval = setInterval(onWake, options.intervalMs ?? 60_000);
  function disconnect() {
    epoch++;
    accessToken = '';
    expiresAt = 0;
    baseline = emptyState();
    baselineHeads = [];
    pendingUpload = null;
    resolutionSession = null;
    decoded.clear();
    clearTimeout(debounce);
    clearTimeout(expiryTimer);
    setStatus({
      phase: 'disconnected',
      message: 'Drive is disconnected. Your history is saved on this device.',
      conflicts: [],
      resolutionGeneration: null
    });
  }
  async function connect() {
    if (!options.clientId && !options.authorize) {
      setStatus({
        phase: 'error',
        message:
          'Google Drive sync is not configured by this website. Download a compressed backup instead.'
      });
      return;
    }
    disconnect();
    const connectingEpoch = epoch;
    setStatus({ phase: 'connecting', message: 'Waiting for Google authorization…' });
    try {
      let authorized: { token: string; expiresIn: number };
      if (options.authorize) authorized = await options.authorize();
      else {
        const google = await loadIdentity();
        authorized = await new Promise((resolve, reject) => {
          const client = google.accounts.oauth2.initTokenClient({
            client_id: options.clientId,
            scope: DRIVE_SCOPE,
            include_granted_scopes: false,
            callback: (response) => {
              if (
                response.error ||
                !response.access_token ||
                !response.scope?.split(' ').includes(DRIVE_SCOPE)
              )
                reject(new Error('Google Drive permission was not granted. Local data is safe.'));
              else
                resolve({
                  token: response.access_token,
                  expiresIn: Number(response.expires_in ?? 0)
                });
            },
            error_callback: () =>
              reject(
                new Error(
                  'Google authorization was cancelled or the popup was blocked. Reconnect to try again.'
                )
              )
          });
          client.requestAccessToken({ prompt: 'select_account' });
        });
      }
      if (disposed || epoch !== connectingEpoch) return;
      if (!authorized.token || !Number.isFinite(authorized.expiresIn) || authorized.expiresIn <= 0)
        throw new Error('Google returned invalid authorization. Reconnect to try again.');
      accessToken = authorized.token;
      expiresAt = Date.now() + authorized.expiresIn * 1000;
      expiryTimer = setTimeout(
        () => {
          accessToken = '';
          resolutionSession = null;
          setStatus({
            phase: 'reconnect',
            conflicts: [],
            resolutionGeneration: null,
            message: 'Google authorization expired. Reconnect to resume sync.'
          });
        },
        Math.min(authorized.expiresIn * 1000, 2_147_483_647)
      );
      await sync();
    } catch (error) {
      if (epoch === connectingEpoch && !disposed)
        setStatus({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Google authorization failed.'
        });
    }
  }
  return {
    connect,
    disconnect,
    sync: () => sync(),
    resolve: (submission: ResolutionSubmission) => sync(submission),
    subscribe(listener: (value: SyncStatus) => void) {
      listeners.add(listener);
      listener(structuredClone(status));
      return () => {
        listeners.delete(listener);
      };
    },
    get status() {
      return structuredClone(status);
    },
    destroy() {
      disconnect();
      disposed = true;
      merger.close();
      clearInterval(interval);
      unsubscribeStore();
      listeners.clear();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWake);
        window.removeEventListener('online', onWake);
        document.removeEventListener('visibilitychange', onWake);
      }
    }
  };
}
