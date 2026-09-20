<script lang="ts">
  import { onMount } from 'svelte';
  import { client as serverClient } from '$lib/api';
  import { createLocalClient } from '$lib/local/client';
  import { createDriveSync } from '$lib/sync/controller';
  import { collectCapture, CaptureError } from '$lib/capture';
  import { createPublicClient } from '$lib/public-api';
  import ArchiveSettings from '$lib/components/ArchiveSettings.svelte';
  import CommunityStatistics from '$lib/components/CommunityStatistics.svelte';
  import ImportGuide from '$lib/components/ImportGuide.svelte';
  import { readExport, inspectExiliumProfiles } from '$lib/import-files';
  import type { Filters, Profile, History, Statistics, FilterOptions, Job } from '$lib/api';
  let { data } = $props();
  const hosted = $derived(data.mode === 'public');
  let local = $state<ReturnType<typeof createLocalClient>>();
  let client = serverClient as Pick<
    typeof serverClient,
    'profiles' | 'createProfile' | 'history' | 'statistics' | 'filterOptions' | 'importRecords'
  >;
  const publicApi = createPublicClient();
  let drive = $state<ReturnType<typeof createDriveSync>>();
  let publicConfig = $state<Awaited<ReturnType<typeof publicApi.config>>>();
  let section = $state<'tracker' | 'profiles' | 'backup' | 'statistics' | 'privacy'>('tracker');
  let saveBackup = $state(true),
    contribute = $state(true),
    recovery = $state(false);
  let relayFallback = $state(false);
  let abortCapture: AbortController | undefined;
  let unsubscribeArchive: (() => void) | undefined;
  async function archiveChanged() {
    profiles = await client.profiles();
    if (!profiles.some((p) => p.id === filters.profile_id))
      filters.profile_id = profiles[0]?.id || '';
    await refresh();
  }
  let profiles = $state<Profile[]>([]),
    history = $state<History>({ items: [], total: 0, page: 1, page_size: 20, pages: 1 });
  let stats = $state<Statistics | null>(null),
    options = $state<FilterOptions>({ rarities: [], kinds: [], types: [], pools: [] });
  let filters = $state<Filters>({
    profile_id: '',
    q: '',
    rarity: '',
    kind: '',
    type_id: '',
    pool_id: '',
    date_from: '',
    date_to: '',
    page: 1,
    page_size: 20
  });
  let importOpen = $state(false),
    importMode = $state<'file' | 'capture'>('file'),
    capture = $state(''),
    server = $state(''),
    profileName = $state(''),
    createOpen = $state(false);
  let selectedFiles = $state<File[]>([]),
    importState = $state<'idle' | 'running' | 'complete' | 'partial' | 'error'>('idle'),
    message = $state(''),
    expanded = $state<number | null>(null),
    loading = $state(true),
    error = $state('');
  let sourceProfiles = $state<{ id: string; name: string }[]>([]),
    sourceProfile = $state('');
  let fileSelection = 0;
  async function chooseFiles(files: File[]) {
    const selection = ++fileSelection;
    selectedFiles = files;
    sourceProfiles = [];
    sourceProfile = '';
    importState = 'idle';
    try {
      const choices = local
        ? await local.inspectExiliumProfiles(files)
        : await inspectExiliumProfiles(files);
      if (selection !== fileSelection) return;
      sourceProfiles = choices;
      if (choices.length === 1) sourceProfile = choices[0].id;
    } catch (cause) {
      if (selection !== fileSelection) return;
      importState = 'error';
      message = failure(cause);
    }
  }
  let job = $state<Job | null>(null),
    profileError = $state(''),
    creating = $state(false);
  let request = 0;
  let optionsProfile = '';
  let tableScroll = $state<HTMLElement>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const PROFILE_KEY = 'gfl2.profile';
  const jobKey = (profile: string) => `gfl2.job.${profile}`;
  function remembered(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function remember(key: string, value: string | null) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* Storage is optional; collection still works within this page. */
    }
  }
  const number = (v: number) => v.toLocaleString('en-US');
  const date = (v: string | null | undefined) =>
    v
      ? new Date(v).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC'
        })
      : '—';
  const time = (v: string) =>
    new Date(v).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  function failure(e: unknown) {
    return e instanceof Error
      ? e.message
      : 'The request could not finish. Check the local services.';
  }
  function invalidateResults() {
    // A result belongs to one selection. Never relabel an old profile/filter result
    // while a new request is pending or after it fails (including debounced search).
    const id = ++request;
    loading = true;
    error = '';
    stats = null;
    history = { items: [], total: 0, page: filters.page, page_size: filters.page_size, pages: 1 };
    expanded = null;
    if (optionsProfile !== filters.profile_id) {
      options = { rarities: [], kinds: [], types: [], pools: [] };
    }
    return id;
  }
  async function refresh(reset = false) {
    if (reset) filters.page = 1;
    const id = invalidateResults();
    if (!filters.profile_id) {
      history = { items: [], total: 0, page: 1, page_size: filters.page_size, pages: 1 };
      stats = null;
      loading = false;
      return;
    }
    remember(PROFILE_KEY, filters.profile_id);
    try {
      const [h, s, o] = await Promise.all([
        client.history({ ...filters }),
        client.statistics({ ...filters }),
        client.filterOptions(filters.profile_id)
      ]);
      if (id === request && !disposed) {
        history = h;
        stats = s;
        options = o;
        optionsProfile = filters.profile_id;
      }
    } catch (e) {
      if (id === request) error = failure(e);
    } finally {
      if (id === request) loading = false;
    }
  }
  async function initialize() {
    try {
      if (hosted) {
        local = createLocalClient();
        client = local;
        drive = createDriveSync({ clientId: data.googleClientId, store: local });
        unsubscribeArchive = local.subscribe(() => {
          if (!disposed)
            void archiveChanged().catch((cause) => {
              error = failure(cause);
            });
        });
        saveBackup = remembered('gfl2.server-backup') !== 'false';
        contribute = remembered('gfl2.contribute') !== 'false';
        try {
          publicConfig = await publicApi.config();
        } catch {
          /* Local archives remain available when server features are offline. */
        }
      }
      profiles = await client.profiles();
      const saved = remembered(PROFILE_KEY);
      filters.profile_id = profiles.find((p) => p.id === saved)?.id ?? profiles[0]?.id ?? '';
      if (!profiles.length) {
        importOpen = true;
        createOpen = true;
      }
      await refresh();
      const jobId = remembered(jobKey(filters.profile_id));
      if (jobId) {
        importOpen = true;
        await pollJob(jobId);
      }
    } catch (e) {
      error = failure(e);
      loading = false;
    }
  }
  onMount(() => {
    void initialize();
    return () => {
      disposed = true;
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
      capture = '';
      abortCapture?.abort();
      drive?.destroy();
      unsubscribeArchive?.();
      local?.close();
    };
  });
  function searchChanged() {
    clearTimeout(searchTimer);
    invalidateResults();
    searchTimer = setTimeout(() => void refresh(true), 180);
  }
  async function profileChanged() {
    clearTimeout(pollTimer);
    clearSelection();
    capture = '';
    job = null;
    message = '';
    importState = 'idle';
    await refresh(true);
    const id = remembered(jobKey(filters.profile_id));
    if (id) {
      importOpen = true;
      await pollJob(id);
    }
  }
  function clearSelection() {
    clearTimeout(searchTimer);
    filters = {
      ...filters,
      q: '',
      rarity: '',
      kind: '',
      type_id: '',
      pool_id: '',
      date_from: '',
      date_to: '',
      page: 1
    };
  }
  function reset() {
    clearSelection();
    void refresh();
  }
  const active = $derived(
    [
      filters.q,
      filters.rarity,
      filters.kind,
      filters.type_id,
      filters.pool_id,
      filters.date_from,
      filters.date_to
    ].filter(Boolean).length
  );
  async function addProfile() {
    if (!profileName.trim() || creating || importState === 'running') return;
    creating = true;
    profileError = '';
    try {
      const p = await client.createProfile(profileName.trim());
      profiles = await client.profiles();
      filters.profile_id = p.id;
      clearSelection();
      createOpen = false;
      profileName = '';
      await refresh(true);
    } catch (e) {
      profileError = failure(e);
    } finally {
      creating = false;
    }
  }
  async function pollJob(id: string) {
    if (disposed) return;
    const profileId = filters.profile_id;
    try {
      const next = hosted
        ? ({ ...(await publicApi.job(id)), profile_id: profileId } as Job)
        : await serverClient.job(id);
      if (disposed || next.profile_id !== filters.profile_id) return;
      job = next;
      message = next.message;
      if (next.status === 'queued' || next.status === 'running') {
        importState = 'running';
        remember(jobKey(next.profile_id), id);
        pollTimer = setTimeout(() => void pollJob(id), 1000);
      } else {
        if (hosted && (next.status === 'completed' || next.status === 'partial')) {
          const result = await publicApi.result(id);
          await client.importRecords({ ...result, profile_id: profileId });
        }
        remember(jobKey(next.profile_id), null);
        importState =
          next.status === 'completed'
            ? 'complete'
            : next.status === 'partial'
              ? 'partial'
              : 'error';
        if (next.status === 'interrupted')
          message =
            'The previous fetch was interrupted. Saved records remain available. Submit a fresh capture to try again.';
        await refresh();
      }
    } catch (e) {
      if (disposed || profileId !== filters.profile_id) return;
      importState = 'error';
      message =
        failure(e) + ' The saved job can be checked again without submitting a new capture.';
    }
  }
  async function runImport(forceRelay = false) {
    let submittedCapture = capture;
    capture = '';
    if (importState === 'running') return;
    message = '';
    job = null;
    const profileId = filters.profile_id;
    try {
      if (!filters.profile_id) throw new Error('Create or choose a profile before importing.');
      importState = 'running';
      if (importMode === 'file') {
        message = 'Validating export files…';
        const payload = local
          ? await local.readExport(selectedFiles, profileId, sourceProfile || undefined)
          : await readExport(selectedFiles, profileId, sourceProfile || undefined);
        message = 'Merging records into the archive…';
        const result = await client.importRecords(payload);
        importState = result.complete === false ? 'partial' : 'complete';
        message =
          `${number(result.record_count)} records read · ${number(result.added_count)} added · ${number(result.total)} in this profile. ` +
          (result.duplicate ? 'This snapshot was already imported. ' : '') +
          (result.complete === null
            ? 'Collection completeness is unknown because no manifest was provided.'
            : result.complete
              ? 'All accessible pages in this collection were read.'
              : 'Partial collection preserved; some accessible pages may be missing.');
        await refresh(true);
      } else {
        if (!submittedCapture.trim())
          throw new Error('Paste a captured HTTP request to fetch records.');
        if (server.trim() && !/^\d+$/.test(server.trim()))
          throw new Error(
            'Server ID must be a number, such as 10. Paste a fresh capture before retrying.'
          );
        message = 'Starting collection…';
        if (hosted && recovery) {
          const account = await publicApi.verify(submittedCapture, server.trim() || undefined);
          publicConfig = await publicApi.config();
          submittedCapture = '';
          const backup = await publicApi.backup(account.account_id);
          for (const snapshot of backup.snapshots)
            await local!.importRecords({ ...snapshot, profile_id: profileId });
          importState = 'complete';
          message = 'Server backup recovered and merged into this browser.';
          await archiveChanged();
          return;
        }
        if (hosted && !saveBackup && !contribute && !forceRelay) {
          abortCapture = new AbortController();
          try {
            const result = await collectCapture(submittedCapture, profileId, {
              server: server.trim() || undefined,
              signal: abortCapture.signal,
              onProgress: (progress) => {
                message = `Collecting type ${progress.typeId}: ${progress.records} records from ${progress.pages} pages…`;
              }
            });
            await client.importRecords(result);
            importState = result.manifest?.complete === false ? 'partial' : 'complete';
            message = 'History saved in this browser. Connected Drive sync runs separately.';
          } catch (e) {
            if (e instanceof CaptureError) {
              relayFallback = e.canUseServerFallback;
              if (e.partial) {
                await client.importRecords(e.partial);
                importState = 'partial';
                message = `${failure(e)} Partial history was preserved.`;
                await refresh(true);
                return;
              }
            }
            throw e;
          }
          await refresh(true);
          return;
        }
        job = hosted
          ? ({
              ...(await publicApi.fetchCapture({
                capture: submittedCapture,
                server: server.trim() || undefined,
                save_backup: saveBackup,
                contribute
              })),
              profile_id: profileId
            } as Job)
          : await serverClient.fetchHistory(
              profileId,
              submittedCapture,
              server.trim() || undefined
            );
        submittedCapture = '';
        remember(jobKey(profileId), job.id);
        await pollJob(job.id);
      }
    } catch (e) {
      importState = 'error';
      message = failure(e);
    } finally {
      submittedCapture = '';
    }
  }
