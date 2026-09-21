// This script is injected before SvelteKit boots. Only external service boundaries
// are replaced; production routes, components, controllers and workers run normally.
(() => {
  'use strict';
  const origin = 'http://127.0.0.1:14195';
  if (location.origin !== origin) throw new Error('Routing fixture refused a non-test origin.');
  const RUN = 'gfl2.routing.run';
  if (location.pathname === '/__routing/reset') {
    localStorage.clear();
    const request = indexedDB.deleteDatabase('gfl2-pull-tracker');
    request.onsuccess = () => {
      const performanceRun = sessionStorage.getItem(RUN) === 'performance';
      sessionStorage.setItem(RUN, performanceRun ? 'performance' : 'yes');
      location.replace(performanceRun ? '/history?performance=1' : '/history');
    };
    request.onerror = () => { document.body.textContent = 'Could not reset fixture storage.'; };
    request.onblocked = () => { document.body.textContent = 'Close other routing-fixture tabs, then refresh.'; };
    return;
  }

  const originalFetch = window.fetch.bind(window);
  const historyMethods = new Set(['history', 'overview', 'statistics', 'filterOptions', 'profileSummary', 'summary', 'rewardHistory', 'rewards']);
  const workerQueries: string[] = [];
  type QueryTiming = { method: string; issued: number; completed?: number };
  const queryTimings: QueryTiming[] = [];
  const observedWorkers = new WeakMap<Worker, Map<number, QueryTiming>>();
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    const request = message as { method?: string; id?: number } | null;
    const method = request?.method;
    if (method && historyMethods.has(method)) {
      workerQueries.push(method);
      if (!observedWorkers.has(this)) {
        const pending = new Map<number, QueryTiming>();
        observedWorkers.set(this, pending);
        this.addEventListener('message', ({ data }) => {
          const timing = pending.get(data.id);
          if (timing) { timing.completed = performance.now(); pending.delete(data.id); }
        });
      }
      const timing = { method, issued: performance.now() };
      queryTimings.push(timing);
      observedWorkers.get(this)!.set(request!.id!, timing);
    }
    Reflect.apply(postMessage, this, transfer === undefined ? [message] : [message, transfer]);
  };
  let releaseConfig: (() => void) | undefined;
  // Only active runs stall configuration; interactive fixture browsing stays ordinary.
  const stallConfig = sessionStorage.getItem(RUN) === 'yes';
  type DriveMetadata = { description: string; appProperties: Record<string, string> };
  const cloud = new Map<string, { id: string; metadata: DriveMetadata; data: Uint8Array<ArrayBuffer> }>();
  const errors: string[] = [];
  const counts = { authorization: 0, game: 0, upload: 0 };
  let releaseAuthorization: (() => void) | undefined;
  let releaseCapture: (() => void) | undefined;
  let captureSignal: AbortSignal | null | undefined;
  let deferAuthorization = false, deferCapture = false, running = false;
  let deferDriveList = false, driveListings = 0;
  let releaseDriveList: (() => void) | undefined;
  type TokenOptions = { callback: (token: { access_token: string; expires_in: number; scope: string }) => void };
  const google = { accounts: { oauth2: { initTokenClient: (options: TokenOptions) => ({
    requestAccessToken() {
      counts.authorization++;
      const finish = () => options.callback({
        access_token: 'synthetic-routing-token', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.appdata'
      });
      if (deferAuthorization) releaseAuthorization = finish;
      else queueMicrotask(finish);
    }
  }) } } };
  Object.assign(window, { google });
  const json = (value: unknown) => Response.json(value);
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin === origin && url.pathname === '/api/public/config') {
      if (stallConfig) await new Promise<void>((resolve) => { releaseConfig = resolve; });
      return json({
      mode: 'public', csrf_token: 'synthetic-routing-csrf',
      features: { server_backup: false, community_contribution: false, relay_import: false },
      identity_verification: { available: false, reason: 'Routing fixture' }, accounts: [], limits: {}
      });
    }
    if (url.origin === origin && url.pathname === '/api/public/statistics') return json({
      minimum_contributors: 10, contributors: null, total: null, breakdowns: [],
      suppressed: true, coverage: 'accessible_history_only'
    });
    if (url.hostname === 'gf2-gacha-record-us.sunborngame.com') {
      counts.game++;
      if (deferCapture) {
        deferCapture = false;
        captureSignal = init.signal;
        await new Promise<void>((resolve, reject) => {
          releaseCapture = resolve;
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return json({ code: 0, data: {
        list: url.searchParams.get('type_id') === '1'
          ? [{ item: 1001, time: 1767268800, pool_id: 1, item_num: 1 }] : [], next: ''
      } });
    }
    if (url.hostname === 'www.googleapis.com') {
      if (init.method === 'DELETE' && url.pathname.startsWith('/drive/v3/files/')) {
        cloud.delete(url.pathname.split('/').pop() ?? '');
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/upload/drive/v3/files') {
        const blob = init.body;
        assert(blob instanceof Blob, 'Drive upload uses the production multipart Blob');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096)));
        const first = prefix.indexOf('\r\n\r\n') + 4;
        const end = prefix.indexOf('\r\n--', first);
        const metadata: DriveMetadata = JSON.parse(prefix.slice(first, end));
        const dataStart = prefix.indexOf('\r\n\r\n', end) + 4;
        const boundary = new Headers(init.headers).get('Content-Type')?.split('boundary=')[1];
        assert(boundary, 'Drive upload declares its multipart boundary');
        const data = bytes.slice(dataStart, bytes.length - new TextEncoder().encode(`\r\n--${boundary}--`).length);
        const id = `fixture-${++counts.upload}`;
        cloud.set(id, { id, metadata, data });
        return json({ id, version: '1', size: String(data.length) });
      }
      if (url.searchParams.get('alt') === 'media') {
        const item = cloud.get(url.pathname.split('/').pop() ?? '');
        if (!item) throw new Error('Unknown synthetic Drive revision');
        return new Response(item.data);
      }
      if (url.pathname === '/drive/v3/files') {
        driveListings++;
        if (deferDriveList) {
          deferDriveList = false;
          await new Promise<void>((resolve) => { releaseDriveList = resolve; });
        }
        return json({ files: [...cloud.values()].map(({ id, metadata, data }) => ({
          id, version: '1', size: String(data.length), description: metadata.description, appProperties: metadata.appProperties
        })) });
      }
      throw new Error(`Unexpected synthetic Drive request: ${url.pathname}`);
    }
    if (url.origin !== origin) throw new Error(`Fixture blocked unexpected external request: ${url.origin}`);
    return originalFetch(input, init);
  };
  window.addEventListener('error', (value) => {
    if (running) errors.push(value.message);
  });
  window.addEventListener('unhandledrejection', (value) => {
    if (running) errors.push(String(value.reason));
  });
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  async function until(check: () => unknown, description: string) {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (errors.length) throw new Error(errors.join('\n'));
      if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
      await wait(30);
    }
    await wait(40);
  }
  function required<T extends Element>(element: T | null | undefined, description: string): T {
    assert(element, `Missing ${description}`);
    return element;
  }
  const main = () => required(document.querySelector('main'), 'main region');
  const activeProfile = () => required(document.querySelector<HTMLSelectElement>('select[aria-label="Active profile"]'), 'active profile');
  const findButton = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);
  function clickButton(label: string, scope: ParentNode = document) {
    const button = findButton(label, scope);
    assert(button && !button.matches(':disabled'), `Enabled button missing: ${label}`);
    button.click();
  }
  function input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string) {
    assert(element, 'Input is present');
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const search = () => required(document.querySelector<HTMLInputElement>('input[type="search"]'), 'history search');
  type Slug = 'history' | 'backup' | 'profiles' | 'statistics' | 'privacy';
  async function navigate(slug: Slug) {
    const link = document.querySelector<HTMLAnchorElement>(`.archive-nav a[href="/${slug}"]`);
    assert(link, `Ordinary navigation link /${slug}`);
    link.click();
    await until(() => location.pathname === `/${slug}` && link.getAttribute('aria-current') === 'page', `navigate ${slug}`);
    assert(document.querySelectorAll('.archive-nav [aria-current="page"]').length === 1, 'One current page');
    const title = { history: 'Recruitment ledger', backup: 'Backup & sync', profiles: 'Profiles', statistics: 'Community statistics', privacy: 'Privacy & recovery' }[slug];
    assert(document.title.includes(title), `Page title matches ${slug}`);
  }

  async function run(log: (message: string) => void) {
    running = true;
    await until(() => activeProfile() && document.querySelector('.archive-nav a') && !main().querySelector('[aria-busy="true"]'), 'application initialized');
    assert(releaseConfig, 'Optional configuration is still pending');
    assert(document.querySelector('#history-title'), 'History rendered before configuration completed');
    releaseConfig();
    log('PASS usable browser history while optional configuration is stalled');
    await navigate('profiles');
    for (const name of ['Routing primary', 'Routing secondary']) {
      input(document.querySelector<HTMLInputElement>('input[placeholder="For example, Europe account"]'), name);
      await until(() => findButton('Create profile', main())?.matches(':enabled'), 'create enabled');
      clickButton('Create profile', main());
      await until(() => [...activeProfile().options].some((option) => option.text === name) && !activeProfile().disabled, 'profile created');
    }
    const primary = required([...activeProfile().options].find((option) => option.text === 'Routing primary'), 'primary profile option').value;
    input(activeProfile(), primary);
    await navigate('history');
    input(search(), '1001');
    await wait(250);
    for (const slug of ['backup', 'statistics', 'privacy', 'history'] as const) await navigate(slug);
    assert(activeProfile().value === primary && search().value === '1001', 'Profile and filter retained');
    log('PASS route links, titles, current page, retained profile and filter');
    await navigate('backup');
    await wait(250);
    const previousQueries = workerQueries.length;
    for (const slug of ['profiles', 'statistics', 'privacy', 'backup'] as const) await navigate(slug);
    await wait(250);
    assert(workerQueries.length === previousQueries,
      `Non-history routes issued archive queries: ${workerQueries.slice(previousQueries).join(', ')}`);
    log('PASS unrelated routes issue no archive history, reward, summary, or filter queries');

    await navigate('profiles');
    await navigate('backup');
    history.back();
    await until(() => location.pathname === '/profiles', 'Back');
    history.forward();
    await until(() => location.pathname === '/backup', 'Forward');
    log('PASS browser Back and Forward');

    deferAuthorization = true;
    clickButton('Connect Google Drive');
    await until(() => releaseAuthorization, 'deferred Google authorization');
    await navigate('history');
    assert(activeProfile().disabled, 'Settings operation retains profile lock after unmount');
    await navigate('profiles');
    assert(document.querySelector<HTMLFieldSetElement>('fieldset.settings')?.disabled, 'Settings mutations stay locked');
    assert(releaseAuthorization, 'Synthetic authorization is pending');
    releaseAuthorization();
    await until(() => !activeProfile().disabled, 'settings operation finishes');
    await navigate('backup');
    await until(() => findButton('Disconnect') && counts.upload > 0, 'Drive connected and uploaded');
    await navigate('history');
    await navigate('backup');
    assert(findButton('Disconnect') && counts.authorization === 1, 'Drive authorization retained');
    log('PASS deferred settings lock and retained Drive session using synthetic transport');

    await navigate('history');
    if (!document.querySelector('#import-panel')) clickButton('Import history');
    await until(() => document.querySelector('#import-panel'), 'import panel opens');
    clickButton('Captured request');
    await until(() => document.querySelector('textarea'), 'capture input rendered');
    input(document.querySelector('textarea'), 'POST https://gf2-gacha-record-us.sunborngame.com/list?u=synthetic-routing-account&game_channel_id=1&type_id=1 HTTP/1.1\r\nHost: gf2-gacha-record-us.sunborngame.com\r\nAuthorization: synthetic-routing-credential\r\nContent-Length: 8\r\n\r\nserver=1');
    deferCapture = true;
    await until(() => findButton('Fetch accessible history')?.matches(':enabled'), 'capture submission enabled');
    clickButton('Fetch accessible history');
    await until(() => releaseCapture, 'capture request held');
    for (const slug of ['backup', 'statistics', 'privacy', 'history'] as const) {
      await navigate(slug);
      assert(activeProfile().disabled, 'Import operation retains profile lock');
      assert(captureSignal && !captureSignal.aborted, 'Capture survives route navigation');
      assert(document.querySelector('progress[aria-label="Import in progress"]'), 'Import progress remains visible');
    }
    assert(releaseCapture, 'Synthetic capture is pending');
    releaseCapture();
    await until(() => main().textContent?.includes('Import complete') && !activeProfile().disabled, 'synthetic import completes');
    assert(counts.game === 11, 'Single collection loop performed expected official-type requests');
    clickButton('View history');
    await until(() => document.activeElement?.id === 'history-title', 'View history focus');
    assert(main().textContent?.includes('1001'), 'Production worker saved synthetic record');
    log('PASS live import across routes, production worker save, and history focus');

    await navigate('backup');
    let backup: Blob | undefined;
    const createObjectURL = URL.createObjectURL;
    const anchorClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { if (blob instanceof Blob) backup = blob; return createObjectURL(blob); };
    HTMLAnchorElement.prototype.click = function () { if (!this.download) anchorClick.call(this); };
    try {
      clickButton('Export all profiles');
      await until(() => backup && !activeProfile().disabled, 'production backup export');
    } finally {
      URL.createObjectURL = createObjectURL;
      HTMLAnchorElement.prototype.click = anchorClick;
    }
    await navigate('history');
    if (!document.querySelector('#import-panel')) clickButton('Import history');
    await until(() => document.querySelector('#import-panel'), 'import panel reopens');
    clickButton('Saved export');
    await until(() => document.querySelector('input[type="file"][accept*=".json"]'), 'file input rendered');
    const fileInput = required(document.querySelector<HTMLInputElement>('input[type="file"][accept*=".json"]'), 'import file input');
    const files = new DataTransfer();
    assert(backup, 'Production backup was downloaded');
    files.items.add(new File([backup], 'routing-production-backup.json.gz', { type: 'application/gzip' }));
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => location.pathname === '/backup' && document.activeElement?.id === 'restore-heading', 'backup handoff focus');
    assert(main().textContent?.includes('Selected backup:') && main().textContent?.includes('routing-production-backup.json.gz'), 'File object survives route transition');
    clickButton('Merge archive');
    await until(() => main().textContent?.includes('Archive merged.') && !activeProfile().disabled, 'real gzip restore finishes');
    await wait(100);
    assert(errors.length === 0, 'No browser runtime errors');
    log('PASS production gzip export, cross-route file handoff, restore focus and merge');
    running = false;
  }

  const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  async function rendered(check: () => unknown, description: string) {
    const deadline = performance.now() + 30_000;
    let stableFrames = 0;
    while (stableFrames < 2) {
      if (errors.length) throw new Error(errors.join('\n'));
      if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
      await frame();
      stableFrames = check() ? stableFrames + 1 : 0;
    }
    // Two animation frames allow a paint opportunity after Svelte commits.
    // This is an observable next-paint estimate, not a hardware presentation timestamp.
  }
  const historySettled = () => !!document.querySelector('#history-title') &&
    !document.querySelector('.elite-overview[aria-busy="true"]') &&
    !document.querySelector('.history-title')?.textContent?.includes('Loading records');
  type Interaction = { action: string; eventToPaintMs: number; queryDispatchDelayMs: number | null;
    afterQueryDispatchMs: number | null; mutations: number; duringHeldDriveSync: boolean };
  async function interaction(action: string, invoke: () => void, check: () => unknown, method?: string): Promise<Interaction> {
    const first = queryTimings.length;
    let mutations = 0;
    const observer = new MutationObserver((entries) => { mutations += entries.length; });
    observer.observe(main(), { subtree: true, childList: true, characterData: true, attributes: true });
    const start = performance.now();
    const duringHeldDriveSync = !!releaseDriveList;
    try {
      invoke();
      await rendered(() => {
        const queries = queryTimings.slice(first);
        return (!method || queries.some((query) => query.method === method)) &&
          queries.every((query) => query.completed !== undefined) && check();
      }, action);
      const end = performance.now();
      const firstQuery = queryTimings.slice(first).find((query) => !method || query.method === method);
      const rounded = (value: number) => Math.round(value * 100) / 100;
      return { action, eventToPaintMs: rounded(end - start),
        queryDispatchDelayMs: firstQuery ? rounded(firstQuery.issued - start) : null,
        afterQueryDispatchMs: firstQuery ? rounded(end - firstQuery.issued) : null,
        mutations, duringHeldDriveSync };
    } finally { observer.disconnect(); }
  }
  function syntheticExport(count: number, account: number, start = 0) {
    return new File([JSON.stringify({ schema_version: 1, exported_at: '2026-09-20T12:00:00Z',
      account_fingerprint: `sha256:${String(account + 1).repeat(64)}`,
      endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
      records: Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        return { source_type_id: index % 2 ? 3 : 6, source_page: Math.floor(offset / 20) + 1,
          record: { item: index % 10 === 0 ? 1013 : index % 2 ? 11007 : 11008,
            pool_id: index % 2 ? 224001 : 224002, item_num: 1, time: 1784800558 + index } };
      }) })], 'records.json', { type: 'application/json' });
  }
  async function importSynthetic(file: File) {
    if (!document.querySelector('#import-panel')) clickButton('Import history');
    await rendered(() => document.querySelector('#import-panel'), 'open file import');
    clickButton('Saved export');
    await rendered(() => document.querySelector('input[type="file"][accept*=".json"]'), 'file import input');
    const element = required(document.querySelector<HTMLInputElement>('input[type="file"][accept*=".json"]'), 'file import input');
    const files = new DataTransfer(); files.items.add(file); element.files = files.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await rendered(() => main().textContent?.includes('1 file selected') && findButton('Validate and import')?.matches(':enabled'), 'file validated');
    const first = queryTimings.length;
    const start = performance.now();
    clickButton('Validate and import');
    await rendered(() => queryTimings.length > first && historySettled() && !activeProfile().disabled &&
      main().textContent?.includes('Import complete'), 'synthetic file imported');
    const ms = Math.round((performance.now() - start) * 100) / 100;
    clickButton('View history');
    await rendered(() => document.activeElement?.id === 'history-title', 'history focused after import');
    return ms;
  }
  async function runPerformance(log: (message: string) => void) {
    running = true;
    const startup = performance.now();
    await rendered(() => document.querySelector('select[aria-label="Active profile"]') && historySettled(), 'performance app initialized');
    log(JSON.stringify({ reference: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: { width: innerWidth, height: innerHeight }, startupFromHarnessMs: Math.round(performance.now() - startup),
      navigationToInitialHistoryPaintMs: Math.round(performance.now()),
      method: 'Actual production UI file imports and DOM interactions; animation-frame paint opportunities; synthetic Drive only' }));
    const profiles: { id: string; records: number; importMs: number[] }[] = [];
    for (const [account, count] of [1000, 10000, 30000].entries()) {
      await navigate('profiles');
      const name = `Performance ${count}`;
      input(document.querySelector<HTMLInputElement>('input[placeholder="For example, Europe account"]'), name);
      await rendered(() => findButton('Create profile', main())?.matches(':enabled'), 'profile creation enabled');
      clickButton('Create profile', main());
      await rendered(() => [...activeProfile().options].some((option) => option.text === name) && !activeProfile().disabled, 'performance profile created');
      const id = required([...activeProfile().options].find((option) => option.text === name), 'performance profile').value;
      input(activeProfile(), id);
      await navigate('history');
      const importMs = [await importSynthetic(syntheticExport(count, account))];
      importMs.push(await importSynthetic(syntheticExport(count / 2, account, count / 2)));
      assert(document.querySelector('.history-title')?.textContent?.includes(`${count.toLocaleString()} records`), 'Overlapping file imports preserve exact occurrences');
      profiles.push({ id, records: count, importMs });
      log(`Seeded ${count} records through production file imports: ${JSON.stringify(importMs)} ms`);
    }
    await navigate('backup');
    clickButton('Connect Google Drive');
    await rendered(() => findButton('Disconnect') && findButton('Sync now')?.matches(':enabled') && counts.upload > 0,
      'synthetic Drive initially synced');
    await navigate('history');
    const reports: unknown[] = [];
    const tasks: { start: number; duration: number }[] = [];
    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask') ? new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }) : null;
    observer?.observe({ type: 'longtask' });
    try {
      for (const profile of profiles) {
        if (activeProfile().value !== profile.id) {
          await interaction('initial profile selection', () => input(activeProfile(), profile.id), historySettled, 'history');
        }
        // The normal focus listener starts background sync without a settings-panel
        // operation lock. Hold only its synthetic metadata response during browsing.
        deferDriveList = true;
        window.dispatchEvent(new Event('focus'));
        await rendered(() => releaseDriveList, 'background Drive sync started');
        const runStart = performance.now();
        const timings: Interaction[] = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          timings.push(await interaction('pagination', () => clickButton('Next'), historySettled, 'history'));
          const query = repeat % 2 ? '11007' : '1013';
          timings.push(await interaction('search (includes intentional 100 ms debounce)', () => input(search(), query), historySettled, 'history'));
          await interaction('clear search', () => input(search(), ''), historySettled, 'history');
          const recruitment = required(document.querySelector<HTMLSelectElement>('.recruitment-select select'), 'recruitment selection');
          const next = required([...recruitment.options].find((option) => option.value !== recruitment.value), 'other recruitment');
          timings.push(await interaction('recruitment', () => input(recruitment, next.value), historySettled, 'rewards'));
          const other = profiles[(profiles.indexOf(profile) + 1) % profiles.length];
          timings.push(await interaction('profile switch away', () => input(activeProfile(), other.id), historySettled, 'history'));
          timings.push(await interaction('profile switch back', () => input(activeProfile(), profile.id), historySettled, 'history'));
          const backup = required(document.querySelector<HTMLAnchorElement>('.archive-nav a[href="/backup"]'), 'backup link');
          timings.push(await interaction('navigate backup', () => backup.click(), () => location.pathname === '/backup' && findButton('Disconnect')));
          const historyLink = required(document.querySelector<HTMLAnchorElement>('.archive-nav a[href="/history"]'), 'history link');
          timings.push(await interaction('navigate history', () => historyLink.click(), () => location.pathname === '/history' && historySettled()));
        }
        assert(releaseDriveList, 'Background sync remains pending throughout measured browsing');
        releaseDriveList(); releaseDriveList = undefined;
        await rendered(() => queryTimings.every((query) => query.completed !== undefined) && historySettled(), 'browsing settled');
        const sorted = timings.filter((timing) => !timing.action.startsWith('search')).map((timing) => timing.eventToPaintMs).sort((a, b) => a - b);
        const report = { records: profile.records, importsMs: profile.importMs, timings,
          nonSearchP95Ms: sorted[Math.ceil(sorted.length * .95) - 1], nonSearchMaxMs: Math.max(...sorted),
          warmTargetMet: sorted.every((ms) => ms < 200), longTasks: tasks.filter((task) => task.start >= runStart),
          driveListings, syntheticUploads: counts.upload };
        reports.push(report); log(JSON.stringify(report));
      }
      Object.assign(window, { routingPerformanceResults: reports });
      assert(errors.length === 0, errors.join('\n'));
      log('PASS DOM performance scenarios; inspect warmTargetMet and search debounce timings');
    } finally {
      releaseDriveList?.(); releaseDriveList = undefined; deferDriveList = false;
      observer?.disconnect(); running = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('aside');
    panel.id = 'routing-fixture';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;max-width:560px;max-height:45vh;overflow:auto;padding:12px;background:#111;color:#fff;border:2px solid #c33;font:13px monospace';
    const button = document.createElement('button');
    button.textContent = 'Run tests';
    const results = document.createElement('pre');
    results.style.whiteSpace = 'pre-wrap';
    results.textContent = 'Isolated routing fixture. Run tests resets only this origin’s synthetic archive.';
    button.onclick = () => location.assign('/__routing/reset');
    const performanceButton = document.createElement('button');
    performanceButton.textContent = 'Run DOM performance';
    performanceButton.onclick = () => { sessionStorage.setItem(RUN, 'performance'); location.assign('/__routing/reset'); };
    panel.append(button, performanceButton, results);
    document.body.append(panel);
    if (new URLSearchParams(location.search).get('performance') === '1' && sessionStorage.getItem(RUN) !== 'performance') {
      performanceButton.click(); return;
    }
    if (sessionStorage.getItem(RUN) === 'performance') {
      sessionStorage.removeItem(RUN);
      button.disabled = true; performanceButton.disabled = true;
      results.textContent = 'Running production DOM performance scenarios…\n';
      runPerformance((message) => { results.textContent += `${message}\n`; }).then(() => {
        panel.dataset.result = 'pass';
      }, (error) => {
        results.textContent += `FAIL ${error.stack || error}\n`; panel.dataset.result = 'fail'; running = false;
      }).finally(() => { button.disabled = false; performanceButton.disabled = false; });
      return;
    }
    if (sessionStorage.getItem(RUN) === 'yes') {
      sessionStorage.removeItem(RUN);
      button.disabled = true;
      results.textContent = 'Running actual SvelteKit browser routing checks…\n';
      run((message) => { results.textContent += `${message}\n`; }).then(() => {
        results.textContent += 'PASS all routing checks\n';
        panel.dataset.result = 'pass';
      }, (error) => {
        results.textContent += `FAIL ${error.stack || error}\n`;
        panel.dataset.result = 'fail';
        running = false;
      }).finally(() => { button.disabled = false; });
    }
  });
})();
