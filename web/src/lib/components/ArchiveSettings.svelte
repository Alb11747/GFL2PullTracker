<script lang="ts">
  import type { Profile } from '$lib/api';
  import type { createLocalClient } from '$lib/local/client';
  import { MAX_COMPRESSED_BYTES } from '$lib/local/backup';
  import type { createDriveSync, SyncStatus } from '$lib/sync/controller';
  import type { PublicClient, PublicConfig } from '$lib/public-api';
  import { identityKey } from '$lib/local/types';

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
    section = 'all'
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
  let decisions = $state<Record<string, 'local' | 'remote'>>({});
  let serverAccount = $state(''),
    serverAction = $state<'backup' | 'contribution' | ''>('');
  let sync = $state<SyncStatus>({
    phase: 'disconnected',
    message: 'Google Drive is not connected.',
    lastSyncedAt: null,
    conflicts: []
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
  $effect(() =>
    drive?.subscribe((status) => {
      sync = status;
    })
  );

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await action();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The action could not finish. Your saved archive is still available.';
    } finally {
      busy = false;
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
    notice = 'Compressed archive downloaded. Keep a copy somewhere you can recover it.';
  }
  async function restore() {
    if (!restoreFile) throw new Error('Choose a compressed tracker archive first.');
    if (restoreFile.size > MAX_COMPRESSED_BYTES)
      throw new Error('This archive exceeds the 16 MiB compressed limit.');
    if (replace && !confirmReplace) throw new Error('Confirm replacement before restoring.');
    const bytes = new Uint8Array(await restoreFile.arrayBuffer());
    await local.decodeBackup(bytes);
    // A downloadable copy remains recoverable independently of the database replacement.
    if (replace) download(await local.exportBackup(), `gfl2-before-restore-${Date.now()}.json.gz`);
    await local.importBackup(bytes, replace);
    await onchanged();
    restoreFile = null;
    confirmReplace = false;
    notice = replace
      ? 'Archive replaced. The previous archive was downloaded before replacement.'
      : 'Archive merged. Repeated imports retain legitimate duplicate pulls without counting them twice.';
  }
  async function recoverServer() {
    if (!publicApi || !verifiedAccount) throw new Error('Choose a verified account first.');
    const backup = await publicApi.backup(verifiedAccount.account_id);
    const profile = matchingProfile ?? (await local.createProfile(backup.name));
    for (const snapshot of backup.snapshots)
      await local.importRecords({ ...snapshot, profile_id: profile.id });
    await onchanged();
    onselect?.(profile.id);
    notice = 'Private server backup merged into this device.';
  }
  async function saveServer() {
    if (!publicApi || !verifiedAccount || !matchingProfile)
      throw new Error('Import this verified account’s history before saving a server backup.');
    const state = await local.exportState();
    const profile = state.profiles.find((profile) => profile.id === matchingProfile.id);
    if (!profile) throw new Error('This profile is no longer available. Refresh the archive.');
    await publicApi.saveBackup({
      account_id: verifiedAccount.account_id,
      name: profile.name,
      snapshots: profile.snapshots.map((snapshot) => ({
        records_document: snapshot.document,
        ...(snapshot.manifest ? { manifest: snapshot.manifest } : {}),
        ...(snapshot.raw_pages ? { raw_pages: snapshot.raw_pages } : {})
      }))
    });
    notice =
      'Private server backup saved. Uploaded records do not contribute to community statistics.';
  }
</script>

<div class="settings" aria-busy={busy}>
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
            <button disabled={busy || !profiles.length} onclick={() => run(() => exportArchive())}
              >Export all profiles</button
            ><button disabled={busy || !active} onclick={() => run(() => exportArchive(true))}
              >Export selected profile</button
            >
          </div>
          <h3>Restore an archive</h3>
          <label
            >Compressed tracker backup<input
              type="file"
              accept=".gz,.gzip,application/gzip"
              onchange={(event) => {
                restoreFile = event.currentTarget.files?.[0] ?? null;
                confirmReplace = false;
              }}
            /></label
          >
          <label class="check"
            ><input
              type="checkbox"
              bind:checked={replace}
              onchange={() => (confirmReplace = false)}
            /> Replace this device’s archive instead of merging</label
          >
          {#if replace}<label class="check"
              ><input type="checkbox" bind:checked={confirmReplace} /> I understand the current archive
              will be replaced. A recovery copy will download first.</label
            >{/if}
          <div class="actions">
            <button
              class="primary"
              disabled={busy || !restoreFile || (replace && !confirmReplace)}
              onclick={() => run(restore)}>{replace ? 'Replace archive' : 'Merge archive'}</button
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
              <dd role="status">{sync.message}</dd>
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
                onclick={() =>
                  run(async () => {
                    await drive?.connect();
                    await onchanged();
                  })}
                >{sync.phase === 'reconnect'
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
                  })}>Sync now</button
              ><button disabled={busy || !drive} onclick={() => drive?.disconnect()}
                >Disconnect</button
              >{/if}
            {#if sync.phase === 'error'}<button
                disabled={busy || !drive || !googleClientId}
                onclick={() =>
                  run(async () => {
                    await drive?.connect();
                    await onchanged();
                  })}>Reconnect Google Drive</button
              >{/if}
          </div>
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
                    {conflict.id.startsWith('branch:') ? 'Earlier cloud revision' : 'This device'}:
                    {conflict.localLabel}</label
                  ><label class="check"
                    ><input
                      type="radio"
                      name={`conflict-${conflict.id}`}
                      checked={decisions[conflict.id] === 'remote'}
                      onchange={() => (decisions = { ...decisions, [conflict.id]: 'remote' })}
                    />
                    {conflict.id.startsWith('branch:') ? 'Other cloud revision' : 'Google Drive'}:
                    {conflict.remoteLabel}</label
                  >
                </fieldset>{/each}
              <button
                class="primary"
                disabled={busy || sync.conflicts.some((conflict) => !decisions[conflict.id])}
                onclick={() =>
                  run(async () => {
                    await drive?.resolve(decisions);
                    decisions = {};
                    await onchanged();
                  })}>Apply choices and sync</button
              >
            </div>
          {/if}
          <h3>Import from another tracker</h3>
          <p>
            Bring older history into your selected game profile. External imports merge with your
            saved pulls, preserving repeated records without counting the same history twice.
          </p>
          <p><a href="/guides/exilium" target="_blank" rel="noreferrer">Exilium migration guide (opens in a new tab)</a></p>
        </div>
      </div>
    </section>
  {/if}

  {#if section === 'privacy' || section === 'all'}
    <section aria-labelledby="privacy-heading">
      <header>
        <h2 id="privacy-heading">Privacy &amp; recovery</h2>
        <p>You choose where your history goes each time you collect it.</p>
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
            Saving a private server backup and contributing to statistics are separate choices.
            Recovering or deleting server data requires proof of ownership from a fresh game
            capture.
          </dd>
        </div>
        <div>
          <dt>Community statistics</dt>
          <dd>
            Only histories fetched directly by the server can contribute. Public results contain
            aggregates; small groups are withheld. Removing a contribution excludes it from future
            calculations.
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
                  >{account.identity.server} · {account.identity.endpoint_host} · {account.account_id.slice(
                    0,
                    8
                  )}</option
                >{/each}</select
            ></label
          >
          <div class="actions">
            <button
              disabled={busy || !verifiedAccount || !publicConfig.features.server_backup}
              onclick={() => run(recoverServer)}>Recover server backup</button
            ><button
              disabled={busy || !matchingProfile || !publicConfig.features.server_backup}
              onclick={() => run(saveServer)}>Save profile to server</button
            ><button
              disabled={busy || !verifiedAccount || !publicConfig.features.server_backup}
              onclick={() => (serverAction = 'backup')}>Delete server backup…</button
            ><button
              disabled={busy || !verifiedAccount || !publicConfig.features.community_contribution}
              onclick={() => (serverAction = 'contribution')}
              >Remove statistics contribution…</button
            >
          </div>
          {#if serverAction}<div class="confirmation">
              <p>
                {serverAction === 'backup'
                  ? 'Delete this account’s private server backup? Browser and Drive copies remain available.'
                  : 'Remove this account’s contribution from future community statistics? Its private backups remain available.'}
              </p>
              <div class="actions">
                <button
                  class="primary"
                  disabled={busy}
                  onclick={() =>
                    run(async () => {
                      if (!publicApi || !verifiedAccount) return;
                      if (serverAction === 'backup')
                        await publicApi.deleteBackup(verifiedAccount.account_id);
                      else await publicApi.deleteContribution(verifiedAccount.account_id);
                      notice =
                        serverAction === 'backup'
                          ? 'Private server backup deleted.'
                          : 'Statistics contribution removed.';
                      serverAction = '';
                    })}>Confirm removal</button
                ><button disabled={busy} onclick={() => (serverAction = '')}>Cancel</button>
              </div>
            </div>{/if}
        </div>
      {/if}
    </section>
  {/if}
  {#if error}<p class="feedback error" role="alert">{error}</p>{/if}
  {#if notice}<p class="feedback" role="status">{notice}</p>{/if}
</div>

<style>
  .settings {
    border-top: 2px solid var(--ink);
    padding-top: 24px;
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
