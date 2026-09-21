<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { trackerPages, type TrackerSection } from '$lib/tracker-routes';
  import MultiSelect from '$lib/components/MultiSelect.svelte';
  import EliteHistory from '$lib/components/EliteHistory.svelte';
  import GitHubLink from '$lib/components/GitHubLink.svelte';
  import { capturePaginationAnchor } from '$lib/pagination-anchor';
  import { recruitmentName } from '$lib/recruitment';
  import { createProfileHistoryLoader, profileFilters } from '$lib/profile-history';
  import { client as serverClient, ApiError } from '$lib/api';
  import { createLocalClient } from '$lib/local/client';
  import { createDriveSync } from '$lib/sync/controller';
  import { collectCapture, CaptureError, validateCapture } from '$lib/capture';
  import { createPublicClient, PublicApiError } from '$lib/public-api';
  import ArchiveSettings from '$lib/components/ArchiveSettings.svelte';
  import CommunityStatistics from '$lib/components/CommunityStatistics.svelte';
  import ImportGuide from '$lib/components/ImportGuide.svelte';
  import { readExport, inspectExiliumProfiles } from '$lib/import-files';
  import { classifyImportFiles } from '$lib/import-selection';
  import { serverCapabilities, savedServerChoices } from '$lib/import-policy';
  import type {
    Pull,
    ImportResult,
    Filters,
    Profile,
    History,
    Statistics,
    FilterOptions,
    Job
  } from '$lib/api';
  let { data } = $props();
  const hosted = $derived(data.mode === 'public');
  let initializing = $state(true);
  let local = $state<ReturnType<typeof createLocalClient>>();
  let client = serverClient as Pick<
    typeof serverClient,
    | 'profiles'
    | 'createProfile'
    | 'history'
    | 'overview'
    | 'statistics'
    | 'filterOptions'
    | 'importRecords'
  >;
  const publicApi = createPublicClient();
  let drive = $state<ReturnType<typeof createDriveSync>>();
  let publicConfig = $state<Awaited<ReturnType<typeof publicApi.config>>>();
  // Every panel shares this route component so navigation retains imports and Drive authorization.
  const section = $derived(page.params.section as TrackerSection);
  const currentPage = $derived(trackerPages.find((item) => item.slug === section)!);
  let saveBackup = $state(false),
    contribute = $state(false),
    recovery = $state(false);
  const capabilities = $derived(serverCapabilities(publicConfig));
  type Operation = Readonly<{ id: number; profileId: string }>;
  let operation = $state<Operation | null>(null);
  let operationSequence = 0;
  const importBusy = $derived(operation !== null);
  let settingsBusy = $state(false);
  let stopping = $state(false),
    saving = $state(false),
    inspecting = $state(false);
  let polling = false;
  let pendingRestoreFile = $state<File | null>(null);
  let restoreRequest = $state(0);
  let relayFallback = $state(false);
  const owns = (op: Operation) => !disposed && operation?.id === op.id;
  function beginOperation(profileId: string): Operation {
    const op = Object.freeze({ id: ++operationSequence, profileId });
    operation = op;
    stopping = false;
    saving = false;
    relayFallback = false;
    return op;
  }
  function finishOperation(op: Operation) {
    if (!owns(op)) return;
    operation = null;
    stopping = false;
    saving = false;
    abortCapture = undefined;
  }
  async function openRestore(file: File | null = null) {
    if (importBusy) return;
    if (!hosted) {
      importState = 'error';
      message =
        'Compressed tracker backups restore browser archives in the hosted tracker. Use collector JSON exports in local-server mode.';
      return;
    }
    pendingRestoreFile = file;
    restoreRequest++;
    await goto('/backup');
    await tick();
    document.getElementById('restore-heading')?.focus();
  }
  async function viewHistory() {
    await goto('/history');
    importOpen = false;
    await tick();
    document.getElementById('history-title')?.focus();
    document.getElementById('history-title')?.scrollIntoView({ block: 'start' });
  }
  function summary(result: ImportResult): string {
    return (
      `${number(result.record_count)} records read · ${number(result.added_count)} added · ${number(result.total)} in this profile. ` +
      (result.duplicate ? 'This snapshot was already imported. ' : '') +
      (result.complete === null
        ? 'Collection completeness is unknown because no manifest was provided.'
        : result.complete
          ? 'All accessible pages in this collection were read; lifetime coverage is not implied.'
          : 'Partial history preserved; accessible pages may be missing.')
    );
  }
  let abortCapture = $state<AbortController>();
  let unsubscribeArchive: (() => void) | undefined;
  async function archiveChanged() {
    loadProfileHistory.invalidate();
    overviewKey = '';
    profiles = await client.profiles();
    if (!importBusy && !profiles.some((p) => p.id === filters.profile_id))
      filters.profile_id = profiles[0]?.id || '';
    await refresh();
  }
  let profiles = $state<Profile[]>([]),
    history = $state<History>({ items: [], total: 0, page: 1, page_size: 20, pages: 1 });
  let overviewRows = $state<Pull[]>([]);
  let overviewLoading = $state(true);
  let overviewError = $state('');
  let overviewKey = '';
  const loadProfileHistory = createProfileHistoryLoader((profileId) => client.overview(profileId));
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
    importState = $state<'idle' | 'running' | 'complete' | 'partial' | 'cancelled' | 'error'>(
      'idle'
    ),
    message = $state(''),
    expanded = $state<number | null>(null),
    loading = $state(true),
    error = $state('');
  let sourceProfiles = $state<{ id: string; name: string }[]>([]),
    sourceProfile = $state('');
  let fileSelection = 0;
  async function chooseFiles(files: File[]) {
    if (importBusy) return;
    const selection = ++fileSelection;
    inspecting = true;
    selectedFiles = files;
    sourceProfiles = [];
    sourceProfile = '';
    importState = 'idle';
    message = '';
    try {
      const format = await classifyImportFiles(files, hosted);
      if (selection !== fileSelection) return;
      if (format === 'backup') {
        selectedFiles = [];
        await openRestore(files[0]);
        return;
      }
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
      selectedFiles = [];
    } finally {
      if (selection === fileSelection) inspecting = false;
    }
  }
  let job = $state<Job | null>(null),
    profileError = $state(''),
    creating = $state(false);
  let request = 0;
  let overviewRequest = 0;
  let optionsProfile = '';
  let tableScroll = $state<HTMLElement>();
  let nextPageButton = $state<HTMLButtonElement>();
  let pageError = $state('');
  let requestedPage = $state<number | null>(null);
  let pageNumber = $state<number | undefined>(1);
  $effect(() => {
    pageNumber = history.page;
  });
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
      ? new Date(v).toLocaleDateString(undefined, {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        })
      : '—';
  const time = (v: string) =>
    new Date(v).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
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
    pageError = '';
    requestedPage = null;
    history = { items: [], total: 0, page: filters.page, page_size: filters.page_size, pages: 1 };
    expanded = null;
    if (optionsProfile !== filters.profile_id) {
      overviewRequest++;
      stats = null;
      overviewRows = [];
      overviewKey = '';
      overviewError = '';
      overviewLoading = true;
      options = { rarities: [], kinds: [], types: [], pools: [] };
    }
    return id;
  }
  async function changePage(page: number) {
    if (
      loading ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > history.pages ||
      page === history.page
    )
      return;
    const id = ++request;
    loading = true;
    pageError = '';
    requestedPage = page;
    try {
      // Retain this page and its expanded details until its replacement arrives.
      // Filter/profile changes still invalidate immediately through refresh().
      const next = await client.history({ ...filters, page });
      if (id !== request || disposed) return;
      const restorePosition = capturePaginationAnchor(nextPageButton);
      history = next;
      filters.page = next.page;
      expanded = null;
      loading = false;
      requestedPage = null;
      await tick();
      if (id === request && !disposed) restorePosition();
    } catch (cause) {
      if (id === request && !disposed) {
        pageError = failure(cause);
        pageNumber = history.page;
      }
    } finally {
      if (id === request && !disposed) loading = false;
    }
  }
  async function refresh(reset = false) {
    if (reset) filters.page = 1;
    const id = invalidateResults();
    if (!filters.profile_id) {
      history = { items: [], total: 0, page: 1, page_size: filters.page_size, pages: 1 };
      stats = null;
      overviewRows = [];
      overviewLoading = false;
      loading = false;
      return;
    }
    remember(PROFILE_KEY, filters.profile_id);
    try {
      const [h, s, o] = await Promise.all([
        client.history({ ...filters }),
        client.statistics(profileFilters(filters.profile_id)),
        client.filterOptions(filters.profile_id)
      ]);
      if (id === request && !disposed) {
        history = h;
        loading = false;
        stats = s;
        options = o;
        optionsProfile = filters.profile_id;
        const profileId = filters.profile_id;
        const revision = `${s.total}:${s.last_import_at ?? ''}`;
        const key = `${profileId}:${revision}`;
        if (overviewKey !== key || overviewError) {
          // The overview belongs to the profile, so paging must not cancel its pending load.
          const overviewId = ++overviewRequest;
          overviewLoading = true;
          overviewError = '';
          try {
            const rows = await loadProfileHistory(profileId, revision);
            if (overviewId === overviewRequest && profileId === filters.profile_id && !disposed) {
              overviewRows = rows;
              overviewKey = key;
            }
          } catch (cause) {
            if (overviewId === overviewRequest && profileId === filters.profile_id && !disposed)
              overviewError = failure(cause);
          } finally {
            if (overviewId === overviewRequest && profileId === filters.profile_id && !disposed)
              overviewLoading = false;
          }
        }
      }
    } catch (e) {
      if (id === request) {
        error = failure(e);
        overviewLoading = false;
        if (!overviewRows.length) overviewError = failure(e);
      }
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
        try {
          publicConfig = await publicApi.config();
        } catch {
          /* Local archives remain available when server features are offline. */
        }
        ({ saveBackup, contribute } = savedServerChoices(
          publicConfig,
          remembered('gfl2.server-backup'),
          remembered('gfl2.contribute')
        ));
      }
      profiles = await client.profiles();
      const saved = remembered(PROFILE_KEY);
      filters.profile_id = profiles.find((p) => p.id === saved)?.id ?? profiles[0]?.id ?? '';
      if (!profiles.length) {
        importOpen = true;
        createOpen = true;
      }
      await refresh();
      initializing = false;
      const jobId = remembered(jobKey(filters.profile_id));
      if (jobId) {
        importOpen = true;
        await pollJob(jobId, beginOperation(filters.profile_id));
      }
    } catch (e) {
      error = failure(e);
      loading = false;
    } finally {
      initializing = false;
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
    if (operation) {
      filters.profile_id = operation.profileId;
      return;
    }
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
      await pollJob(id, beginOperation(filters.profile_id));
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
    if (!profileName.trim() || creating || importBusy || settingsBusy) return;
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
  async function pollJob(id: string, op: Operation) {
    if (!owns(op) || polling) return;
    clearTimeout(pollTimer);
    polling = true;
    try {
      const next = hosted
        ? ({ ...(await publicApi.job(id)), profile_id: op.profileId } as Job)
        : await serverClient.job(id);
      if (!owns(op)) return;
      if (next.profile_id !== op.profileId) throw new Error('This job belongs to another profile.');
      job = next;
      message = next.message;
      if (['queued', 'running', 'cancelling'].includes(next.status)) {
        importState = 'running';
        stopping = stopping || next.status === 'cancelling';
        remember(jobKey(op.profileId), id);
        pollTimer = setTimeout(() => void pollJob(id, op), 1000);
        return;
      }
      let result = next.import_result;
      if (
        hosted &&
        (next.status === 'completed' ||
          next.status === 'partial' ||
          (next.status === 'cancelled' && next.records > 0))
      ) {
        saving = true;
        message = 'Saving collected history…';
        const snapshot = await publicApi.result(id);
        if (!owns(op)) return;
        result = await client.importRecords({ ...snapshot, profile_id: op.profileId });
        if (!owns(op)) return;
      }
      importState =
        next.status === 'completed'
          ? 'complete'
          : next.status === 'partial'
            ? 'partial'
            : next.status === 'cancelled'
              ? 'cancelled'
              : 'error';
      message =
        (next.status === 'cancelled' ? 'Collection stopped. ' : '') +
        (result
          ? summary(result) + (hosted ? ` ${next.message}` : '')
          : next.status === 'cancelled'
            ? 'No new records were saved.'
            : next.message);
      remember(jobKey(op.profileId), null);
      await refresh(true);
      finishOperation(op);
    } catch (e) {
      if (!owns(op)) return;
      saving = false;
      importState = 'error';
      if ((e instanceof PublicApiError || e instanceof ApiError) && e.status === 404) {
        remember(jobKey(op.profileId), null);
        message =
          'This collection has expired or is no longer available. Saved history remains intact; use a fresh capture to collect again.';
        finishOperation(op);
        return;
      }
      message = failure(e) + ' Check the saved job without submitting another capture.';
      // Retain ownership while a job or its local persistence is uncertain.
    } finally {
      polling = false;
    }
  }
  async function checkJob() {
    const profileId = operation?.profileId ?? filters.profile_id;
    const id = remembered(jobKey(profileId));
    if (id) await pollJob(id, operation ?? beginOperation(profileId));
  }
  async function stopImport() {
    const op = operation;
    if (!op || stopping || saving) return;
    stopping = true;
    message = 'Stopping collection; validated history will be saved…';
    if (abortCapture) {
      abortCapture.abort();
      return;
    }
    if (!job) return; // Submission must return its job ID before it can be stopped.
    try {
      if (hosted) await publicApi.cancelJob(job.id);
      else await serverClient.cancelJob(job.id);
      if (!owns(op)) return;
      await pollJob(job.id, op);
    } catch (cause) {
      if (!owns(op)) return;
      message =
        failure(cause) + ' The stop was not confirmed. Check the saved job before trying again.';
      importState = 'error';
      stopping = false;
    }
  }
  async function runImport(forceRelay = false) {
    if (importBusy || settingsBusy || inspecting || creating) return;
    // Freeze every input before the first await; callbacks cannot redirect this import.
    const profileId = filters.profile_id;
    const mode = importMode;
    const files = [...selectedFiles];
    const source = sourceProfile || undefined;
    const serverId = server.trim() || undefined;
    const recover = recovery;
    const backup = saveBackup;
    const contribution = contribute;
    let submittedCapture = capture;
    try {
      if (!profileId) throw new Error('Create or choose a profile before importing.');
      if (mode === 'file') {
        if (!files.length) throw new Error('Choose an export folder or files first.');
        if (sourceProfiles.length > 1 && !source)
          throw new Error('Choose the source profile from this Exilium backup.');
      } else {
        if (!submittedCapture.trim())
          throw new Error('Paste a captured HTTP request to fetch records.');
        if (serverId && !/^\d+$/.test(serverId))
          throw new Error(
            'Server ID must be a number, such as 10. Your capture is still in the field.'
          );
        validateCapture(submittedCapture, serverId);
        if (
          hosted &&
          (((recover || backup) && !capabilities.backup) ||
            (contribution && !capabilities.contribution))
        )
          throw new Error('These server features are unavailable. Choose browser-only importing.');
        if (forceRelay && (!capabilities.relay || backup || contribution || recover))
          throw new Error('Server fallback is unavailable for these import choices.');
      }
    } catch (cause) {
      importState = 'error';
      message = failure(cause);
      submittedCapture = '';
      return;
    }
    const op = beginOperation(profileId);
    if (mode === 'capture') capture = '';
    message = '';
    job = null;
    importState = 'running';
    let waitingForJob = false;
    try {
      if (mode === 'file') {
        message = 'Validating export files…';
        const payload = local
          ? await local.readExport(files, profileId, source)
          : await readExport(files, profileId, source);
        if (!owns(op)) return;
        saving = true;
        message = 'Saving records into the archive…';
        const result = await client.importRecords(payload);
        if (!owns(op)) return;
        importState = result.complete === false ? 'partial' : 'complete';
        message = summary(result);
        await refresh(true);
      } else if (hosted && recover) {
        message = 'Verifying account for recovery…';
        const account = await publicApi.verify(submittedCapture, serverId);
        submittedCapture = '';
        if (!owns(op)) return;
        publicConfig = await publicApi.config();
        const restored = await publicApi.backup(account.account_id);
        if (!owns(op)) return;
        saving = true;
        let read = 0,
          added = 0,
          total = 0;
        for (const snapshot of restored.snapshots) {
          const result = await client.importRecords({ ...snapshot, profile_id: profileId });
          read += result.record_count;
          added += result.added_count;
          total = result.total;
        }
        if (!owns(op)) return;
        importState = 'complete';
        message = `Server backup recovered: ${number(read)} records read · ${number(added)} added · ${number(total)} in this profile.`;
        await archiveChanged();
      } else if (hosted && !backup && !contribution && !forceRelay) {
        abortCapture = new AbortController();
        message = 'Starting browser collection…';
        try {
          const payload = await collectCapture(submittedCapture, profileId, {
            server: serverId,
            signal: abortCapture.signal,
            onProgress: (progress) => {
              if (owns(op) && !stopping)
                message = `Collecting history: ${number(progress.records)} records from ${number(progress.pages)} pages…`;
            }
          });
          if (!owns(op)) return;
          saving = true;
          message = 'Saving collected history…';
          const result = await client.importRecords(payload);
          if (!owns(op)) return;
          importState = result.complete === false ? 'partial' : 'complete';
          message =
            summary(result) + ' Saved in this browser; connected Drive sync runs separately.';
        } catch (cause) {
          if (!owns(op)) return;
          if (!(cause instanceof CaptureError)) throw cause;
          relayFallback = cause.canUseServerFallback;
          if (cause.partial) {
            saving = true;
            message = 'Saving partial history…';
            const result = await client.importRecords(cause.partial);
            if (!owns(op)) return;
            importState = cause.code === 'cancelled' ? 'cancelled' : 'partial';
            message =
              (cause.code === 'cancelled' ? 'Collection stopped. ' : failure(cause) + ' ') +
              summary(result);
          } else if (cause.code === 'cancelled') {
            importState = 'cancelled';
            message = 'Collection stopped. No new records were saved.';
          } else throw cause;
        }
        await refresh(true);
      } else {
        message = 'Submitting collection…';
        const submitted = hosted
          ? ({
              ...(await publicApi.fetchCapture({
                capture: submittedCapture,
                server: serverId,
                save_backup: backup,
                contribute: contribution
              })),
              profile_id: profileId
            } as Job)
          : await serverClient.fetchHistory(profileId, submittedCapture, serverId);
        submittedCapture = '';
        if (!owns(op)) return;
        job = submitted;
        remember(jobKey(profileId), submitted.id);
        waitingForJob = true;
        await pollJob(submitted.id, op);
      }
    } catch (cause) {
      if (!owns(op)) return;
      importState = 'error';
      message = failure(cause);
    } finally {
      submittedCapture = '';
      if (!waitingForJob) finishOperation(op);
    }
  }
</script>

{#snippet importStatus()}
  {#if importState !== 'idle'}
    <div class="import-result" class:problem={importState === 'error' || importState === 'partial'}>
      <div role={importState === 'error' ? 'alert' : 'status'} aria-atomic="true">
        {#if importBusy}<progress aria-label="Import in progress"></progress>{/if}
        <strong
          >{saving
            ? 'Saving history'
            : stopping
              ? 'Stopping collection'
              : importState === 'error'
                ? 'Import needs attention'
                : importState === 'partial'
                  ? 'Partial collection'
                  : importState === 'complete'
                    ? 'Import complete'
                    : importState === 'cancelled'
                      ? 'Collection stopped'
                      : 'Import in progress'}</strong
        >
        <p>{message}</p>
      </div>
      <div class="import-actions">
        {#if importBusy && (abortCapture || job) && !saving}
          <button onclick={stopImport} disabled={stopping}
            >{stopping ? 'Stopping…' : 'Stop collection'}</button
          >
        {/if}
        {#if importState === 'error' && remembered(jobKey(operation?.profileId ?? filters.profile_id))}
          <button onclick={checkJob}>Check saved job</button>
        {/if}
        {#if !importBusy && ['complete', 'partial', 'cancelled'].includes(importState)}
          <button class="primary" onclick={viewHistory}>View history</button>
        {/if}
        {#if importBusy && (!importOpen || section !== 'history')}
          <button
            onclick={async () => {
              await goto('/history');
              importOpen = true;
            }}>Show import</button
          >
        {/if}
      </div>
      {#if hosted && relayFallback && !importBusy}
        <p class="small">
          Browser access failed. Paste a fresh capture to explicitly fetch through the tracker
          server. This fallback saves no server backup or contribution.
        </p>
        <button
          onclick={async () => {
            await goto('/history');
            importOpen = true;
            if (capture.trim()) void runImport(true);
          }}
          disabled={saveBackup || contribute || recovery || !capabilities.relay}
        >
          {capture.trim()
            ? 'Fetch through server once'
            : 'Enter a fresh capture for server fallback'}
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:head
  ><title>GFL2 Pull Tracker — {currentPage.title}</title><meta
    name="description"
    content="Your source-preserving Girls’ Frontline 2 recruitment history."
  /></svelte:head
>

<header class="masthead" class:with-tabs={hosted}>
  <a class="wordmark" href="/history" aria-label="Girls’ Frontline 2: Exilium Pull Tracker home"
    ><svg viewBox="0 0 32 32" aria-hidden="true"
      ><path d="M4 4h24v24H4zM10 4v24M4 11h24M16 17h7M16 22h7" /></svg
    ><span aria-hidden="true"
      ><span class="wordmark-full">GIRLS’ FRONTLINE 2: EXILIUM</span><span class="wordmark-short"
        >GFL2</span
      ><span class="wordmark-sub">PULL TRACKER</span></span
    ></a
  >
  {#if hosted}
    <nav class="archive-nav" aria-label="Tracker navigation">
      {#each trackerPages as item}
        <a
          href={`/${item.slug}`}
          class:chosen={section === item.slug}
          aria-current={section === item.slug ? 'page' : undefined}>{item.label}</a
        >
      {/each}
    </nav>
  {/if}
  <div class="header-controls">
    <label class="profile-select"
      ><span>Profile</span><select
        bind:value={filters.profile_id}
        onchange={profileChanged}
        disabled={importBusy || settingsBusy}
        aria-label="Active profile"
        >{#each profiles as p}<option value={p.id}>{p.name}</option>{/each}</select
      ></label
    ><button
      class="primary"
      onclick={async () => {
        if (section !== 'history') {
          await goto('/history');
          importOpen = true;
        } else importOpen = !importOpen;
      }}
      aria-expanded={importOpen && section === 'history'}
      aria-controls="import-panel"
      ><svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d="M10 3v10m-4-4 4 4 4-4M4 13v4h12v-4" /></svg
      >Import history</button
    >
  </div>
</header>

<main>
  {#if !importOpen || section !== 'history'}{@render importStatus()}{/if}
  {#if hosted && section !== 'history' && initializing}
    <section class="empty-state" aria-label={currentPage.title} aria-busy="true">
      <p role="status">Loading {currentPage.label.toLowerCase()}…</p>
    </section>
  {:else if hosted && section !== 'history' && !local}
    <section class="empty-state" aria-label={currentPage.title}>
      <p role="alert">{error || 'Could not open your browser archive. Reload to try again.'}</p>
    </section>
  {:else if hosted && section === 'statistics'}
    <CommunityStatistics />
  {:else if hosted && section !== 'history' && local}
    <ArchiveSettings
      {local}
      {profiles}
      activeProfileId={filters.profile_id}
      googleClientId={data.googleClientId}
      {drive}
      {publicApi}
      {publicConfig}
      importBusy={importBusy || settingsBusy}
      onbusychange={(busy) => {
        settingsBusy = busy;
      }}
      {pendingRestoreFile}
      {restoreRequest}
      onrestoreaccepted={() => {
        pendingRestoreFile = null;
        restoreRequest = 0;
      }}
      section={section as 'profiles' | 'backup' | 'privacy'}
      onchanged={archiveChanged}
      onselect={(id) => {
        if (importBusy) return;
        filters.profile_id = id;
        void profileChanged();
      }}
      onrecover={async () => {
        if (importBusy || !capabilities.backup) return;
        recovery = true;
        importMode = 'capture';
        importOpen = true;
        await goto('/history');
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
                disabled={importBusy || settingsBusy}
                >{#each profiles as p}<option value={p.id}>{p.name}</option>{/each}</select
              ></label
            ><button
              class="text-button"
              disabled={importBusy || settingsBusy}
              onclick={() => (createOpen = !createOpen)}
              aria-expanded={createOpen}>Create a profile</button
            >{#if createOpen}<form
                onsubmit={(event) => {
                  event.preventDefault();
                  void addProfile();
                }}
              >
                <label
                  >Profile name<input
                    bind:value={profileName}
                    required
                    maxlength="120"
                    disabled={importBusy || creating}
                    placeholder="e.g. Commander · Global"
                  /></label
                ><button type="submit" disabled={!profileName.trim() || creating || importBusy}
                  >{creating ? 'Creating…' : 'Create profile'}</button
                >
              </form>{/if}{#if profileError}<p class="small" role="alert">{profileError}</p>{/if}
            <p class="small">
              Older exports need explicit profile assignment. Use a separate profile for each game
              account.
            </p>
          </div>
          <div class="import-source">
            <div class="segmented" role="group" aria-label="Import method">
              <button
                class:chosen={importMode === 'file'}
                aria-pressed={importMode === 'file'}
                disabled={importBusy || settingsBusy}
                onclick={() => {
                  importMode = 'file';
                  importState = 'idle';
                  relayFallback = false;
                }}>Saved export</button
              ><button
                class:chosen={importMode === 'capture'}
                aria-pressed={importMode === 'capture'}
                disabled={importBusy || settingsBusy}
                onclick={() => {
                  importMode = 'capture';
                  importState = 'idle';
                  relayFallback = false;
                }}>Captured request</button
              >
            </div>
            {#if importMode === 'file'}<p>
                Choose a collector export folder, supported Exilium JSON, or a compressed tracker
                backup.
              </p>
              <div class="file-choices">
                <label class="file-button"
                  >Choose export folder<input
                    type="file"
                    disabled={importBusy || settingsBusy}
                    multiple
                    webkitdirectory
                    onchange={(e) => {
                      void chooseFiles(Array.from(e.currentTarget.files ?? []));
                      e.currentTarget.value = '';
                    }}
                  /></label
                ><label class="file-button secondary"
                  >Choose files<input
                    type="file"
                    disabled={importBusy || settingsBusy}
                    multiple
                    accept=".json,.gz,.gzip,application/json,application/gzip"
                    onchange={(e) => {
                      void chooseFiles(Array.from(e.currentTarget.files ?? []));
                      e.currentTarget.value = '';
                    }}
                  /></label
                >
              </div>
              <p class="small">
                {selectedFiles.length
                  ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected`
                  : 'Tracker backups open archive restoration; JSON exports merge into the selected profile.'}
              </p>
              <button
                class="text-button restore-link"
                disabled={importBusy || settingsBusy || inspecting}
                onclick={() => openRestore()}>Restore a tracker backup</button
              >
              {#if sourceProfiles.length > 1}
                <label
                  >Profile from Exilium backup<select
                    bind:value={sourceProfile}
                    disabled={importBusy || settingsBusy}
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
                  disabled={importBusy || settingsBusy}
                  bind:value={capture}
                  rows="4"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Paste the full captured HTTPS request"></textarea></label
              ><label
                >Server ID (optional)<input
                  bind:value={server}
                  disabled={importBusy || settingsBusy}
                  inputmode="numeric"
                  placeholder="e.g. 10"
                /></label
              >
              <p class="small">
                Credentials stay in memory and are cleared on submission. A fresh capture is
                required to retry.
              </p>
              {#if hosted}
                <div class="capture-options">
                  <label class="check-control"
                    ><input
                      type="checkbox"
                      bind:checked={recovery}
                      disabled={importBusy || !capabilities.backup}
                    /> Recover a private server backup</label
                  >
                  {#if !recovery}
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={saveBackup}
                        disabled={importBusy || !capabilities.backup}
                        onchange={() => remember('gfl2.server-backup', String(saveBackup))}
                      /> Save server backup</label
                    >
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={contribute}
                        disabled={importBusy || !capabilities.contribution}
                        onchange={() => remember('gfl2.contribute', String(contribute))}
                      /> Contribute to community statistics</label
                    >
                  {/if}
                  {#if !capabilities.backup || !capabilities.contribution}
                    <p class="small">
                      {!capabilities.backup
                        ? 'Server backup and recovery are unavailable. '
                        : ''}{!capabilities.contribution
                        ? 'Community contributions are unavailable. '
                        : ''}Browser imports remain available; Drive sync is configured separately.
                    </p>
                  {/if}
                  {#if recovery || saveBackup || contribute}
                    <p class="small">
                      This request sends your capture to the tracker server. Credentials are used in
                      memory and never saved. Only aggregate statistics are public.
                    </p>
                  {:else}
                    <p class="small">
                      The browser contacts official game servers directly. No capture or history is
                      sent to this tracker server.
                    </p>
                  {/if}
                </div>
              {/if}
            {/if}
            <button
              class="primary"
              onclick={() => runImport()}
              disabled={importBusy ||
                settingsBusy ||
                inspecting ||
                creating ||
                (hosted &&
                  importMode === 'capture' &&
                  (recovery || saveBackup || contribute) &&
                  !publicConfig?.identity_verification.available)}
              >{importBusy
                ? 'Working…'
                : importMode === 'file'
                  ? 'Validate and import'
                  : 'Fetch accessible history'}</button
            >
            {@render importStatus()}
            {#if hosted && importMode === 'capture'}<ImportGuide />{/if}
          </div>
        </div>
      </section>
    {/if}

    <section class="overview" aria-labelledby="overview-title">
      <div class="title-row">
        <h1 id="overview-title">Recruitment ledger</h1>
        <span class="local-label"><span></span>Local archive</span>
      </div>
      <div class="summary-strip">
        <div class="summary-total">
          <span title="One record = one pull. Item quantity is preserved separately."
            >Recorded pulls</span
          ><strong>{stats ? number(stats.total) : loading || error ? '—' : '0'}</strong>
        </div>
        <div>
          <span>Recorded range</span><strong class="date-range"
            >{date(stats?.date_from)}<span> — </span>{date(stats?.date_to)}</strong
          >
        </div>
        <div>
          <span>Last import</span><strong
            >{date(stats?.last_import_at)}<small
              >{stats?.last_import_at ? time(stats.last_import_at) : ''}</small
            ></strong
          >
        </div>
      </div>
      <EliteHistory
        rows={overviewRows}
        profileId={filters.profile_id}
        loading={overviewLoading}
        error={overviewError}
      />
      {#if overviewError}<button class="text-button" onclick={() => refresh()}
          >Refresh overview</button
        >{/if}
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
          <h2 id="history-title" tabindex="-1">Pull history</h2>
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
      <p class="small">Times use your browser's time zone. Date filters use UTC.</p>
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
        <MultiSelect
          id="filter-rarity"
          label="Rarity"
          allLabel="All rarities"
          options={options.rarities.map((value) => ({
            value,
            label:
              value === 'Elite'
                ? '5★ Elite'
                : value === 'Standard'
                  ? '4★ Standard'
                  : value === 'Retired'
                    ? '3★ Retired'
                    : 'Unknown'
          }))}
          value={filters.rarity}
          onchange={(value) => {
            filters.rarity = value;
            void refresh(true);
          }}
        />
        <MultiSelect
          id="filter-kind"
          label="Item kind"
          allLabel="All kinds"
          options={options.kinds.map((value) => ({
            value,
            label: value === 'doll' ? 'Dolls' : value === 'weapon' ? 'Weapons' : 'Unclassified'
          }))}
          value={filters.kind}
          onchange={(value) => {
            filters.kind = value;
            void refresh(true);
          }}
        />
        <MultiSelect
          id="filter-type"
          label="Recruitment type"
          allLabel="All types"
          options={options.types.map((value) => ({
            value: String(value),
            label: recruitmentName(value)
          }))}
          value={filters.type_id}
          onchange={(value) => {
            filters.type_id = value;
            void refresh(true);
          }}
        />
        <MultiSelect
          id="filter-pool"
          label="Pool ID"
          allLabel="All pools"
          options={options.pools.map((value) => ({ value: String(value), label: String(value) }))}
          value={filters.pool_id}
          onchange={(value) => {
            filters.pool_id = value;
            void refresh(true);
          }}
        />
        <label
          >From (UTC)<input
            type="date"
            bind:value={filters.date_from}
            onchange={() => refresh(true)}
          /></label
        >
        <label
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
        </div>{:else if loading && !history.items.length}<div class="empty-state" role="status">
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
        <p id="history-pity-help" class="history-pity-help">
          Pity is counted separately for each recruitment. A 5★ resets its counter; filters can hide
          that reward.
        </p>
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
          <table aria-describedby="history-pity-help">
            <thead
              ><tr
                ><th>Item</th><th>Rarity / kind</th><th>Pity</th><th>Recorded</th><th
                  class="quantity">Qty.</th
                ><th><span class="sr-only">Record details</span></th></tr
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
                  ><td class="history-pity"
                    ><span class="pity-count"
                      >{row.pity}{#if row.pity_uncertain}<sup
                          title="History may be missing; pity is uncertain"
                          aria-label="uncertain">?</sup
                        >{/if}
                      <span class="pity-unit">{row.pity === 1 ? 'pull' : 'pulls'}</span></span
                    >
                    {#if row.rarity === 'Elite'}<span class="pity-reset">5★ · resets pity</span
                      >{/if}
                    <span class="pity-recruitment">{recruitmentName(row.type_id)}</span></td
                  ><td
                    ><span>{date(row.timestamp)}</span><span class="cell-secondary"
                      >{time(row.timestamp)}</span
                    ></td
                  ><td class="quantity">{row.quantity}</td><td
                    ><button
                      class="details-button"
                      disabled={loading}
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
                        <span><strong>Original item ID</strong>{row.item_id}</span>
                        <span><strong>Item quantity</strong>{row.quantity}</span><span
                          ><strong>Recruitment</strong>{recruitmentName(row.type_id)} (type {row.type_id})</span
                        ><span><strong>Pool ID</strong>{row.pool_id}</span><span
                          ><strong>Source page</strong>{row.source_page}</span
                        ><span><strong>Catalog region</strong>{row.region ?? 'Unknown'}</span><span
                          ><strong>Pull group</strong>{row.estimated_group_size > 1
                            ? '10-pull (assumed from matching timestamps)'
                            : 'Single pull'}
                          {#if row.estimated_group_size > 1}<small
                              >{row.estimated_group_size} saved records in this group</small
                            >{/if}</span
                        >
                      </div></td
                    ></tr
                  >{/if}{/each}</tbody
            >
          </table>
        </section>
        <div class="pagination">
          <span class="sr-only" role="status"
            >{loading ? `Loading page ${requestedPage}…` : ''}</span
          >
          <p>
            Showing {number((history.page - 1) * history.page_size + 1)}–{number(
              Math.min(history.page * history.page_size, history.total)
            )} of {number(history.total)}<span>&nbsp;·&nbsp;Newest first</span>
          </p>
          <div>
            <label class="page-size"
              ><span>Rows</span><select
                bind:value={filters.page_size}
                disabled={loading}
                onchange={() => refresh(true)}
                ><option value={20}>20</option><option value={50}>50</option><option value={100}
                  >100</option
                ></select
              ></label
            ><button
              aria-label="Previous page"
              disabled={loading || history.page <= 1}
              onclick={() => changePage(history.page - 1)}>Previous</button
            >
            <form
              class="page-jump"
              onsubmit={(event) => {
                event.preventDefault();
                if (pageNumber !== undefined) void changePage(pageNumber);
              }}
            >
              <input
                type="number"
                aria-label="Page number"
                aria-describedby="page-total"
                title="Enter a page number and press Enter"
                min="1"
                max={history.pages}
                step="1"
                required
                inputmode="numeric"
                enterkeyhint="go"
                bind:value={pageNumber}
                disabled={loading}
                onfocus={(event) => event.currentTarget.select()}
                onblur={() => (pageNumber = history.page)}
                onkeydown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    pageNumber = history.page;
                  }
                }}
              />
              <span id="page-total" aria-label={`of ${history.pages} pages`}>/ {history.pages}</span
              >
            </form>
            <button
              aria-label="Next page"
              bind:this={nextPageButton}
              disabled={loading || history.page >= history.pages}
              onclick={() => changePage(history.page + 1)}>Next</button
            >
          </div>
        </div>
        {#if pageError}
          <div class="pagination-error" role="alert">
            <p>
              Could not load page {requestedPage}. Still showing page {history.page}. {pageError}
            </p>
            <button onclick={() => requestedPage !== null && changePage(requestedPage)}
              >Try again</button
            >
          </div>
        {/if}
      {/if}
    </section>
  {/if}
  <footer>
    <span>GFL2 Pull Tracker</span>
    <GitHubLink />
    <a href="/privacy-policy">Privacy policy</a>
    <a
      href="https://github.com/Infernal-Crack-LED/gfl2-team-builder"
      target="_blank"
      rel="noreferrer">Catalog attribution</a
    >
  </footer>
</main>
