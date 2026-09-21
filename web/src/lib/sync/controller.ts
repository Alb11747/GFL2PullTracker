import { emptyState, type PortableState } from '../local/types.ts';
import { canonical, type Choices, type Resolutions, type SyncConflict } from './reconcile.ts';
import { createMergeWorker } from './merge-worker.ts';
import {
  createDriveTransport,
  digest,
  DRIVE_SCOPE,
  DriveError,
  MAX_REVISIONS,
  type Revision,
  type NewRevision,
  type RevisionTransport
} from './drive.ts';
export type { SyncConflict, Choices, Resolutions } from './reconcile.ts';

export interface SyncStore {
  revision(): Promise<number>;
  exportState(): Promise<PortableState>;
  replaceState(state: PortableState, expectedState?: PortableState): Promise<PortableState>;
  encodeBackup(state: PortableState): Promise<Uint8Array>;
  decodeBackup(bytes: Uint8Array): Promise<PortableState>;
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
  let pendingUpload: { revision: NewRevision; bytes: Uint8Array } | null = null;
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
  const audited = new Set<string>();
  let checkpoint: { cloud: string; revision: number } | null = null;
  const revisionKey = (revision: Revision) =>
    `${revision.fileId}:${revision.id}:${revision.sha256}:${revision.contentVersion}`;
  const decode = async (revision: Revision) => {
    const cacheKey = revisionKey(revision);
    if (!decoded.has(cacheKey)) {
      const bytes = await transport.download(revision);
      if ((await digest(bytes)) !== revision.sha256)
        throw new DriveError(
          'invalid',
          'Drive backup integrity check failed. Local data is unchanged.'
        );
      let state: PortableState;
      try {
        state = await options.store.decodeBackup(bytes);
      } catch (error) {
        // Worker/lifecycle failures are operational failures, not corrupt content.
        if (error instanceof Error && error.name === 'InvalidBackupError')
          throw new DriveError('invalid', error.message);
        throw error;
      }
      decoded.set(cacheKey, state);
      audited.add(cacheKey);
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
      let revisions = await transport.list();
      active(startedEpoch);
      const liveKeys = new Set(revisions.map(revisionKey));
      for (const key of audited) if (!liveKeys.has(key)) audited.delete(key);
      const removed = new Set<string>();
      const remove = async (revision: Revision) => {
        active(startedEpoch);
        await transport.delete(revision.fileId);
        active(startedEpoch);
        revisions = revisions.filter((item) => item.fileId !== revision.fileId);
        removed.add(revision.fileId);
        audited.delete(revisionKey(revision));
        decoded.delete(revisionKey(revision));
      };
      const readValid = async (revision: Revision): Promise<PortableState | null> => {
        if (removed.has(revision.fileId)) return null;
        try {
          return await decode(revision);
        } catch (error) {
          if (!(error instanceof DriveError) || error.code !== 'invalid') throw error;
          await remove(revision);
          return null;
        }
      };
      // Drain the entire unseen-file audit before reporting success. Downloads
      // remain serial and decoded snapshots are bounded by the small cache.
      for (const revision of revisions.filter((item) => !audited.has(revisionKey(item))))
        await readValid(revision);
      active(startedEpoch);
      const cloudKey = canonical(
        revisions
          .map(({ id, sha256, parents, fileId, contentVersion }) => ({
            id,
            sha256,
            parents,
            fileId,
            contentVersion
          }))
          .sort((a, b) => a.id.localeCompare(b.id) || a.fileId.localeCompare(b.fileId))
      );
      const localRevision = await options.store.revision();
      active(startedEpoch);
      if (
        checkpoint?.cloud === cloudKey &&
        checkpoint.revision === localRevision &&
        !pendingUpload &&
        !submission
      ) {
        retryReadOnWake = false;
        setStatus({
          phase: 'synced',
          message: 'Saved on this device and synced to Google Drive.',
          lastSyncedAt: new Date().toISOString()
        });
        return;
      }
      let inspection = await merger.inspect(revisions);
      for (const id of inspection.invalidIds)
        for (const revision of revisions.filter((item) => item.id === id)) await remove(revision);
      let history = { ...inspection, byId: new Map(revisions.map((item) => [item.id, item])) };
      const headStates = new Map<string, PortableState>();
      const commonStates = new Map<string, PortableState>();
      // Removing a corrupt head may reveal a healthy predecessor. Recompute until
      // all remaining heads/bases are valid, without discarding healthy descendants.
      while (true) {
        const before = revisions.length;
        for (const head of history.heads) {
          const state = await readValid(head);
          if (state) headStates.set(head.id, state);
          const commonId = history.common[head.id];
          const common = commonId ? await readValid(history.byId.get(commonId)!) : null;
          commonStates.set(head.id, common ?? emptyState());
        }
        if (before === revisions.length) break;
        inspection = await merger.inspect(revisions);
        history = { ...inspection, byId: new Map(revisions.map((item) => [item.id, item])) };
      }
      if (pendingUpload && history.byId.has(pendingUpload.revision.id)) pendingUpload = null;
      const local = await options.store.exportState();
      const localFingerprint = await merger.fingerprint(local);
      const conflictKey = `${cloudKey}:${localFingerprint}`;
      const mergedHeads = history.heads.map((head) => head.id);
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
      const result = await merger.reconcile(local, remote, knownBase, choicesFor('device:'));
      conflicts = [
        ...conflicts,
        ...result.conflicts.map((conflict) => ({ ...conflict, id: `device:${conflict.id}` }))
      ];
      if (conflicts.length) {
        showConflicts(conflicts);
        return;
      }
      const state = await options.store.validateState(result.state);
      const stateFingerprint = await merger.fingerprint(state);
      let replaced = false;
      if (stateFingerprint !== localFingerprint) {
        active(startedEpoch);
        applying = true;
        try {
          await options.store.replaceState(state, local);
          replaced = true;
        } finally {
          applying = false;
        }
      }
      active(startedEpoch);
      // Once data is safely local, quota/network failure can only delay its cloud publication.
      if (history.heads.length !== 1 || stateFingerprint !== (await merger.fingerprint(remote))) {
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
        const publication = await transport.upload(upload.revision, upload.bytes);
        uploading = false;
        active(startedEpoch);
        baselineHeads = [upload.revision.id];
        const published = { ...upload.revision, ...publication };
        decoded.set(revisionKey(published), state);
        audited.add(revisionKey(published));
        revisions.push(published);
        pendingUpload = null;
      } else baselineHeads = mergedHeads;
      baseline = state;
      checkpoint = replaced
        ? null
        : {
            cloud: canonical(
              revisions
                .map(({ id, sha256, parents, fileId, contentVersion }) => ({
                  id,
                  sha256,
                  parents,
                  fileId,
                  contentVersion
                }))
                .sort((a, b) => a.id.localeCompare(b.id) || a.fileId.localeCompare(b.fileId))
            ),
            revision: localRevision
          };
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
    audited.clear();
    checkpoint = null;
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
