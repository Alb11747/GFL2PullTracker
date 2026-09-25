<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { trackOperation } from '$lib/telemetry/browser';
  import { trackerPages, type TrackerSection } from '$lib/tracker-routes';
  import MultiSelect from '$lib/components/MultiSelect.svelte';
  import EliteHistory from '$lib/components/EliteHistory.svelte';
  import AboutPanel from '$lib/components/AboutPanel.svelte';
  import GitHubLink from '$lib/components/GitHubLink.svelte';
  import LoadingRegion from '$lib/components/LoadingRegion.svelte';
  import LoadingLabel from '$lib/components/LoadingLabel.svelte';
  import { JobMemory } from '$lib/local/job-memory';
  import { createOperationPauses } from '$lib/local/operation-pauses';
  import { capturePaginationAnchor } from '$lib/pagination-anchor';
  import { recruitmentName } from '$lib/recruitment';
  import { profileFilters } from '$lib/profile-history';
  import { client as serverClient, ApiError } from '$lib/api';
  import { createLocalClient } from '$lib/local/client';
  import type { createDriveSync } from '$lib/sync/controller';
  import { createPublicClient, PublicApiError } from '$lib/public-api';
  import { serverCapabilities, savedServerChoices } from '$lib/import-policy';
  import { submissionIdentity } from '$lib/submission-policy';
  import type {
    ImportResult,
    ImportInput,
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
  let archiveReady = $state(false);
  let local = $state<ReturnType<typeof createLocalClient>>();
  let client = serverClient as Pick<
    typeof serverClient,
    | 'profiles'
    | 'createProfile'
    | 'history'
    | 'rewards'
    | 'statistics'
    | 'filterOptions'
    | 'importRecords'
  >;
  const publicApi = createPublicClient();
  let drive = $state<ReturnType<typeof createDriveSync>>();
  let driveReady: Promise<void> = Promise.resolve();
  const importLeases = createOperationPauses();
  let preflight = $state(false);
  let retainedCollection = $state.raw<ImportInput | null>(null);
  async function pauseForImport(op: Operation, validateDestination = true) {
    await driveReady;
    if (!owns(op)) return false;
    if (drive) {
      const controller = drive;
      await importLeases.acquire(op.id, () => controller.acquirePause());
      if (!owns(op)) {
        importLeases.release(op.id);
        return false;
      }
    }
    // Existing server jobs must remain retrievable even if another tab removed
    // their destination. A failed save retains their result for download.
    if (!validateDestination) return true;
    // A pass already running when collection was requested may have deleted
    // this destination. Revalidate before clearing any submitted credentials.
    const destinations = await client.profiles();
    if (!owns(op)) return false;
    if (!destinations.some((profile) => profile.id === op.profileId))
      throw new Error(
        'The destination profile changed during sync. Choose a profile and try again; your capture is still in the field.'
      );
    return true;
  }
  async function saveCollected(payload: ImportInput) {
    if (retainedCollection && retainedCollection !== payload)
      throw new Error(
        'Save or discard the collected records in this tab before retrieving another collection. Download a recovery copy first if needed.'
      );
    // Collector results contain validated records, never the captured credentials.
    // Keep them in memory until the durable write succeeds.
    retainedCollection = payload;
    const result = await client.importRecords(payload);
    retainedCollection = null;
    return result;
  }
  async function retryCollected() {
    const payload = retainedCollection;
    if (!payload || saving || polling) return;
    const op = operation ?? beginOperation(payload.profile_id);
    saving = true;
    importState = 'running';
    message = 'Saving collected history…';
    try {
      if (!(await pauseForImport(op))) return;
      const result = await saveCollected(payload);
      rememberJob(op.profileId, null);
      importState = result.complete === false ? 'partial' : 'complete';
      message = summary(result);
      await refresh(true);
    } catch (cause) {
      importState = 'error';
      message =
        failure(cause) +
        ' Collected records remain in this tab. Retry saving or download them before leaving.';
    } finally {
      finishOperation(op);
    }
  }
  function downloadCollected() {
    if (!retainedCollection) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(retainedCollection.records_document)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'records.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  let publicConfig = $state<Awaited<ReturnType<typeof publicApi.config>>>();
  // Every panel shares this route component so navigation retains imports and Drive authorization.
  const section = $derived(page.params.section as TrackerSection);
  const currentPage = $derived(trackerPages.find((item) => item.slug === section)!);
  let StatisticsPanel =
    $state<typeof import('$lib/components/CommunityStatistics.svelte').default>();
  let SettingsPanel = $state<typeof import('$lib/components/ArchiveSettings.svelte').default>();
  let panelError = $state('');
  let aboutVisited = $state(false);
  $effect(() => {
    if (hosted && section === 'about') aboutVisited = true;
  });
  const panelLoading = $derived(
    hosted &&
      section !== 'history' &&
      section !== 'about' &&
      (initializing ||
        (!panelError && (section === 'statistics' ? !StatisticsPanel : !SettingsPanel)))
  );
  $effect(() => {
    if (!hosted || section === 'history' || section === 'about') return;
    const target = section;
    panelError = '';
    if (target === 'statistics') {
      void import('$lib/components/CommunityStatistics.svelte')
        .then((module) => {
          StatisticsPanel = module.default;
        })
        .catch((cause) => {
          if (section === target) panelError = failure(cause);
        });
    } else {
      void import('$lib/components/ArchiveSettings.svelte')
        .then((module) => {
          SettingsPanel = module.default;
        })
        .catch((cause) => {
          if (section === target) panelError = failure(cause);
        });
    }
  });
  let submitHistory = $state(false),
    recovery = $state(false);
  const capabilities = $derived(serverCapabilities(publicConfig));
  type Operation = Readonly<{
    id: number;
    profileId: string;
    started: number;
    kind: 'import' | 'restore';
  }>;
  let operation = $state<Operation | null>(null);
  let operationSequence = 0;
  const importBusy = $derived(operation !== null);
  let settingsBusy = $state(false);
  let stopping = $state(false),
    saving = $state(false),
    inspecting = $state(false);
  let polling = $state(false);
  let pendingRestoreFile = $state<File | null>(null);
  let restoreRequest = $state(0);
  let relayFallback = $state(false);
  const owns = (op: Operation) => !disposed && operation?.id === op.id;
  function beginOperation(profileId: string, kind: 'import' | 'restore' = 'import'): Operation {
    const op = Object.freeze({
      id: ++operationSequence,
      profileId,
      started: performance.now(),
      kind
    });
    operation = op;
    stopping = false;
    saving = false;
    relayFallback = false;
    return op;
  }
  function finishOperation(op: Operation) {
    importLeases.release(op.id);
    if (!owns(op)) return;
    // Only terminal operations report; polling and preflight validation do not.
    if (!preflight && ['complete', 'partial', 'error', 'cancelled'].includes(importState)) {
      const outcome =
        importState === 'complete' ? 'success' : importState === 'error' ? 'failed' : importState;
      trackOperation(
        op.kind,
        outcome as 'success' | 'failed' | 'partial' | 'cancelled',
        performance.now() - op.started
      );
    }
    operation = null;
    preflight = false;
    stopping = false;
    saving = false;
    abortCapture = undefined;
    if (archiveDirty && !disposed)
      void archiveChanged().catch((cause) => {
        error = failure(cause);
      });
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
  let unsubscribeDriveTelemetry: (() => void) | undefined;
  let archiveRevision = $state(0);
  let lastNotifiedRevision = -1;
  let archiveRefresh: Promise<void> | undefined;
  let archiveDirty = false;
  function archiveChanged(): Promise<void> {
    archiveDirty = true;
    if (archiveRefresh) return archiveRefresh;
    archiveRefresh = (async () => {
      do {
        archiveDirty = false;
        const revision = local ? await local.revision() : archiveRevision + 1;
        if (revision === lastNotifiedRevision) continue;
        archiveRevision = revision;
        profiles = await client.profiles();
        if (!importBusy && !profiles.some((p) => p.id === filters.profile_id))
          filters.profile_id = profiles[0]?.id || '';
        await refresh();
        lastNotifiedRevision = revision;
      } while (archiveDirty && !disposed);
    })().finally(() => {
      archiveRefresh = undefined;
    });
    return archiveRefresh;
  }
  let profiles = $state.raw<Profile[]>([]),
    history = $state.raw<History>({ items: [], total: 0, page: 1, page_size: 20, pages: 1 });
  let stats = $state.raw<Statistics | null>(null),
    options = $state.raw<FilterOptions>({ rarities: [], kinds: [], types: [], pools: [] });
  let metadataKey = '';
  let metadata: Promise<[Statistics, FilterOptions]> | undefined;
  let ledgerKey = '';
  let ledger: Promise<History> | undefined;
  const rewardQuery = (
    profileId: string,
    typeId: number | null,
    rarities: string[],
    offset: number,
    limit: number,
    preview?: { consumer: string; preview: boolean }
  ) =>
    local && preview?.preview
      ? local.rewardPreview(profileId, typeId, rarities, offset, limit, preview.consumer)
      : client.rewards(profileId, typeId, rarities, offset, limit);
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
    if (importBusy || retainedCollection) return;
    const selection = ++fileSelection;
    inspecting = true;
    selectedFiles = files;
    sourceProfiles = [];
    sourceProfile = '';
    importState = 'idle';
    message = '';
    try {
      const { classifyImportFiles } = await import('$lib/import-selection');
      const format = await classifyImportFiles(files, hosted, local?.decodeBackup);
      if (selection !== fileSelection) return;
      if (format === 'backup') {
        selectedFiles = [];
        await openRestore(files[0]);
        return;
      }
      const choices = local
        ? await local.inspectExiliumProfiles(files)
        : await (await import('$lib/import-files')).inspectExiliumProfiles(files);
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
  const PROFILE_KEY = untrack(() =>
    data.mode === 'public' ? 'gfl2-stable.profile' : 'gfl2.profile'
  );
  const jobs = new JobMemory(
    () => localStorage,
    untrack(() => (data.mode === 'public' ? 'gfl2-stable.job.' : 'gfl2.job.'))
  );
  let jobRevision = $state(0);
  function rememberedJob(profile: string) {
    void jobRevision;
    return jobs.get(profile);
  }
  function rememberJob(profile: string, id: string | null) {
    jobs.set(profile, id);
    jobRevision++;
  }
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
    // LoadingRegion conceals the old selection while retaining its responsive
    // geometry. Replace it only when the latest request settles.
    expanded = null;
    if (optionsProfile !== filters.profile_id) {
      stats = null;
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
    remember(PROFILE_KEY, filters.profile_id);
    // The shared shell retains ongoing operations; hidden routes do no ledger work.
    if (section !== 'history') return;
    const id = invalidateResults();
    if (!filters.profile_id) {
      history = { items: [], total: 0, page: 1, page_size: filters.page_size, pages: 1 };
      stats = null;
      loading = false;
      return;
    }
    const profileId = filters.profile_id;
    try {
      if (local) archiveRevision = await local.revision();
      if (id !== request || disposed) return;
      const key = `${profileId}:${archiveRevision}`;
      if (metadataKey !== key || !metadata) {
        metadataKey = key;
        metadata = Promise.all([
          client.statistics(profileFilters(profileId)),
          client.filterOptions(profileId)
        ]);
        const current = metadata;
        void current.catch(() => {
          if (metadata === current) metadata = undefined;
        });
      }
      const nextLedgerKey = JSON.stringify([archiveRevision, filters]);
      if (ledgerKey !== nextLedgerKey || !ledger) {
        ledgerKey = nextLedgerKey;
        ledger = client.history({ ...filters });
        const current = ledger;
        void current.catch(() => {
          if (ledger === current) ledger = undefined;
        });
      }
      const [h, [s, o]] = await Promise.all([ledger, metadata]);
      if (id !== request || disposed) return;
      history = h;
      stats = s;
      options = o;
      optionsProfile = profileId;
    } catch (cause) {
      if (id === request && !disposed) error = failure(cause);
    } finally {
      if (id === request && !disposed) loading = false;
    }
  }
  async function configureServices() {
    try {
      publicConfig = await publicApi.config();
      if (disposed) return;
      ({ submitHistory } = savedServerChoices(publicConfig, remembered('gfl2.submit-history')));
    } catch {
      // Optional services never block the browser archive.
    }
  }
  $effect(() => {
    if (archiveReady && !initializing && section === 'history') untrack(() => void refresh());
  });
  async function initialize() {
    try {
      if (hosted) {
        local = createLocalClient();
        client = local;
        // Configuration and sync code load independently of personal history.
        void configureServices();
        driveReady = import('$lib/sync/controller')
          .then(({ createDriveSync }) => {
            if (!disposed && local) {
              drive = createDriveSync({ clientId: data.googleClientId, store: local });
              let started: number | null = null;
              // Observe the controller in the shared shell, including automatic syncs.
              unsubscribeDriveTelemetry = drive.subscribe((status) => {
                if (status.phase === 'syncing' && started === null) started = performance.now();
                if (started === null || status.phase === 'syncing') return;
                const elapsed = performance.now() - started;
                started = null;
                if (status.phase === 'synced') trackOperation('drive_sync', 'success', elapsed);
                else if (status.phase === 'error' || status.phase === 'reconnect')
                  trackOperation('drive_sync', 'failed', elapsed);
                else if (status.phase === 'conflict')
                  trackOperation('drive_sync', 'partial', elapsed);
              });
            }
          })
          .catch((cause) => {
            if (!disposed) error = failure(cause);
          });
        unsubscribeArchive = local.subscribe(() => {
          archiveDirty = true;
          // Operation completion refreshes once with the committed revision.
          if (!disposed && !importBusy && !settingsBusy && !creating)
            void archiveChanged().catch((cause) => {
              error = failure(cause);
            });
        });
      }
      profiles = await client.profiles();
      const saved = remembered(PROFILE_KEY);
      filters.profile_id = profiles.find((p) => p.id === saved)?.id ?? profiles[0]?.id ?? '';
      if (!profiles.length) {
        importOpen = true;
        createOpen = true;
      }
      archiveReady = true;
      initializing = false;
      const jobId = rememberedJob(filters.profile_id);
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
    const protectCollected = (event: BeforeUnloadEvent) => {
      if (retainedCollection) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protectCollected);
    return () => {
      disposed = true;
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
      capture = '';
      abortCapture?.abort();
      window.removeEventListener('beforeunload', protectCollected);
      unsubscribeDriveTelemetry?.();
      drive?.destroy();
      importLeases.releaseAll();
      unsubscribeArchive?.();
      local?.close();
    };
  });
  function searchChanged() {
    clearTimeout(searchTimer);
    invalidateResults();
    searchTimer = setTimeout(() => void refresh(true), 100);
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
    if (!retainedCollection) {
      message = '';
      importState = 'idle';
    }
    await refresh(true);
    const id = rememberedJob(filters.profile_id);
    if (id && !retainedCollection) {
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
      if (archiveDirty && !disposed)
        void archiveChanged().catch((cause) => {
          error = failure(cause);
        });
    }
  }
  async function pollJob(id: string, op: Operation) {
    if (!owns(op) || polling) return;
    clearTimeout(pollTimer);
    polling = true;
    try {
      if (!(await pauseForImport(op, false))) return;
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
        rememberJob(op.profileId, id);
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
        result = await saveCollected({ ...snapshot, profile_id: op.profileId });
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
      rememberJob(op.profileId, null);
      if (!local) archiveRevision++;
      await refresh(true);
      finishOperation(op);
    } catch (e) {
      if (!owns(op)) return;
      saving = false;
      importState = 'error';
      if ((e instanceof PublicApiError || e instanceof ApiError) && e.status === 404) {
        rememberJob(op.profileId, null);
        message =
          'This collection has expired or is no longer available. Saved history remains intact; use a fresh capture to collect again.';
        finishOperation(op);
        return;
      }
      message =
        failure(e) +
        (retainedCollection
          ? ' Collected records remain in this tab. Retry saving or download them before leaving.'
          : ' Check the saved job without submitting another capture.');
      if (retainedCollection) finishOperation(op);
      // Retain ownership while a job or its local persistence is uncertain.
    } finally {
      polling = false;
    }
  }
  async function checkJob() {
    if (retainedCollection) return;
    const profileId = operation?.profileId ?? filters.profile_id;
    const id = rememberedJob(profileId);
    if (id) await pollJob(id, operation ?? beginOperation(profileId));
  }
  async function stopImport() {
    const op = operation;
    if (!op || stopping || saving) return;
    if (preflight) {
      importState = 'cancelled';
      message =
        'Collection cancelled before it started. Your capture and selected files are unchanged.';
      finishOperation(op);
      return;
    }
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
    if (importBusy || settingsBusy || inspecting || creating || retainedCollection) return;
    // Freeze every input before the first await; callbacks cannot redirect this import.
    const profileId = filters.profile_id;
    const mode = importMode;
    const files = [...selectedFiles];
    const source = sourceProfile || undefined;
    const serverId = server.trim() || undefined;
    const recover = recovery;
    const submission = submitHistory && !recover;
    let submittedCapture = capture;
    // Acquire ownership before loading optional code, including capture validation.
    const op = beginOperation(profileId, hosted && recover ? 'restore' : 'import');
    // Previous terminal jobs cannot be stopped or polled on behalf of this import.
    job = null;
    preflight = true;
    importState = 'running';
    let captureModule: typeof import('$lib/capture') | undefined;
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
        captureModule = await import('$lib/capture');
        if (!owns(op)) return;
        captureModule.validateCapture(submittedCapture, serverId);
        if (hosted && (recover || submission) && !capabilities.submission)
          throw new Error('These server features are unavailable. Choose browser-only importing.');
        if (forceRelay && (!capabilities.relay || submission || recover))
          throw new Error('Server fallback is unavailable for these import choices.');
      }
      importState = 'running';
      message = 'Waiting for archive sync…';
      if (!(await pauseForImport(op))) return;
    } catch (cause) {
      if (!owns(op)) return;
      importState = 'error';
      message = failure(cause);
      submittedCapture = '';
      finishOperation(op);
      return;
    }
    if (!owns(op)) return;
    preflight = false;
    if (mode === 'capture') capture = '';
    message = '';
    importState = 'running';
    let waitingForJob = false;
    try {
      if (mode === 'file') {
        message = 'Validating export files…';
        const payload = local
          ? await local.readExport(files, profileId, source)
          : await (await import('$lib/import-files')).readExport(files, profileId, source);
        if (!owns(op)) return;
        saving = true;
        message = 'Saving records into the archive…';
        const result = await saveCollected(payload);
        if (!owns(op)) return;
        importState = result.complete === false ? 'partial' : 'complete';
        message = summary(result);
        if (!local) archiveRevision++;
        await refresh(true);
      } else if (hosted && recover) {
        message = 'Verifying account for recovery…';
        const account = await publicApi.verify(submittedCapture, serverId);
        submittedCapture = '';
        if (!owns(op)) return;
        publicConfig = await publicApi.config();
        const restored = await publicApi.backup(account.account_id);
        if (!owns(op)) return;
        const destination = (await client.profiles()).find((profile) => profile.id === profileId);
        if (!owns(op)) return;
        if (!destination)
          throw new Error(
            'This profile is no longer available. Choose a profile before recovering.'
          );
        // Associated server snapshots retain their original, potentially incomplete identity.
        // Check the authorized owner before merging any of those original documents locally.
        if (submissionIdentity(destination, account.identity) === 'conflict')
          throw new Error(
            'This profile belongs to a different account. Choose a matching or empty profile before recovering.'
          );
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
      } else if (hosted && !submission && !forceRelay) {
        const { collectCapture, CaptureError } = captureModule!;
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
          const result = await saveCollected(payload);
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
            const result = await saveCollected(cause.partial);
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
                submit_history: submission
              })),
              profile_id: profileId
            } as Job)
          : await serverClient.fetchHistory(profileId, submittedCapture, serverId);
        submittedCapture = '';
        if (!owns(op)) return;
        job = submitted;
        rememberJob(profileId, submitted.id);
        waitingForJob = true;
        await pollJob(submitted.id, op);
      }
    } catch (cause) {
      if (!owns(op)) return;
      importState = 'error';
      message =
        failure(cause) +
        (retainedCollection
          ? ' Collected records remain in this tab. Retry saving or download them before leaving.'
          : '');
    } finally {
      submittedCapture = '';
      if (!waitingForJob) finishOperation(op);
    }
  }
