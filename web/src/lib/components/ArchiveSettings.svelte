<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import DriveIcon from './DriveIcon.svelte';
  import LoadingRegion from './LoadingRegion.svelte';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import { trackOperation } from '$lib/telemetry/browser';
  import type { BackupPreview } from '$lib/local/restore';
  import type { Resolutions, SyncConflict } from '$lib/sync/reconcile';
  import type { Profile } from '$lib/api';
  import type { createLocalClient } from '$lib/local/client';
  import { MAX_COMPRESSED_BYTES } from '$lib/local/limits';
  import type { createDriveSync, SyncStatus } from '$lib/sync/controller';
  import type { PublicClient, PublicConfig } from '$lib/public-api';
  import { identityKey } from '$lib/local/types';
  import { submissionIdentity, snapshotSubmissionIdentity } from '$lib/submission-policy';
  import { submissionBatches } from '$lib/submission-batches';

  let {
    local,
    profiles,
    activeProfileId,
    googleClientId = '',
    drive,
    onchanged,
    onselect,
    onrecover,
    publicApi,
    publicConfig,
    section = 'all',
    importBusy = false,
    pendingRestoreFile = null,
    restoreRequest = 0,
    onrestoreaccepted,
    onbusychange
  }: {
    local: ReturnType<typeof createLocalClient>;
    profiles: Profile[];
    activeProfileId: string;
    googleClientId?: string;
    drive?: ReturnType<typeof createDriveSync>;
    onchanged: () => Promise<void>;
    onselect?: (id: string) => void;
    onrecover?: () => void;
    publicApi?: PublicClient;
    publicConfig?: PublicConfig | null;
    section?: 'profiles' | 'backup' | 'privacy' | 'all';
    importBusy?: boolean;
    pendingRestoreFile?: File | null;
    restoreRequest?: number;
    onrestoreaccepted?: () => void;
    onbusychange?: (busy: boolean) => void;
  } = $props();

  let busy = $state(false),
    error = $state(''),
    notice = $state('');
  let newName = $state(''),
    renameId = $state(''),
    renameName = $state('');
  let deleting = $state(''),
    deleteEverywhere = $state(false);
  let restoreFile = $state<File | null>(null),
    replace = $state(false);
  let confirmReplace = $state(false);
  let restorePreview = $state<BackupPreview | null>(null);
  let restoreDecisions = $state<Record<string, 'local' | 'remote'>>({});
  let restoreResolutions: Resolutions = {};
  let committingRestore = false;
  function resetRestorePreview() {
    restorePreview = null;
    restoreDecisions = {};
    restoreResolutions = {};
  }
  $effect(() =>
    local.subscribe((revision) => {
      if (!committingRestore && restorePreview && restorePreview.revision !== revision) {
        resetRestorePreview();
        notice = 'Your archive changed. Review the selected backup again before restoring it.';
      }
    })
  );
  function conflictTitle(conflict: SyncConflict): string {
    return conflict.kind === 'delete-edit'
      ? 'Deletion and newer changes'
      : conflict.kind === 'setting'
        ? 'Different preferences'
        : conflict.kind === 'rename'
          ? 'Different profile names'
          : 'Different account identities';
  }
  let restoreHeading = $state<HTMLHeadingElement>();
  let acceptedRestoreRequest = -1;
  $effect(() => {
    const request = restoreRequest;
    const heading = restoreHeading;
    if (!request || !heading || request === acceptedRestoreRequest) return;
    acceptedRestoreRequest = request;
    // Acknowledgement clears the parent handoff; it must not retrigger selection or focus.
    untrack(() => {
      if (pendingRestoreFile) {
        restoreFile = pendingRestoreFile;
        resetRestorePreview();
        replace = false;
        confirmReplace = false;
        error = '';
        notice = '';
      }
      onrestoreaccepted?.();
    });
    void tick().then(() => heading.focus());
  });
  let decisions = $state<Record<string, 'local' | 'remote'>>({});
  let serverAccount = $state(''),
    serverAction = $state<'delete' | 'associate' | ''>('');
  let uploadProfileId = $state('');
  let sync = $state<SyncStatus>({
    phase: 'disconnected',
    message: 'Google Drive is not connected.',
    lastSyncedAt: null,
    conflicts: [],
    resolutionGeneration: null
  });
  const active = $derived(profiles.find((profile) => profile.id === activeProfileId));
  const verifiedAccount = $derived(
    publicConfig?.accounts.find((account) => account.account_id === serverAccount)
  );
  const matchingProfile = $derived(
    verifiedAccount
      ? profiles.find(
          (profile) =>
            identityKey(profile) !== null &&
            identityKey(profile) === identityKey(verifiedAccount.identity)
        )
      : undefined
  );
  const uploadProfile = $derived(
    profiles.find(
      (profile) => profile.id === (uploadProfileId || matchingProfile?.id || activeProfileId)
    )
  );
  const uploadIdentity = $derived(
    uploadProfile && verifiedAccount
      ? submissionIdentity(uploadProfile, verifiedAccount.identity)
      : null
  );
  $effect(() =>
    drive?.subscribe((status) => {
      // subscribe emits synchronously. Reading sync here must not make the
      // subscription effect depend on its own incoming status updates.
      untrack(() => {
        if (sync.resolutionGeneration !== status.resolutionGeneration) decisions = {};
        sync = status;
      });
    })
  );

  let signingIn = $state(false);
  function cancelOwnedSignIn() {
    if (signingIn && drive?.status.phase === 'connecting') drive.disconnect();
  }
  onDestroy(cancelOwnedSignIn);
  $effect(() => {
    if (signingIn && section !== 'backup' && section !== 'all') cancelOwnedSignIn();
  });
  async function connectDrive() {
    signingIn = true;
    try {
      await drive?.connect();
      // A cancelled sign-in has no archive changes to refresh. In particular,
      // unmounting must not restart a closed archive worker through onchanged.
      if (drive && drive.status.phase !== 'disconnected') await onchanged();
    } finally {
      signingIn = false;
    }
  }

  let operationReported = false;
  function completed(operation: 'backup' | 'restore', started: number) {
    operationReported = true;
    trackOperation(operation, 'success', performance.now() - started);
  }
  async function run(action: () => Promise<void>, operation?: 'backup' | 'restore') {
    if (busy || importBusy) return;
    busy = true;
    const notifyBusy = onbusychange;
    notifyBusy?.(true);
    error = '';
    notice = '';
    operationReported = false;
    const started = performance.now();
    try {
      await action();
    } catch (cause) {
      if (operation && !operationReported)
        trackOperation(operation, 'failed', performance.now() - started);
      error =
        cause instanceof Error
          ? cause.message
          : 'The action could not finish. Your saved archive is still available.';
    } finally {
      busy = false;
      notifyBusy?.(false);
    }
  }
  function download(bytes: Uint8Array, name: string) {
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: 'application/gzip' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportArchive(current = false) {
    const started = performance.now();
    if (current && !activeProfileId) throw new Error('Select a profile to export.');
    const state = await local.exportState();
    if (current) {
      state.profiles = state.profiles.filter((p) => p.id === activeProfileId);
      state.tombstones = [];
      state.settings = {};
    }
    download(
      await local.encodeBackup(state),
      `gfl2-${current ? 'profile' : 'archive'}-${new Date().toISOString().slice(0, 10)}.json.gz`
    );
    completed('backup', started);
    notice = 'Compressed archive downloaded. Keep a copy somewhere you can recover it.';
  }
  async function restore() {
    const started = performance.now();
    if (!restoreFile) throw new Error('Choose a compressed tracker archive first.');
    if (restoreFile.size > MAX_COMPRESSED_BYTES)
      throw new Error('This archive exceeds the 16 MiB compressed limit.');
    if (replace && !confirmReplace) throw new Error('Confirm replacement before restoring.');
    const bytes = new Uint8Array(await restoreFile.arrayBuffer());
    const release = await drive?.acquirePause();
    try {
      // A choice is valid only for the exact alternatives shown at this revision.
      if (restorePreview && restorePreview.revision !== (await local.revision()))
        resetRestorePreview();
      for (const conflict of restorePreview?.conflicts ?? []) {
        const choice = restoreDecisions[conflict.id];
        if (choice) restoreResolutions[conflict.id] = { choice, fingerprint: conflict.fingerprint };
      }
      restorePreview = await local.previewBackup(
        bytes,
        replace,
        structuredClone(restoreResolutions)
      );
      restoreDecisions = {};
      if (restorePreview.conflicts.length) return;
      // Keep the inspected identity even if a cross-tab notification clears the
      // visible preview while its independent recovery copy is being encoded.
      const previewId = restorePreview.id;
      download(await local.exportBackup(), `gfl2-before-restore-${Date.now()}.json.gz`);
      committingRestore = true;
      try {
        await local.commitBackup(previewId);
        completed('restore', started);
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'StaleBackupPreviewError') {
          resetRestorePreview();
          restorePreview = await local.previewBackup(bytes, replace, {});
          throw new Error(
            'Your archive changed while preparing the restore. Review the refreshed preview and try again.'
          );
        }
        throw cause;
      } finally {
        committingRestore = false;
      }
      await onchanged();
      resetRestorePreview();
      restoreFile = null;
      confirmReplace = false;
      notice = replace
        ? 'Archive replaced. The previous archive was downloaded before replacement.'
        : 'Archive merged. A recovery copy was downloaded. Repeated imports preserve legitimate duplicate pulls.';
    } finally {
      // User choices happen outside the lease so Drive can continue while a dialog is open.
      release?.();
    }
  }
  async function recoverServer() {
    const started = performance.now();
    if (!publicApi || !verifiedAccount) throw new Error('Choose a verified account first.');
    const backup = await publicApi.backup(verifiedAccount.account_id);
    const profile = matchingProfile ?? (await local.createProfile(backup.name));
    for (const snapshot of backup.snapshots)
      await local.importRecords({ ...snapshot, profile_id: profile.id });
    completed('restore', started);
    await onchanged();
    onselect?.(profile.id);
    notice = 'Private server backup merged into this device.';
  }
  async function saveServer(associate = false) {
    const started = performance.now();
    if (!publicApi || !verifiedAccount || !uploadProfile)
      throw new Error('Choose an authorized account and a local profile before submitting.');
    const account = verifiedAccount;
    const profileId = uploadProfile.id;
    // Freeze the deletion generation before asynchronous export; a later deletion must win.
    const expectedVersion = account.history_version;
    const state = await local.exportState();
    const profile = state.profiles.find((profile) => profile.id === profileId);
    if (!profile) throw new Error('This profile is no longer available. Refresh the archive.');
    const identity = submissionIdentity(profile, account.identity);
    if (identity === 'conflict')
      throw new Error(
        'This profile belongs to a different account. Choose the matching account or profile.'
      );
    const snapshots = profile.snapshots.map((snapshot) => ({
      records_document: snapshot.document,
      ...(snapshot.manifest ? { manifest: snapshot.manifest } : {}),
      ...(snapshot.raw_pages ? { raw_pages: snapshot.raw_pages } : {})
    }));
    const snapshotIdentity = snapshotSubmissionIdentity(snapshots, account.identity);
    if (snapshotIdentity === 'conflict')
      throw new Error(
        'A saved snapshot belongs to a different account. Choose the matching account or profile.'
      );
    if ((identity === 'associate' || snapshotIdentity === 'associate') && !associate) {
      serverAction = 'associate';
      return;
    }
    const batches = submissionBatches(
      {
        account_id: account.account_id,
        expected_version: expectedVersion,
        associate,
        name: profile.name,
        snapshots
      },
      publicConfig?.limits.request_bytes
    );
    let saved = 0;
    try {
      for (const batch of batches) {
        await publicApi.submitHistory(batch);
        saved++;
      }
    } catch (cause) {
      if (!saved) throw cause;
      throw new Error(
        `${saved} of ${batches.length} history batches were saved. ${cause instanceof Error ? cause.message : 'Submission could not be confirmed.'} No remaining batches were sent.`
      );
    }
    completed('backup', started);
    serverAction = '';
    notice =
      'Server history saved and included in community statistics. Your browser profile identity is unchanged.';
  }