</script>

<svelte:head
  ><title>GFL2 Pull Tracker — Recruitment ledger</title><meta
    name="description"
    content="Your source-preserving Girls’ Frontline 2 recruitment history."
  /></svelte:head
>

<header class="masthead">
  <a class="wordmark" href="/" aria-label="GFL2 Pull Tracker home"
    ><svg viewBox="0 0 32 32" aria-hidden="true"
      ><path d="M4 4h24v24H4zM10 4v24M4 11h24M16 17h7M16 22h7" /></svg
    ><span>GFL2<span class="wordmark-sub">PULL TRACKER</span></span></a
  >
  <div class="header-controls">
    <label class="profile-select"
      ><span>Profile</span><select
        bind:value={filters.profile_id}
        onchange={profileChanged}
        disabled={importState === 'running'}
        aria-label="Active profile"
        >{#each profiles as p}<option value={p.id}>{p.name}</option>{/each}</select
      ></label
    ><button
      class="primary"
      onclick={() => {
        if (section !== 'tracker') {
          section = 'tracker';
          importOpen = true;
        } else importOpen = !importOpen;
      }}
      aria-expanded={importOpen}
      aria-controls="import-panel"
      ><svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d="M10 3v10m-4-4 4 4 4-4M4 13v4h12v-4" /></svg
      >Import history</button
    >
  </div>
</header>

{#if hosted}
  <nav class="archive-nav" aria-label="Tracker navigation">
    {#each [['tracker', 'My history'], ['profiles', 'Profiles'], ['backup', 'Backup & sync'], ['statistics', 'Community statistics'], ['privacy', 'Privacy']] as [id, label]}
      <button
        class:chosen={section === id}
        aria-current={section === id ? 'page' : undefined}
        onclick={() => {
          section = id as typeof section;
        }}>{label}</button
      >
    {/each}
  </nav>
{/if}

<main>
  {#if hosted && section === 'statistics'}
    <CommunityStatistics />
  {:else if hosted && section !== 'tracker' && local}
    <ArchiveSettings
      {local}
      {profiles}
      activeProfileId={filters.profile_id}
      googleClientId={data.googleClientId}
      {drive}
      {publicApi}
      {publicConfig}
      section={section as 'profiles' | 'backup' | 'privacy'}
      onchanged={archiveChanged}
      onselect={(id) => {
        filters.profile_id = id;
        void profileChanged();
      }}
      onrecover={() => {
        recovery = true;
        importMode = 'capture';
        importOpen = true;
        section = 'tracker';
      }}
    />
  {:else}
    {#if importOpen}
      <section id="import-panel" class="import-panel" aria-labelledby="import-title">
        <div class="section-heading">
          <div>
            <h2 id="import-title">Add to your archive</h2>
            <p>Imports merge into the selected profile. Repeated pulls remain separate records.</p>
          </div>
          <button class="text-button" onclick={() => (importOpen = false)}>Close</button>
        </div>
        <div class="import-grid">
          <div class="profile-assignment">
            <label
              >Import into<select
                bind:value={filters.profile_id}
                onchange={profileChanged}
                disabled={importState === 'running'}
                >{#each profiles as p}<option value={p.id}>{p.name}</option>{/each}</select
              ></label
            ><button
              class="text-button"
              disabled={importState === 'running'}
              onclick={() => (createOpen = !createOpen)}
              aria-expanded={createOpen}>Create a profile</button
            >{#if createOpen}<label
                >Profile name<input
                  bind:value={profileName}
                  placeholder="e.g. Commander · Global"
                /></label
              ><button
                onclick={addProfile}
                disabled={!profileName.trim() || creating || importState === 'running'}
                >{creating ? 'Creating…' : 'Create profile'}</button
              >{/if}{#if profileError}<p class="small" role="alert">{profileError}</p>{/if}
            <p class="small">
              Older exports need explicit profile assignment. Use a separate profile for each game
              account.
            </p>
          </div>
          <div class="import-source">
            <div class="segmented" aria-label="Import method">
              <button
                class:chosen={importMode === 'file'}
                disabled={importState === 'running'}
                onclick={() => {
                  importMode = 'file';
                  importState = 'idle';
                }}>Saved export</button
              ><button
                class:chosen={importMode === 'capture'}
                disabled={importState === 'running'}
                onclick={() => {
                  importMode = 'capture';
                  importState = 'idle';
                }}>Captured request</button
              >
            </div>
            {#if importMode === 'file'}<p>
                Select the export folder, including records.json, the manifest, and raw pages.
              </p>
              <div class="file-choices">
                <label class="file-button"
                  >Choose export folder<input
                    type="file"
                    disabled={importState === 'running'}
                    multiple
                    webkitdirectory
                    onchange={(e) => {
                      void chooseFiles(Array.from(e.currentTarget.files ?? []));
                    }}
                  /></label
                ><label class="file-button secondary"
                  >Choose files<input
                    type="file"
                    disabled={importState === 'running'}
                    multiple
                    accept=".json"
                    onchange={(e) => {
                      void chooseFiles(Array.from(e.currentTarget.files ?? []));
                    }}
                  /></label
                >
              </div>
              <p class="small">
                {selectedFiles.length
                  ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected`
                  : 'Choose collector exports or an Exilium JSON backup. Compressed tracker backups are restored in Backup & sync.'}
              </p>
              {#if sourceProfiles.length > 1}
                <label
                  >Profile from Exilium backup<select bind:value={sourceProfile}
                    ><option value="">Choose a source profile</option
                    >{#each sourceProfiles as source}<option value={source.id}>{source.name}</option
                      >{/each}</select
                  ></label
                >
                <p class="small">
                  Only this source profile will be merged into the selected destination. Unknown
                  server identity remains unverified.
                </p>
              {/if}
            {:else}<label
                >Captured HTTP request<textarea
                  disabled={importState === 'running'}
                  bind:value={capture}
                  rows="4"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Paste the full captured HTTPS request"></textarea></label
              ><label>Server ID (optional)<input bind:value={server} placeholder="e.g. 10" /></label
              >
              <p class="small">
                Credentials stay in memory and are cleared on submission. A fresh capture is
                required to retry.
              </p>
              {#if hosted}
                <div class="capture-options">
                  <label class="check-control"
                    ><input type="checkbox" bind:checked={recovery} /> Recover a private server backup</label
                  >
                  {#if !recovery}
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={saveBackup}
                        onchange={() => remember('gfl2.server-backup', String(saveBackup))}
                      /> Save server backup</label
                    >
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={contribute}
                        onchange={() => remember('gfl2.contribute', String(contribute))}
                      /> Contribute to community statistics</label
                    >
                  {/if}
                  {#if recovery || saveBackup || contribute}
                    <p class="small">
                      This request sends your capture to the tracker server. Credentials are used in
                      memory and never saved. Only aggregate statistics are public.
                    </p>
                    {#if !publicConfig?.identity_verification.available}
                      <p class="small" role="status">
                        Account verification is not enabled on this installation. Server backup,
                        recovery, and contributions are unavailable. You can still import into your
                        browser and sync with Drive.
                      </p>
                      <button
                        type="button"
                        onclick={() => {
                          recovery = false;
                          saveBackup = false;
                          contribute = false;
                          remember('gfl2.server-backup', 'false');
                          remember('gfl2.contribute', 'false');
                        }}>Use browser and Drive only</button
                      >
                    {/if}
                  {:else}<p class="small">
                      The browser contacts official game servers directly. No capture or history is
                      sent to this tracker server.
                    </p>{/if}
                </div>
                <ImportGuide />
              {/if}
            {/if}
            <button
              class="primary"
              onclick={() => runImport()}
              disabled={importState === 'running' ||
                creating ||
                (hosted &&
                  importMode === 'capture' &&
                  (recovery || saveBackup || contribute) &&
                  !publicConfig?.identity_verification.available)}
              >{importState === 'running'
                ? 'Working…'
                : importMode === 'file'
                  ? 'Validate and import'
                  : 'Fetch accessible history'}</button
            >
            {#if importState !== 'idle'}<div
                class="import-result"
                class:problem={importState === 'error' || importState === 'partial'}
                role={importState === 'error' ? 'alert' : 'status'}
              >
                {#if importState === 'running'}<progress aria-label="Import in progress"
                  ></progress>{/if}<strong
                  >{importState === 'error'
                    ? 'Import needs attention'
                    : importState === 'partial'
                      ? 'Partial collection'
                      : importState === 'complete'
                        ? 'Import complete'
                        : 'Import in progress'}</strong
                >
                <p>{message}</p>
                {#if hosted && relayFallback && importState !== 'running'}
                  <p class="small">
                    Browser access failed. Paste a fresh capture above to explicitly fetch through
                    the tracker server. The server uses the credential in memory and keeps no
                    private backup or contribution.
                  </p>
                  <button
                    onclick={() => runImport(true)}
                    disabled={!capture.trim() || saveBackup || contribute}
                    >Fetch through server once</button
                  >
                {/if}
                {#if job}<p>
                    {number(job.records)} records · {number(job.pages)} pages{job.type_id !== null
                      ? ` · Type ${job.type_id}`
                      : ''}
                  </p>{/if}{#if importState === 'error' && remembered(jobKey(filters.profile_id))}<button
                    onclick={() => {
                      const id = remembered(jobKey(filters.profile_id));
                      if (id) void pollJob(id);
                    }}>Check saved job</button
                  >{/if}
              </div>{/if}
          </div>
        </div>
      </section>
    {/if}

    <section class="overview" aria-labelledby="overview-title">
      <div class="title-row">
        <h1 id="overview-title">Recruitment ledger<span class="title-rule"></span></h1>
        <span class="local-label"><span></span>Local archive</span>
      </div>
      <div class="summary-strip">
        <div class="summary-total">
          <span>{active ? 'Matching pulls' : 'Recorded pulls'}</span><strong
            >{stats ? number(stats.total) : loading || error ? '—' : '0'}</strong
          >
        </div>
        <div>
          <span>Recorded range <small>UTC</small></span><strong class="date-range"
            >{date(stats?.date_from)}<span> — </span>{date(stats?.date_to)}</strong
          >
        </div>
        <div>
          <span>Last import <small>UTC</small></span><strong
            >{date(stats?.last_import_at)}<small
              >{stats?.last_import_at ? time(stats.last_import_at) : ''}</small
            ></strong
          >
        </div>
      </div>
      <div class="distribution-grid">
        <div class="rarity-chart">
          <div class="chart-title">
            <h2>Rarity breakdown</h2>
            <span>Dolls & weapons</span>
          </div>
          <div class="rarity-bars">
            {#each ['Elite', 'Standard', 'Retired'] as rarity}{@const count =
                stats?.rarities.find((x) => x.label === rarity)?.count ?? 0}
              <div class="rarity-row">
                <span class="rarity-name">{rarity}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    class:ssr={rarity === 'Elite'}
                    class:sr={rarity === 'Standard'}
                    style:transform={`scaleX(${stats?.known_total ? count / stats.known_total : 0})`}
                  ></div>
                </div>
                <strong>{stats ? number(count) : '—'}</strong><span
                  >{stats
                    ? `${stats.known_total ? ((count / stats.known_total) * 100).toFixed(1) : '0.0'}%`
                    : '—'}</span
                >
              </div>{/each}
          </div>
          <p class="chart-note" role="status">
            {#if stats}
              {number(stats.unknown_total)} unresolved records retained · {number(
                stats.estimated_multi_groups
              )} estimated timestamp groups.
            {:else if loading}
              Loading overview for the selected profile and filters…
            {:else if error}
              Overview unavailable for the selected profile and filters.
            {:else}
              Import history to see rarity and timestamp group counts.
            {/if}
          </p>
        </div>
        <div class="type-chart">
          <div class="chart-title">
            <h2>Source distribution</h2>
            <span>API types</span>
          </div>
          <div class="type-bars">
            {#each stats?.types ?? [] as type}<div class="type-column">
                <strong>{number(type.count)}</strong>
                <div class="column-track">
                  <div
                    style:transform={`scaleY(${stats?.total ? type.count / Math.max(...stats.types.map((x) => x.count)) : 0})`}
                  ></div>
                </div>
                <span>Type {type.id}</span>
              </div>{/each}
          </div>
          <p class="chart-note">
            {#if stats}
              Pools: {#each stats.pools as pool, i}{i ? ' · ' : ''}{pool.id} ({number(
                  pool.count
                )}){/each}
            {:else}
              Pool distribution {loading ? 'loading…' : error ? 'unavailable.' : 'awaiting import.'}
            {/if}
          </p>
        </div>
      </div>
      <div class="coverage">
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6v1" /></svg
        >
        <p>Accessible history only. A completed import does not mean lifetime coverage.</p>
        <span
          >{stats?.latest_import_complete === true
            ? 'Latest collection complete'
            : stats?.latest_import_complete === false
              ? 'Latest collection partial'
              : 'Collection completeness unknown'}</span
        >
      </div>
    </section>

    <section class="history" aria-labelledby="history-title">
      <div class="section-heading history-heading">
        <div class="history-title">
          <h2 id="history-title">Pull history</h2>
          <span
            >{loading
              ? 'Loading records…'
              : error
                ? 'Records unavailable'
                : `${number(history.total)} records${active ? ' · filtered' : ''}`}</span
          >
        </div>
        <button class="text-button" onclick={reset} disabled={!active}
          >Reset filters{active ? ` (${active})` : ''}</button
        >
      </div>
      <form
        class="filters"
        onsubmit={(e) => {
          e.preventDefault();
          void refresh(true);
        }}
      >
        <label class="search-field"
          >Search name or item ID
          <div>
            <svg viewBox="0 0 20 20" aria-hidden="true"
              ><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg
            ><input
              type="search"
              bind:value={filters.q}
              oninput={searchChanged}
              placeholder="Find a doll, weapon, or ID"
            />
          </div></label
        >
        <label
          >Rarity<select bind:value={filters.rarity} onchange={() => refresh(true)}
            ><option value="">All rarities</option>{#each options.rarities as rarity}<option
                value={rarity}>{rarity === 'unknown' ? 'Unknown' : rarity}</option
              >{/each}</select
          ></label
        >
        <label
          >Item kind<select bind:value={filters.kind} onchange={() => refresh(true)}
            ><option value="">All kinds</option>{#each options.kinds as kind}<option value={kind}
                >{kind === 'unknown' ? 'Unknown' : kind === 'doll' ? 'Doll' : 'Weapon'}</option
              >{/each}</select
          ></label
        >
        <label
          >API type<select bind:value={filters.type_id} onchange={() => refresh(true)}
            ><option value="">All types</option>{#each options.types as type}<option
                value={String(type)}>Type {type}</option
              >{/each}</select
          ></label
        >
        <label
          >Pool ID<select bind:value={filters.pool_id} onchange={() => refresh(true)}
            ><option value="">All pools</option>{#each options.pools as pool}<option
                value={String(pool)}>{pool}</option
              >{/each}</select
          ></label
        >
        <label
          >From (UTC)<input
            type="date"
            bind:value={filters.date_from}
            onchange={() => refresh(true)}
          /></label
        ><label
          >To (UTC)<input
            type="date"
            bind:value={filters.date_to}
            onchange={() => refresh(true)}
          /></label
        >
      </form>
      {#if error}<div class="empty-state" role="alert">
          <h3>History could not load</h3>
          <p>{error}</p>
          <button onclick={() => (profiles.length ? refresh() : initialize())}>Try again</button>
        </div>{:else if loading && !stats}<div class="empty-state" role="status">
          Loading your archive…
        </div>{:else if !history.items.length}<div class="empty-state">
          <h3>{active ? 'No pulls match these filters' : 'Your ledger is ready'}</h3>
          <p>
            {active
              ? 'Try a broader date range or remove a filter.'
              : 'Import a saved export or fetch accessible history to begin.'}
          </p>
          <button onclick={() => (active ? reset() : (importOpen = true))}
            >{active ? 'Reset filters' : 'Import history'}</button
          >
        </div>{:else}
        <div class="table-navigation">
          <span>Scroll table</span><button
            aria-label="Scroll table left"
            aria-controls="pull-history-table"
            onclick={() => tableScroll?.scrollBy({ left: -250 })}>Left</button
          ><button
            aria-label="Scroll table right"
            aria-controls="pull-history-table"
            onclick={() => tableScroll?.scrollBy({ left: 250 })}>Right</button
          >
        </div>
        <section
          class="table-scroll"
          bind:this={tableScroll}
          id="pull-history-table"
          aria-label="Pull history table"
          aria-busy={loading}
        >
          <table>
            <thead
              ><tr
                ><th>Item</th><th>Rarity / kind</th><th>Source</th><th
                  >Recorded <small>UTC</small></th
                ><th class="quantity">Qty.</th><th><span class="sr-only">Record details</span></th
                ></tr
              ></thead
            ><tbody
              >{#each history.items as row (row.id)}<tr class:unknown={row.kind === 'unknown'}
                  ><td
                    ><span class="item-name">{row.name ?? 'Unknown item'}</span><span
                      class="item-id">{row.item_id}</span
                    ></td
                  ><td
                    ><span class="rarity-tag" class:elite={row.rarity === 'Elite'}
                      >{row.rarity ?? 'Unknown'}</span
                    ><span class="kind-label"
                      >{row.kind === 'unknown'
                        ? 'Unresolved'
                        : row.kind === 'doll'
                          ? 'Doll'
                          : 'Weapon'}</span
                    ></td
                  ><td
                    ><span>Type {row.type_id}</span><span class="cell-secondary"
                      >Pool {row.pool_id}</span
                    ></td
                  ><td
                    ><span>{date(row.timestamp)}</span><span class="cell-secondary"
                      >{time(row.timestamp)}</span
                    ></td
                  ><td class="quantity">{row.quantity}</td><td
                    ><button
                      class="details-button"
                      aria-label={`Details for ${row.name ?? row.item_id}`}
                      aria-expanded={expanded === row.id}
                      onclick={() => (expanded = expanded === row.id ? null : row.id)}
                      ><svg
                        viewBox="0 0 20 20"
                        aria-hidden="true"
                        class:rotated={expanded === row.id}><path d="m7 4 6 6-6 6" /></svg
                      ></button
                    ></td
                  ></tr
                >{#if expanded === row.id}<tr class="detail-row"
                    ><td colspan="6"
                      ><div>
                        <span><strong>Original item ID</strong>{row.item_id}</span><span
                          ><strong>Source page</strong>{row.source_page}</span
                        ><span><strong>Catalog region</strong>{row.region ?? 'Unknown'}</span><span
                          ><strong>Estimated timestamp group</strong>{row.estimated_group_size} records
                          · not a confirmed multi-pull</span
                        >
                      </div></td
                    ></tr
                  >{/if}{/each}</tbody
            >
          </table>
        </section>
        <div class="pagination">
          <p>
            Showing {number((history.page - 1) * history.page_size + 1)}–{number(
              Math.min(history.page * history.page_size, history.total)
            )} of {number(history.total)}<span> · Newest first</span>
          </p>
          <div>
            <label class="page-size"
              ><span>Rows</span><select
                bind:value={filters.page_size}
                onchange={() => refresh(true)}
                ><option value={20}>20</option><option value={50}>50</option><option value={100}
                  >100</option
                ></select
              ></label
            ><button
              aria-label="Previous page"
              disabled={filters.page <= 1}
              onclick={() => {
                filters.page--;
                void refresh();
              }}>Previous</button
            ><span class="page-count">{history.page} / {history.pages}</span><button
              aria-label="Next page"
              disabled={filters.page >= history.pages}
              onclick={() => {
                filters.page++;
                void refresh();
              }}>Next</button
            >
          </div>
        </div>
      {/if}
    </section>
  {/if}
  <footer>
    <span>GFL2 Pull Tracker</span>
    <p>One record = one pull. Item quantity is preserved separately.</p>
    <a href="/privacy">Privacy</a>
    <a
      href="https://github.com/Infernal-Crack-LED/gfl2-team-builder"
      target="_blank"
      rel="noreferrer">Catalog attribution</a
    >
  </footer>
</main>