</script>

{#snippet importStatus()}
  {#if importState !== 'idle'}
    <div class="import-result" class:problem={importState === 'error' || importState === 'partial'}>
      <LoadingRegion busy={importBusy} message="" hideContent={false}>
        <div role={importState === 'error' ? 'alert' : 'status'} aria-atomic="true">
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
      </LoadingRegion>
      <div class="import-actions">
        {#if retainedCollection && importState === 'error' && !saving && !polling}
          <button onclick={retryCollected} disabled={saving || polling}>Retry saving records</button
          >
          <button onclick={downloadCollected}>Download collected records</button>
          <button
            onclick={() => {
              if (saving || polling) return;
              retainedCollection = null;
              if (operation) finishOperation(operation);
            }}>Discard collected copy</button
          >
        {/if}
        {#if importBusy && (preflight || abortCapture || job) && !saving}
          <button onclick={stopImport} disabled={stopping}
            ><LoadingLabel
              busy={stopping}
              label="Stop collection"
              loadingLabel="Stopping…"
            /></button
          >
        {/if}
        {#if importState === 'error' && !retainedCollection && rememberedJob(operation?.profileId ?? filters.profile_id)}
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
          disabled={submitHistory || recovery || !capabilities.relay}
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
  <div class="header-controls ph-no-capture">
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
</header>

<main class="ph-no-capture">
  {#if !importOpen || section !== 'history'}{@render importStatus()}{/if}
  <LoadingRegion busy={panelLoading} message={`Loading ${currentPage.label.toLowerCase()}…`}>
    {#if hosted && section === 'about'}
      <!-- About is independent of the archive and its lazy settings module. -->
    {:else if hosted && section !== 'history' && initializing}
      <div></div>
    {:else if hosted && section !== 'history' && !local}
      <section class="empty-state" aria-label={currentPage.title}>
        <p role="alert">{error || 'Could not open your browser archive. Reload to try again.'}</p>
      </section>
    {:else if hosted && section === 'statistics'}
      {#if StatisticsPanel}<StatisticsPanel />{:else if panelError}<p role="alert">
          {panelError}
        </p>{/if}
    {:else if hosted && section !== 'history' && local}
      {#if SettingsPanel}
        <SettingsPanel
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
            if (!busy && archiveDirty && !disposed)
              void archiveChanged().catch((cause) => {
                error = failure(cause);
              });
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
            if (importBusy || !capabilities.submission) return;
            recovery = true;
            importMode = 'capture';
            importOpen = true;
            await goto('/history');
          }}
        />
      {:else if panelError}<p role="alert">{panelError}</p>{/if}
    {:else}
      {#if importOpen}
        <section id="import-panel" class="import-panel" aria-labelledby="import-title">
          <div class="section-heading">
            <div>
              <h2 id="import-title">Add to your archive</h2>
              <p>
                Imports merge into the selected profile. Repeated pulls remain separate records.
              </p>
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
                    ><LoadingLabel
                      busy={creating}
                      label="Create profile"
                      loadingLabel="Creating…"
                    /></button
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
                      >{#each sourceProfiles as source}<option value={source.id}
                          >{source.name}</option
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
                  Credentials stay in memory and are cleared when collection starts. A new
                  collection needs a fresh capture; saving collected records can be retried without
                  one.
                </p>
                {#if hosted}
                  <div class="capture-options">
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={submitHistory}
                        disabled={importBusy || recovery || !capabilities.submission}
                        onchange={() => remember('gfl2.submit-history', String(submitHistory))}
                      /> Contribute to community statistics / Save server backup</label
                    >
                    <label class="check-control"
                      ><input
                        type="checkbox"
                        bind:checked={recovery}
                        disabled={importBusy || !capabilities.submission}
                      /> Recover a private server backup</label
                    >
                    {#if !capabilities.submission}
                      <p class="small">
                        Server history submission and recovery are unavailable. Browser imports
                        remain available; Drive sync is configured separately.
                      </p>
                    {/if}
                    {#if recovery}
                      <p class="small">
                        Verify your account with this capture to recover saved history. Recovery
                        does not submit new history.
                      </p>
                    {:else if submitHistory}
                      <p class="small">
                        Your capture is used in server memory and never saved. Saved history
                        contributes to aggregate statistics. Turning this off stops future
                        submissions; use Delete server history to remove existing server data.
                      </p>
                    {:else}
                      <p class="small">
                        The browser contacts official game servers directly. No capture or history
                        is sent to this tracker server. Turning this off does not delete previously
                        submitted history.
                      </p>
                    {/if}
                  </div>
                {/if}
              {/if}
              <button
                class="primary"
                onclick={() => runImport()}
                disabled={importBusy ||
                  !!retainedCollection ||
                  settingsBusy ||
                  inspecting ||
                  creating ||
                  (hosted &&
                    importMode === 'capture' &&
                    (recovery || submitHistory) &&
                    !publicConfig?.identity_verification.available)}
                ><LoadingLabel
                  busy={importBusy}
                  label={importMode === 'file'
                    ? 'Validate and import'
                    : recovery
                      ? 'Recover server backup'
                      : 'Fetch accessible history'}
                  loadingLabel="Working…"
                /></button
              >
              {@render importStatus()}
              {#if hosted && importMode === 'capture'}{#await import('$lib/components/ImportGuide.svelte') then guide}<guide.default
                  />{/await}{/if}
            </div>
          </div>
        </section>
      {/if}

      <section class="overview" aria-labelledby="overview-title">
        <div class="title-row">
          <h1 id="overview-title">Recruitment ledger</h1>
          <span class="local-label"><span></span>Local archive</span>
        </div>
        <LoadingRegion busy={loading && !stats} message="Loading recruitment summary…">
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
        </LoadingRegion>
        <EliteHistory
          query={rewardQuery}
          profileId={filters.profile_id}
          revision={archiveRevision}
        />
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
              ><LoadingLabel
                busy={loading}
                loadingLabel="Loading records…"
                label={error
                  ? 'Records unavailable'
                  : `${number(history.total)} records${active ? ' · filtered' : ''}`}
              /></span
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
        <LoadingRegion
          busy={loading}
          message={requestedPage ? `Loading page ${requestedPage}…` : 'Loading your archive…'}
        >
          {#if error}<div class="empty-state" role="alert">
              <h3>History could not load</h3>
              <p>{error}</p>
              <button onclick={() => (profiles.length ? refresh() : initialize())}>Try again</button
              >
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
              Pity is counted separately for each recruitment. A 5★ resets its counter; filters can
              hide that reward.
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
                            ><span><strong>Catalog region</strong>{row.region ?? 'Unknown'}</span
                            ><span
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
                  <span id="page-total" aria-label={`of ${history.pages} pages`}
                    >/ {history.pages}</span
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
        </LoadingRegion>
      </section>
    {/if}
  </LoadingRegion>
  {#if hosted && (section === 'about' || aboutVisited)}
    <div id="about-panel" hidden={section !== 'about'}>
      <AboutPanel config={data.feedback} />
    </div>
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