</script>

{#if (section === 'backup' || section === 'all') && sync.phase === 'connecting'}
  <div class="actions" role="group" aria-label="Google sign-in">
    <button onclick={() => drive?.disconnect()}>Cancel sign-in</button>
  </div>
{/if}

{#if section === 'privacy' || section === 'all'}<TelemetrySettings />{/if}
<fieldset class="settings ph-no-capture" disabled={importBusy || busy} aria-busy={busy}>
  {#if importBusy}<p class="availability" role="status">
      Profile and archive changes are unavailable while an import is collecting or saving history.
    </p>{/if}
  {#if section === 'profiles' || section === 'all'}
    <section aria-labelledby="profiles-heading">
      <header>
        <h2 id="profiles-heading">Game profiles</h2>
        <p>Keep each account’s recruitment history in its own ledger.</p>
      </header>
      <form
        class="create-row"
        onsubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const profile = await local.createProfile(newName.trim());
            newName = '';
            await onchanged();
            onselect?.(profile.id);
            notice = 'Profile created.';
          });
        }}
      >
        <label
          >New profile name<input
            bind:value={newName}
            maxlength="120"
            required
            placeholder="For example, Europe account"
          /></label
        >
        <button class="primary" disabled={busy || !newName.trim()}>Create profile</button>
      </form>
      {#if profiles.length === 0}<p class="empty">
          No profiles yet. Create one, then import its history.
        </p>{/if}
      <ul class="profile-list">
        {#each profiles as profile (profile.id)}
          <li>
            <div class="profile-title">
              <strong>{profile.name}</strong>{#if profile.id === activeProfileId}<span
                  >Selected</span
                >{/if}
            </div>
            <p class="identity">
              {profile.server ?? 'Server not assigned'} · {profile.endpoint_host ??
                'Account identity will be assigned when importing'}
            </p>
            {#if renameId === profile.id}
              <form
                class="inline-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await local.renameProfile(profile.id, renameName.trim());
                    renameId = '';
                    await onchanged();
                    notice = 'Profile renamed.';
                  });
                }}
              >
                <label>Profile name<input bind:value={renameName} maxlength="120" required /></label
                >
                <button disabled={busy || !renameName.trim()}>Save name</button><button
                  type="button"
                  onclick={() => (renameId = '')}>Cancel</button
                >
              </form>
            {:else}
              <div class="actions">
                {#if onselect && profile.id !== activeProfileId}<button
                    disabled={busy}
                    onclick={() => onselect?.(profile.id)}>Select profile</button
                  >{/if}
                <button
                  disabled={busy}
                  onclick={() => {
                    renameId = profile.id;
                    renameName = profile.name;
                  }}>Rename</button
                >
                <button
                  disabled={busy}
                  onclick={() => {
                    deleting = profile.id;
                    deleteEverywhere = false;
                  }}>Remove…</button
                >
              </div>
            {/if}
            {#if deleting === profile.id}
              <div class="confirmation">
                <p>
                  <strong>Remove {profile.name}?</strong> Export a copy first if you may need this history
                  again.
                </p>
                <label class="check"
                  ><input type="checkbox" bind:checked={deleteEverywhere} /> Delete across synced devices</label
                >
                <p class="muted">
                  {deleteEverywhere
                    ? 'A deletion will be included in your next Drive sync. Concurrent edits require a choice. Historical Drive revisions still retain earlier copies.'
                    : 'Only this device removes the profile. Its Drive and server backups remain available.'}
                </p>
                <div class="actions">
                  <button
                    class="primary"
                    disabled={busy}
                    onclick={() =>
                      run(async () => {
                        await local.deleteProfile(profile.id, deleteEverywhere);
                        deleting = '';
                        await onchanged();
                        notice = deleteEverywhere
                          ? 'Profile deleted. Sync Drive to share the deletion.'
                          : 'Profile removed from this device.';
                      })}
                    >{deleteEverywhere
                      ? 'Delete across devices'
                      : 'Remove from this device'}</button
                  ><button disabled={busy} onclick={() => (deleting = '')}>Cancel</button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if section === 'backup' || section === 'all'}
    <section aria-labelledby="backup-heading">
      <header>
        <h2 id="backup-heading">Backup &amp; Sync</h2>
        <p>
          Your archive saves in this browser. Export it or connect Google Drive to recover it on
          another device.
        </p>
      </header>
      <div class="backup-columns">
        <div>
          <h3>Download an archive</h3>
          <p>
            Compressed backups include profiles, pull histories, and source evidence. Captures and
            access tokens are excluded.
          </p>
          <div class="actions">
            <button
              disabled={busy || !profiles.length}
              onclick={() => run(() => exportArchive(), 'backup')}>Export all profiles</button
            ><button
              disabled={busy || !active}
              onclick={() => run(() => exportArchive(true), 'backup')}
              >Export selected profile</button
            >
          </div>
          <h3 id="restore-heading" bind:this={restoreHeading} tabindex="-1">Restore an archive</h3>
          <p>
            A tracker backup restores its contained profiles into this browser’s archive. It does
            not import every profile’s history into the currently selected profile.
          </p>
          <label
            >Compressed tracker backup<input
              type="file"
              accept=".gz,.gzip,application/gzip"
              onchange={(event) => {
                restoreFile = event.currentTarget.files?.[0] ?? null;
                resetRestorePreview();
                replace = false;
                confirmReplace = false;
              }}
            /></label
          >
          {#if restoreFile}<p class="selected-file">
              Selected backup: <strong>{restoreFile.name}</strong>
            </p>{/if}
          <label class="check"
            ><input
              type="checkbox"
              bind:checked={replace}
              onchange={() => {
                confirmReplace = false;
                resetRestorePreview();
              }}
            /> Replace this device’s archive instead of merging</label
          >
          {#if replace}<label class="check"
              ><input type="checkbox" bind:checked={confirmReplace} /> I understand the current archive
              will be replaced. A recovery copy will download first.</label
            >{/if}
          <LoadingRegion {busy} message="">
            {#if restorePreview?.conflicts.length}
              <div class="confirmation">
                <h3>Resolve backup changes</h3>
                <p>Choose which version to keep. Nothing has been changed yet.</p>
                {#each restorePreview.conflicts as conflict (conflict.id)}
                  <fieldset>
                    <legend>{conflict.profileName} · {conflictTitle(conflict)}</legend>
                    <label class="check"
                      ><input
                        type="radio"
                        name={`backup-conflict-${conflict.id}`}
                        checked={restoreDecisions[conflict.id] === 'local'}
                        onchange={() =>
                          (restoreDecisions = { ...restoreDecisions, [conflict.id]: 'local' })}
                      />This device: {conflict.localLabel}</label
                    >
                    <label class="check"
                      ><input
                        type="radio"
                        name={`backup-conflict-${conflict.id}`}
                        checked={restoreDecisions[conflict.id] === 'remote'}
                        onchange={() =>
                          (restoreDecisions = { ...restoreDecisions, [conflict.id]: 'remote' })}
                      />Backup: {conflict.remoteLabel}</label
                    >
                  </fieldset>
                {/each}
              </div>
            {/if}
          </LoadingRegion>
          <div class="actions">
            <button
              class="primary"
              disabled={busy ||
                !restoreFile ||
                (replace && !confirmReplace) ||
                restorePreview?.conflicts.some((conflict) => !restoreDecisions[conflict.id])}
              onclick={() => run(restore, 'restore')}
              >{restorePreview?.conflicts.length
                ? 'Apply backup choices'
                : replace
                  ? 'Replace archive'
                  : 'Merge archive'}</button
            >
            <button
              class="text-button"
              disabled={busy}
              onclick={() =>
                run(async () => {
                  const previous = await local.recoverySnapshot();
                  if (!previous)
                    throw new Error(
                      'No previous archive is saved on this device yet. A recovery snapshot is kept when an archive is replaced.'
                    );
                  download(
                    await local.encodeBackup(previous),
                    `gfl2-recovery-${Date.now()}.json.gz`
                  );
                  notice =
                    'Previous archive downloaded. Choose that file above to merge or restore it.';
                })}>Download previous archive</button
            >
          </div>
        </div>
        <div>
          <h3>Google Drive</h3>
          <p>
            Sync uses this app’s private folder in your Drive. Other Drive files are not accessible.
            Sync runs while this page is open; reconnect when Google authorization expires.
          </p>
          <dl class="save-status">
            <div>
              <dt>Local storage</dt>
              <dd>Saved changes stay in this browser</dd>
            </div>
            <div>
              <dt>Cloud sync</dt>
              <dd>
                <LoadingRegion
                  busy={sync.phase === 'syncing' || sync.phase === 'connecting'}
                  message={sync.message}
                >
                  <span role="status">{sync.message}</span>
                </LoadingRegion>
              </dd>
            </div>
            {#if sync.lastSyncedAt}<div>
                <dt>Last synced</dt>
                <dd>{new Date(sync.lastSyncedAt).toLocaleString()}</dd>
              </div>{/if}
          </dl>
          {#if !googleClientId}<p class="muted">
              Google Drive is unavailable on this installation because its Google client has not
              been configured. Downloadable backups remain available.
            </p>{/if}
          <div class="actions">
            {#if ['disconnected', 'reconnect'].includes(sync.phase)}<button
                class="primary"
                disabled={busy || !drive || !googleClientId}
                onclick={() => run(connectDrive)}
                ><DriveIcon />{sync.phase === 'reconnect'
                  ? 'Reconnect Google Drive'
                  : 'Connect Google Drive'}</button
              >
            {:else}<button
                disabled={busy ||
                  !drive ||
                  sync.phase === 'syncing' ||
                  sync.phase === 'connecting' ||
                  sync.phase === 'conflict'}
                onclick={() =>
                  run(async () => {
                    await drive?.sync();
                    await onchanged();
                  })}><DriveIcon />Sync now</button
              ><button disabled={busy || !drive} onclick={() => drive?.disconnect()}
                >Disconnect</button
              >{/if}
            {#if sync.phase === 'error'}<button
                disabled={busy || !drive || !googleClientId}
                onclick={() => run(connectDrive)}><DriveIcon />Reconnect Google Drive</button
              >{/if}
          </div>
          <LoadingRegion busy={sync.phase === 'syncing'} message="">
            {#if sync.conflicts.length}
              <div class="confirmation">
                <h3>Choose how to resolve changes</h3>
                <p>
                  Both versions remain available until you choose. Pull histories merge where their
                  account identities agree.
                </p>
                {#each sync.conflicts as conflict (conflict.id)}<fieldset>
                    <legend
                      >{conflict.profileName} · {conflict.kind === 'delete-edit'
                        ? 'Deletion and newer changes'
                        : conflict.kind === 'setting'
                          ? 'Different preferences'
                          : conflict.kind === 'rename'
                            ? 'Different profile names'
                            : 'Different account identities'}</legend
                    ><label class="check"
                      ><input
                        type="radio"
                        name={`conflict-${conflict.id}`}
                        checked={decisions[conflict.id] === 'local'}
                        onchange={() => (decisions = { ...decisions, [conflict.id]: 'local' })}
                      />
                      {conflict.id.startsWith('lineage:')
                        ? 'Earlier account binding'
                        : conflict.id.startsWith('branch:')
                          ? 'Earlier cloud revision'
                          : 'This device'}:
                      {conflict.localLabel}</label
                    ><label class="check"
                      ><input
                        type="radio"
                        name={`conflict-${conflict.id}`}
                        checked={decisions[conflict.id] === 'remote'}
                        onchange={() => (decisions = { ...decisions, [conflict.id]: 'remote' })}
                      />
                      {conflict.id.startsWith('lineage:')
                        ? 'Other account binding'
                        : conflict.id.startsWith('branch:')
                          ? 'Other cloud revision'
                          : 'Google Drive'}:
                      {conflict.remoteLabel}</label
                    >
                  </fieldset>{/each}
                <button
                  class="primary"
                  disabled={busy || sync.conflicts.some((conflict) => !decisions[conflict.id])}
                  onclick={() =>
                    run(async () => {
                      await drive?.resolve({
                        generation: sync.resolutionGeneration,
                        choices: { ...decisions }
                      });
                      decisions = {};
                      await onchanged();
                    })}>Apply choices and sync</button
                >
              </div>
            {/if}
          </LoadingRegion>
          <h3>Import from another tracker</h3>
          <p>
            Bring older history into your selected game profile. External imports merge with your
            saved pulls, preserving repeated records without counting the same history twice.
          </p>
          <p>
            <a href="/guides/exilium" target="_blank" rel="noreferrer"
              >Exilium migration guide (opens in a new tab)</a
            >
          </p>
        </div>
      </div>
    </section>
  {/if}

  {#if section === 'privacy' || section === 'all'}
    <section aria-labelledby="privacy-heading">
      <header>
        <h2 id="privacy-heading">Privacy &amp; recovery</h2>
        <p>You choose where your history goes each time you collect it.</p>
        <p><a href="/privacy-policy">Read the full privacy policy</a></p>
      </header>
      <dl class="privacy-list">
        <div>
          <dt>On this device</dt>
          <dd>
            Your profiles and source snapshots are saved in this browser. Clearing this site’s data
            removes them. Export a backup first.
          </dd>
        </div>
        <div>
          <dt>Google Drive</dt>
          <dd>
            Only this app’s backup folder is accessible. Disconnecting ends automatic sync; it does
            not delete saved Drive revisions or your local history.
          </dd>
        </div>
        <div>
          <dt>Server backup</dt>
          <dd>
            Saving server history also contributes to community statistics. Turning submission off
            stops future saves; deleting server history removes both the backup and its statistics
            contribution. Server access requires proof of account ownership.
          </dd>
        </div>
        <div>
          <dt>Community statistics</dt>
          <dd>
            Server fetches and exports explicitly saved to the server use the same history. File
            imports stay local until you choose to submit them. Public results contain aggregates;
            small groups are withheld.
          </dd>
        </div>
        <div>
          <dt>Captures and credentials</dt>
          <dd>
            A capture can contain a temporary game credential. It is cleared after use and is not
            saved in backups. When you choose server fetching, it passes through the server’s
            memory.
          </dd>
        </div>
      </dl>
      {#if publicConfig && !publicConfig.identity_verification.available}<p class="availability">
          Server recovery and contributions are unavailable: {publicConfig.identity_verification
            .reason} Browser archives, downloads, and configured Drive sync remain available.
        </p>{/if}
      {#if onrecover}<button
          disabled={!publicConfig?.identity_verification.available}
          onclick={onrecover}>Verify account to manage server data</button
        >{/if}
      {#if publicConfig?.accounts.length}
        <div class="server-data">
          <h3>Manage a verified account</h3>
          <label
            >Verified account<select bind:value={serverAccount} onchange={() => (serverAction = '')}
              ><option value="">Choose an account</option
              >{#each publicConfig.accounts as account}<option value={account.account_id}
                  >{account.identity.uid} · {account.identity.server} · {account.identity
                    .endpoint_host} · {account.account_id.slice(0, 8)}</option
                >{/each}</select
            ></label
          >
          <label
            >Local profile to submit<select
              value={uploadProfile?.id ?? ''}
              onchange={(event) => {
                uploadProfileId = event.currentTarget.value;
                serverAction = '';
              }}
              ><option value="">Choose a profile</option>{#each profiles as profile}<option
                  value={profile.id}>{profile.name}</option
                >{/each}</select
            ></label
          >
          {#if uploadIdentity === 'conflict'}<p class="availability">
              This profile’s known identity conflicts with the authorized account. Choose a matching
              profile.
            </p>{/if}
          <p class="small">
            Contribute to community statistics / Save server backup: submitting this profile saves
            its history for recovery and includes it in aggregate statistics.
          </p>
          <div class="actions">
            <button
              disabled={busy ||
                !verifiedAccount ||
                !publicConfig.features.submit_history ||
                !publicConfig.identity_verification.available}
              onclick={() => run(recoverServer, 'restore')}>Recover server backup</button
            ><button
              disabled={busy ||
                !uploadProfile ||
                !verifiedAccount ||
                uploadIdentity === 'conflict' ||
                !publicConfig.features.submit_history ||
                !publicConfig.identity_verification.available}
              onclick={() => {
                if (uploadIdentity === 'associate') serverAction = 'associate';
                else void run(() => saveServer(), 'backup');
              }}>Save profile to server</button
            ><button
              disabled={busy ||
                !verifiedAccount ||
                !publicConfig.features.submit_history ||
                !publicConfig.identity_verification.available}
              onclick={() => (serverAction = 'delete')}>Delete server history…</button
            >
          </div>
          {#if serverAction}<div class="confirmation">
              <p>
                {serverAction === 'associate'
                  ? `Submit “${uploadProfile?.name}” as history for authorized account UID ${verifiedAccount?.identity.uid} on server ${verifiedAccount?.identity.server}? This export has incomplete account identity. Confirm that it belongs to this account. The browser profile identity will remain unchanged.`
                  : 'Delete this account’s server history? This removes its server backup and excludes its history from future community statistics. Browser and Drive copies remain available. A future submission can save this history again.'}
              </p>
              <div class="actions">
                <button
                  class="primary"
                  disabled={busy}
                  onclick={() =>
                    run(
                      async () => {
                        if (!publicApi || !verifiedAccount) return;
                        if (serverAction === 'associate') {
                          await saveServer(true);
                          return;
                        }
                        await publicApi.deleteBackup(verifiedAccount.account_id);
                        notice =
                          'Server history deleted; its backup and statistics contribution were removed.';
                        serverAction = '';
                        publicConfig = await publicApi.config();
                      },
                      serverAction === 'associate' ? 'backup' : undefined
                    )}
                  >{serverAction === 'associate'
                    ? 'Confirm association and submit'
                    : 'Confirm deletion'}</button
                ><button disabled={busy} onclick={() => (serverAction = '')}>Cancel</button>
              </div>
            </div>{/if}
        </div>
      {/if}
    </section>
  {/if}
  <LoadingRegion {busy} message="Updating your archive…">
    {#if error}<p class="feedback error" role="alert">{error}</p>{/if}
    {#if notice}<p class="feedback" role="status">{notice}</p>{/if}
  </LoadingRegion>
</fieldset>

<style>
  .settings {
    border: 0;
    border-top: 2px solid var(--ink);
    padding: 24px 0 0;
    margin: 0;
    min-width: 0;
  }
  .selected-file {
    overflow-wrap: anywhere;
  }
  section + section {
    margin-top: 40px;
    padding-top: 28px;
    border-top: 1px solid var(--line);
  }
  header {
    margin-bottom: 24px;
  }
  h2 {
    margin: 0;
  }
  h3 {
    margin: 28px 0 10px;
  }
  .backup-columns > div > h3:first-child {
    margin-top: 0;
  }
  p {
    max-width: 72ch;
    line-height: 1.6;
    margin: 8px 0 16px;
  }
  .muted,
  .identity {
    color: var(--muted);
  }
  label {
    display: grid;
    gap: 7px;
    font-weight: 500;
    margin-bottom: 14px;
  }
  input {
    max-width: 100%;
    min-width: 0;
  }
  input[type='file'] {
    width: 100%;
    padding: 9px;
  }
  .create-row,
  .inline-form {
    display: flex;
    gap: 12px;
    align-items: end;
    flex-wrap: wrap;
  }
  .create-row label,
  .inline-form label {
    flex: 1;
    min-width: 180px;
    max-width: 380px;
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .profile-list {
    padding: 0;
    list-style: none;
    margin: 24px 0 0;
  }
  .profile-list > li {
    padding: 20px 0;
    border-top: 1px solid var(--line);
  }
  .profile-title {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .profile-title strong {
    font-size: 1.15rem;
  }
  .profile-title span {
    color: var(--accent-text);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .identity {
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .empty {
    padding: 20px 0;
  }
  .backup-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 48px;
  }
  .check {
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: start;
    font-weight: 400;
    line-height: 1.5;
    margin: 16px 0;
  }
  .check input {
    width: 17px;
    height: 17px;
    min-height: 17px;
    flex: 0 0 17px;
    margin-top: 3px;
    accent-color: var(--accent-text);
  }
  .confirmation {
    margin-top: 16px;
    background: var(--surface);
    padding: 18px;
  }
  .confirmation h3 {
    margin-top: 0;
  }
  fieldset {
    border: 1px solid var(--control-line);
    margin: 20px 0;
    padding: 12px;
    min-width: 0;
  }
  legend {
    font-weight: 600;
    padding: 0 5px;
  }
  dl {
    margin: 20px 0;
  }
  dl > div {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 20px;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .privacy-list {
    max-width: 850px;
  }
  .privacy-list > div {
    grid-template-columns: 160px 1fr;
  }
  .feedback {
    padding: 16px 0;
    margin-top: 24px;
    border-top: 1px solid var(--line);
  }
  .error {
    color: var(--danger);
  }
  .availability {
    padding: 16px;
    background: var(--surface);
  }
  .server-data {
    margin-top: 28px;
  }
  .server-data select {
    max-width: 100%;
  }
  @media (max-width: 760px) {
    .backup-columns {
      grid-template-columns: 1fr;
      gap: 32px;
    }
    .backup-columns > div + div {
      border-top: 1px solid var(--line);
      padding-top: 28px;
    }
    .privacy-list > div,
    dl > div {
      grid-template-columns: 1fr;
      gap: 6px;
    }
    .create-row label,
    .inline-form label {
      max-width: none;
      width: 100%;
    }
  }
</style>
