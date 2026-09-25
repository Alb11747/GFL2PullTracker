// This script is injected before SvelteKit boots. Only external service boundaries
// are replaced; production routes, components, controllers and workers run normally.
(() => {
  'use strict';
  const origin = 'http://127.0.0.1:14195';
  if (location.origin !== origin) throw new Error('Routing fixture refused a non-test origin.');
  // The routing fixture exercises voluntary feedback while automatic telemetry stays off.
  localStorage.setItem('gfl2.telemetry.enabled', '0');
  const submissionFixture = new URLSearchParams(location.search).has('submission');
  const submissionReload = sessionStorage.getItem('gfl2.routing.submission-optout') === 'yes';
  if (submissionFixture && !submissionReload) localStorage.removeItem('gfl2.submit-history');
  // A separate direct-entry run proves feedback remains reachable when the archive fails.
  if (location.pathname === '/about' && new URLSearchParams(location.search).has('archive-failure')) {
    let attempted = false;
    window.Worker = new Proxy(window.Worker, {
      construct() {
        attempted = true;
        throw new DOMException('Synthetic archive unavailable', 'InvalidStateError');
      }
    });
    document.addEventListener('DOMContentLoaded', () => {
      const result = document.createElement('aside');
      result.id = 'routing-fixture';
      result.textContent = 'Checking About with unavailable browser storage…';
      document.body.append(result);
      const deadline = Date.now() + 15000;
      const check = () => {
        const about = document.querySelector<HTMLElement>('#about-panel');
        if (attempted && about && !about.hidden && about.textContent?.includes('About')) {
          result.dataset.result = 'pass';
          result.textContent = 'PASS direct About entry remains usable after archive failure';
        } else if (Date.now() > deadline) {
          result.dataset.result = 'fail';
          result.textContent = 'FAIL About unavailable after archive failure';
        } else setTimeout(check, 50);
      };
      check();
    });
    return;
  }
  const RUN = 'gfl2.routing.run';
  if (location.pathname === '/__routing/reset') {
    localStorage.clear();
    const request = indexedDB.deleteDatabase('gfl2-pull-tracker-stable');
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
  const archiveReadMethods = new Set([...historyMethods, 'statisticsSummary']);
  const workerQueries: string[] = [];
  type QueryTiming = { method: string; issued: number; completed?: number;
    queueMs?: number; executionMs?: number; receivedAt?: number;
    startedAt?: number; finishedAt?: number; errorName?: string };
  const queryTimings: QueryTiming[] = [];
  const observedWorkers = new WeakMap<Worker, Map<number, QueryTiming>>();
  const postMessage = Worker.prototype.postMessage;
  let archiveWorker: Worker | undefined;
  let diagnosticId = 0;
  Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    const request = message as { method?: string; id?: number; args?: unknown[] } | null;
    const method = request?.method;
    // The probability worker also has a `summary` method; only archive messages
    // carry positional args. Do not mistake model work for a ledger query.
    if (method && Array.isArray(request?.args) && (archiveReadMethods.has(method) || method === 'exportBackup' || method === 'diagnostics')) {
      if (archiveReadMethods.has(method)) workerQueries.push(method);
      archiveWorker = this;
      if (!observedWorkers.has(this)) {
        const pending = new Map<number, QueryTiming>();
        observedWorkers.set(this, pending);
        this.addEventListener('message', ({ data }) => {
          const timing = pending.get(data.id);
          if (timing) {
            timing.completed = performance.now();
            timing.queueMs = data.timing?.queueMs;
            timing.executionMs = data.timing?.executionMs;
            timing.receivedAt = data.timing?.receivedAt;
            timing.startedAt = data.timing?.startedAt;
            timing.finishedAt = data.timing?.finishedAt;
            timing.errorName = data.errorName;
            pending.delete(data.id);
          }
        });
      }
      const timing = { method, issued: performance.now() };
      queryTimings.push(timing);
      observedWorkers.get(this)!.set(request!.id!, timing);
    }
    Reflect.apply(postMessage, this, transfer === undefined ? [message] : [message, transfer]);
  };
  // Exercise the same production worker without exposing app internals. Negative
  // fixture IDs cannot collide with the client's positive request sequence.
  function archiveCall<T>(method: string, ...args: unknown[]): Promise<T> {
    assert(archiveWorker, 'Production archive worker has been observed');
    const worker = archiveWorker;
    return new Promise((resolve, reject) => {
      const id = --diagnosticId;
      const listener = ({ data }: MessageEvent) => {
        if (data.id !== id) return;
        worker.removeEventListener('message', listener);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result as T);
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ id, method, args });
    });
  }
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
  const submissionRequests: string[] = [];
  type ComparisonInput = import('../../src/lib/public-api').CommunityComparisonInput;
  const comparisons: { body: ComparisonInput; signal: AbortSignal | null | undefined }[] = [];
  let holdComparison = false;
  let releaseComparison: (() => void) | undefined;
  let comparisonStatus: 'ok' | 'insufficient_cohort' | 'privacy_suppressed' = 'ok';
  let comparisonContributors = 64;
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin === origin && url.pathname === '/api/public/config') {
      if (stallConfig) await new Promise<void>((resolve) => { releaseConfig = resolve; });
      return json({
      mode: 'public', csrf_token: 'synthetic-routing-csrf',
      features: { submit_history: submissionFixture, relay_import: false },
      identity_verification: { available: submissionFixture, reason: submissionFixture ? null : 'Routing fixture' }, accounts: [], limits: {}
      });
    }
    if (submissionFixture && url.origin === origin && ['/api/public/verify', '/api/public/backup', '/api/public/fetch'].includes(url.pathname)) {
      submissionRequests.push(url.pathname);
      if (url.pathname.endsWith('/verify')) return json({ account_id: 'account', history_version: 0,
        identity: { uid: '12345', account_fingerprint: 'synthetic', endpoint_host: 'gf2-gacha-record-us.sunborngame.com', server: '1', game_channel_id: '1' } });
      if (url.pathname.endsWith('/backup')) return json({ account_id: 'account', name: 'Recovered', snapshots: [] });
      throw new Error('Recovery must never submit a server fetch');
    }
    if (url.origin === origin && url.pathname === '/api/public/statistics/compare') {
      assert(init.method === 'POST', 'Community comparison uses the production POST boundary');
      const body: ComparisonInput = JSON.parse(String(init.body));
      const allowed = new Set([
        'endpoint_host',
        'server',
        'game_channel_id',
        'type_id',
        'rules_version',
        'elite',
        'featured',
        'wins',
        'exclude_account_id'
      ]);
      assert(
        Object.keys(body).every((key) => allowed.has(key)),
        'Comparison sends only aggregate windows and cohort selectors'
      );
      for (const key of ['elite', 'featured'] as const) {
        const window = body[key];
        assert(
          window === null ||
            Object.keys(window).every((field) =>
              ['budget', 'count', 'startingPity', 'guaranteed'].includes(field)
            ),
          'Comparison window contains no raw pull data'
        );
      }
      assert(
        !JSON.stringify(body).includes('sha256:'),
        'Comparison does not send a local account fingerprint'
      );
      comparisons.push({ body, signal: init.signal });
      const status = comparisonStatus,
        contributors = comparisonContributors;
      if (holdComparison) {
        holdComparison = false;
        // Deliberately allow a late reply after abort, proving the UI also guards
        // its selected context when a transport cannot stop an in-flight reply.
        await new Promise<void>((resolve) => {
          releaseComparison = resolve;
        });
      }
      const metric = {
        status,
        contributors: status === 'privacy_suppressed' ? null : contributors,
        better_or_equal: status === 'ok' ? 16 : null,
        percentage: status === 'ok' && contributors >= 50 ? 0.25 : null
      };
      return json({
        rules_version: body.rules_version,
        self_excluded: false,
        metrics: { elite: metric, featured: metric, wins: metric }
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
  const visibleText = (element: Element | null | undefined) => {
    if (!element) return '';
    const content = element.cloneNode(true) as HTMLElement;
    content.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return content.textContent?.trim() ?? '';
  };
  const findButton = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((button) =>
    button.getAttribute('aria-label') === label || visibleText(button) === label);
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
  type Slug = 'history' | 'backup' | 'profiles' | 'statistics' | 'privacy' | 'about';
  async function navigate(slug: Slug) {
    const link = document.querySelector<HTMLAnchorElement>(`.archive-nav a[href="/${slug}"]`);
    assert(link, `Ordinary navigation link /${slug}`);
    link.click();
    await until(() => location.pathname === `/${slug}` && link.getAttribute('aria-current') === 'page', `navigate ${slug}`);
    assert(document.querySelectorAll('.archive-nav [aria-current="page"]').length === 1, 'One current page');
    const title = { history: 'Recruitment ledger', backup: 'Backup & sync', profiles: 'Profiles', statistics: 'Statistics', privacy: 'Privacy & recovery', about: 'About' }[slug];
    assert(document.title.includes(title), `Page title matches ${slug}`);
  }

  function watchLoadingRegions() {
    const states = new WeakMap<HTMLElement, { height: number; width: number; busy: boolean; floor: number }>();
    const failures = new Set<string>();
    const regions = new Set<string>();
    let samples = 0, animation = 0, stopped = false;
    const sample = () => {
      for (const region of document.querySelectorAll<HTMLElement>('.loading-region')) {
        const rect = region.getBoundingClientRect();
        // Concealed ancestor panels are not painted; their dimensions can
        // change as the route unmounts without representing a loading shift.
        if (!region.getClientRects().length || getComputedStyle(region).visibility === 'hidden') continue;
        const busy = region.getAttribute('aria-busy') === 'true';
        const previous = states.get(region);
        const widthChanged = previous && Math.abs(previous.width - rect.width) > 1;
        const floor = busy && previous && !widthChanged
          ? previous.busy ? previous.floor : previous.height : 0;
        if (busy) {
          const message = region.querySelector<HTMLElement>(':scope > .region-message');
          const messageHeight = message?.getBoundingClientRect().height ?? 0;
          const label = message?.textContent?.trim() || region.parentElement?.className || 'progress';
          regions.add(label); samples++;
          const expected = Math.max(floor, messageHeight);
          if (rect.height + 1 < expected) failures.add(`${label}: ${rect.height.toFixed(2)}px < ${expected.toFixed(2)}px`);
          if (message && message.scrollWidth > message.clientWidth + 1) failures.add(`${label}: loading message overflows`);
        }
        states.set(region, { height: rect.height, width: rect.width, busy, floor });
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    const next = () => { if (!stopped) { sample(); animation = requestAnimationFrame(next); } };
    next();
    const stop = () => { stopped = true; observer.disconnect(); cancelAnimationFrame(animation); };
    return { stop, finish() {
      sample(); stop();
      assert(samples > 0, 'Loading audit observed no production loading regions');
      assert(!failures.size, `Loading regions collapsed or clipped: ${[...failures].join('; ')}`);
      return { samples, regions: [...regions], toleranceCssPx: 1 };
    } };
  }
  let loadingAudit: ReturnType<typeof watchLoadingRegions> | undefined;

  async function runSubmission(log: (message: string) => void) {
    await until(() => document.querySelector('.archive-nav a') && !main().querySelector('[aria-busy="true"]'), 'application initialized');
    const links = [...document.querySelectorAll('.archive-nav a')];
    assert(links[0].textContent?.trim() === 'History' && links[1].textContent?.trim() === 'Statistics', 'Statistics immediately follows History');
    if (!submissionReload || !activeProfile().value) {
      await navigate('profiles');
      const profileName = `Submission fixture ${Date.now()}`;
      input(document.querySelector<HTMLInputElement>('input[placeholder="For example, Europe account"]'), profileName);
      await until(() => findButton('Create profile', main())?.matches(':enabled'), 'submission profile creation enabled');
      clickButton('Create profile', main());
      await until(() => [...activeProfile().options].some((option) => option.text === profileName) && !activeProfile().disabled, 'dedicated empty profile created');
      const profile = required([...activeProfile().options].find((option) => option.text === profileName), 'dedicated submission profile');
      input(activeProfile(), profile.value);
      await navigate('history');
    }
    if (!document.querySelector('#import-panel')) clickButton('Import history');
    await until(() => document.querySelector('#import-panel'), 'import panel opens');
    clickButton('Captured request');
    await until(() => document.querySelectorAll('.capture-options input').length === 2, 'combined controls rendered');
    const [submission, recovery] = [...document.querySelectorAll<HTMLInputElement>('.capture-options input')];
    assert(submission.closest('label')?.textContent?.trim() === 'Contribute to community statistics / Save server backup', 'Exact combined label');
    assert(recovery.closest('label')?.textContent?.trim() === 'Recover a private server backup', 'Recovery comes second');
    assert(!recovery.checked, 'Recovery defaults off');
    if (submissionReload) {
      assert(!submission.checked, 'Explicit opt-out survives reload');
      sessionStorage.removeItem('gfl2.routing.submission-optout');
      log('PASS default-on submission, exclusive recovery without fetch/save, persistent explicit opt-out, and Statistics navigation');
      return;
    }
    assert(submission.checked && !submission.disabled, 'Available submission defaults on');
    recovery.click(); await wait(50);
    assert(submission.disabled, 'Recovery excludes new submission');
    input(document.querySelector('textarea'), 'POST https://gf2-gacha-record-us.sunborngame.com/list?u=synthetic-routing-account&game_channel_id=1&type_id=1 HTTP/1.1\r\nHost: gf2-gacha-record-us.sunborngame.com\r\nAuthorization: synthetic-routing-credential\r\nContent-Length: 8\r\n\r\nserver=1');
    clickButton('Recover server backup');
    await until(() => document.body.textContent?.includes('Server backup recovered:'), 'recovery completed');
    assert(submissionRequests.join(',') === '/api/public/verify,/api/public/backup', 'Recovery verifies and reads without submitting');
    recovery.click(); await wait(50); submission.click(); await wait(50);
    assert(localStorage.getItem('gfl2.submit-history') === 'false', 'Explicit opt-out persisted');
    sessionStorage.setItem('gfl2.routing.submission-optout', 'yes');
    location.assign('/history?submission=1');
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
    for (const slug of ['backup', 'statistics', 'privacy', 'about', 'history'] as const) await navigate(slug);
    assert(activeProfile().value === primary && search().value === '1001', 'Profile and filter retained');
    log('PASS route links, titles, current page, retained profile and filter');
    await navigate('backup');
    await wait(250);
    const previousQueries = workerQueries.length;
    for (const slug of ['profiles', 'statistics', 'privacy', 'about', 'backup'] as const) await navigate(slug);
    await wait(250);
    const unrelatedQueries = workerQueries.slice(previousQueries);
    assert(
      unrelatedQueries.every((method) => method === 'statisticsSummary'),
      `Non-history routes issued ledger queries: ${unrelatedQueries.join(', ')}`
    );
    log(
      'PASS unrelated routes issue no ledger/reward/filter queries; Statistics uses its aggregate query'
    );

    await navigate('about');
    const feedbackDraft = required(document.querySelector<HTMLTextAreaElement>('#feedback-message'), 'feedback draft');
    input(feedbackDraft, 'Routing draft retained in memory');
    await navigate('backup');
    history.back();
    await until(() => location.pathname === '/about', 'Back');
    assert(document.querySelector<HTMLTextAreaElement>('#feedback-message')?.value === 'Routing draft retained in memory', 'About draft survives tracker navigation');
    history.forward();
    await until(() => location.pathname === '/backup', 'Forward');
    log('PASS browser Back and Forward');

    deferAuthorization = true;
    clickButton('Connect Google Drive');
    await until(() => releaseAuthorization, 'deferred Google authorization');
    await navigate('history');
    await until(() => !activeProfile().disabled, 'navigation cancels sign-in and releases profile lock');
    await navigate('profiles');
    assert(!document.querySelector<HTMLFieldSetElement>('fieldset.settings')?.disabled, 'Cancelled sign-in unlocks settings mutations');
    assert(releaseAuthorization, 'Synthetic authorization is pending');
    releaseAuthorization();
    await navigate('backup');
    assert(findButton('Connect Google Drive') && counts.upload === 0, 'Late authorization cannot reconnect or upload');
    deferAuthorization = false;
    clickButton('Connect Google Drive');
    await until(() => findButton('Disconnect') && counts.upload > 0, 'Drive connected and uploaded');
    await navigate('history');
    await navigate('backup');
    assert(findButton('Disconnect') && counts.authorization === 2, 'Fresh Drive authorization retained');
    log('PASS cancelled sign-in unlocks routes, ignores late callbacks, and permits a retained fresh Drive session');

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
    for (const slug of ['backup', 'statistics', 'privacy', 'about', 'history'] as const) {
      await navigate(slug);
      assert(activeProfile().disabled, 'Import operation retains profile lock');
      assert(captureSignal && !captureSignal.aborted, 'Capture survives route navigation');
      const progress = document.querySelector<HTMLElement>('.import-result [role="status"]');
      assert(progress?.textContent?.includes('Import in progress') &&
        getComputedStyle(progress).visibility === 'visible' &&
        progress.closest('.loading-region')?.getAttribute('aria-busy') === 'true',
        'Visible text import progress remains busy across navigation');
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
    const importContext = { navigate, archiveCall, until, log, clickButton, input,
      activeProfile, findButton, main,
      driveListCount: () => driveListings,
      async holdDrivePass() {
        deferDriveList = true;
        releaseDriveList = undefined;
        window.dispatchEvent(new Event('focus'));
        await until(() => releaseDriveList, 'background Drive pass held for import cancellation');
        const release = releaseDriveList!;
        return () => { release(); releaseDriveList = undefined; };
      }
    };
    await (window as unknown as {
      runImportRegressions(context: typeof importContext): Promise<void>;
    }).runImportRegressions(importContext);
    await runStatistics(log);
    log(`PASS production loading geometry ${JSON.stringify(loadingAudit?.finish())}`);
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
    !document.querySelector('.history > .loading-region[aria-busy="true"], .overview > .loading-region[aria-busy="true"]') &&
    !document.querySelector('#history-title')?.closest('.loading-region[aria-busy="true"]') &&
    !visibleText(document.querySelector('.history-title')).includes('Loading records');
  type Interaction = { action: string; eventToPaintMs: number; queryDispatchDelayMs: number | null;
    afterQueryDispatchMs: number | null; queryRoundTripMs: number | null;
    workerQueueMs: number | null; workerExecutionMs: number | null;
    workerDispatchMs: number | null; responseTransferMs: number | null;
    afterQueryReplyMs: number | null;
    requestCount: number; supersededRequests: number;
    mutations: number; duringHeldDriveSync: boolean };
  async function interaction(action: string, invoke: () => void | Promise<void>, check: () => unknown, method?: string): Promise<Interaction> {
    const first = queryTimings.length;
    let mutations = 0;
    const observer = new MutationObserver((entries) => { mutations += entries.length; });
    observer.observe(main(), { subtree: true, childList: true, characterData: true, attributes: true });
    const start = performance.now();
    const duringHeldDriveSync = !!releaseDriveList;
    try {
      await invoke();
      await rendered(() => {
        const queries = queryTimings.slice(first);
        return (!method || queries.some((query) => query.method === method)) &&
          queries.every((query) => query.completed !== undefined) && check();
      }, action);
      const end = performance.now();
      // The latest successful reply is the selected UI context; an earlier
      // preview may have been correctly superseded while waiting in the queue.
      const firstQuery = queryTimings.slice(first).findLast((query) =>
        (!method || query.method === method) && !query.errorName);
      const rounded = (value: number) => Math.round(value * 100) / 100;
      return { action, eventToPaintMs: rounded(end - start),
        queryDispatchDelayMs: firstQuery ? rounded(firstQuery.issued - start) : null,
        afterQueryDispatchMs: firstQuery ? rounded(end - firstQuery.issued) : null,
        queryRoundTripMs: firstQuery?.completed !== undefined ? rounded(firstQuery.completed - firstQuery.issued) : null,
        workerQueueMs: firstQuery?.queueMs !== undefined ? rounded(firstQuery.queueMs) : null,
        workerExecutionMs: firstQuery?.executionMs !== undefined ? rounded(firstQuery.executionMs) : null,
        workerDispatchMs: firstQuery?.receivedAt !== undefined
          ? rounded(Math.max(0, firstQuery.receivedAt - performance.timeOrigin - firstQuery.issued)) : null,
        responseTransferMs: firstQuery?.completed !== undefined && firstQuery.finishedAt !== undefined
          ? rounded(Math.max(0, performance.timeOrigin + firstQuery.completed - firstQuery.finishedAt)) : null,
        afterQueryReplyMs: firstQuery?.completed !== undefined ? rounded(end - firstQuery.completed) : null,
        requestCount: queryTimings.length - first,
        supersededRequests: queryTimings.slice(first).filter((query) => query.errorName === 'AbortError').length,
        mutations, duringHeldDriveSync };
    } finally { observer.disconnect(); }
  }
  async function visibleArtwork(cold: boolean) {
    const images = [...document.querySelectorAll<HTMLImageElement>('.portrait-grid img[loading="eager"]')];
    const start = performance.now();
    const nonce = crypto.randomUUID();
    const samples = await Promise.all(images.map(async (image) => {
      const alreadyReady = !cold && image.complete && image.naturalWidth > 0;
      let failed = false;
      if (cold || !image.complete) {
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = (event?: Event) => {
            failed = event?.type === 'error' || !image.naturalWidth;
            clearTimeout(timer);
            image.removeEventListener('load', finish);
            image.removeEventListener('error', finish);
            resolve();
          };
          image.addEventListener('load', finish, { once: true });
          image.addEventListener('error', finish, { once: true });
          timer = setTimeout(() => finish(), 15_000);
          if (cold) {
            const url = new URL(image.currentSrc || image.src);
            assert(url.origin === origin, 'Artwork fixture uses bundled same-origin images');
            url.searchParams.set('fixture-cold', nonce);
            image.src = url.href;
          }
        });
      }
      try { await image.decode(); } catch { failed = true; }
      return { alreadyReady, failed, readyMs: Math.round((performance.now() - start) * 100) / 100 };
    }));
    await frame(); await frame();
    return { mode: cold ? 'cache-busted bundled artwork' : 'current preview artwork',
      images: images.length, alreadyReady: samples.filter((sample) => sample.alreadyReady).length,
      failures: samples.filter((sample) => sample.failed).length,
      lastImageDecodedMs: Math.max(0, ...samples.map((sample) => sample.readyMs)),
      imagePaintOpportunityMs: Math.round((performance.now() - start) * 100) / 100,
      samples };
  }
  async function rapidRarityChanges() {
    const all = required(document.querySelector<HTMLButtonElement>('.all-rarities'), 'all rarities');
    for (let index = 0; index < 6; index++) {
      all.click();
      // Let Svelte commit each distinct selection, without inventing a delay.
      await Promise.resolve(); await Promise.resolve();
    }
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

  async function runStatistics(log: (message: string) => void) {
    const archiveSnapshot = async () => {
      const state = await archiveCall<import('../../src/lib/local/types').PortableState>('exportState');
      // Drive may reorder profiles or object keys during reconciliation. Preserve
      // every field and ordered snapshot/record array when comparing archive data.
      state.profiles.sort((left, right) => left.id.localeCompare(right.id));
      const normalize = (value: unknown): unknown => Array.isArray(value)
        ? value.map(normalize)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
          : value;
      return JSON.stringify(normalize(state));
    };
    const originalProfile = activeProfile().value;
    const emptyProfile = required(
      [...activeProfile().options].find((option) => option.text === 'Routing secondary'),
      'empty statistics profile'
    ).value;
    await navigate('profiles');
    input(
      document.querySelector<HTMLInputElement>('input[placeholder="For example, Europe account"]'),
      'Statistics fixture'
    );
    await until(
      () => findButton('Create profile', main())?.matches(':enabled'),
      'statistics profile creation enabled'
    );
    clickButton('Create profile', main());
    await until(
      () =>
        [...activeProfile().options].some((option) => option.text === 'Statistics fixture') &&
        !activeProfile().disabled,
      'statistics profile created'
    );
    const profile = required(
      [...activeProfile().options].find((option) => option.text === 'Statistics fixture'),
      'statistics profile'
    ).value;
    input(activeProfile(), profile);
    await navigate('history');
    input(search(), '');
    await importSynthetic(statisticsExport());
    const archiveBefore = await archiveSnapshot();
    const queryStart = workerQueries.length;
    const compareStart = comparisons.length;
    await navigate('statistics');
    const personal = () =>
      required(document.querySelector<HTMLElement>('.personal-statistics'), 'personal statistics');
    const control = (label: string) =>
      required(
        [...personal().querySelectorAll('label')]
          .find((node) => node.firstChild?.textContent?.trim() === label)
          ?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select'),
        `${label} control`
      );
    const peerBars = () =>
      personal().querySelectorAll('[role="img"][aria-label^="Other saved accounts:"]');
    const planReady = () => personal().querySelector('.planner-chart svg');
    await until(
      () => comparisons.length > compareStart && peerBars().length === 3 && planReady(),
      'personal summary, comparison and planner'
    );
    assert(
      findButton('Your statistics')?.getAttribute('aria-pressed') === 'true',
      'Personal statistics is the default view'
    );
    assert(
      control('Rewards').value === 'featured' && control('Additional pulls').value === '75',
      'Planner defaults to 75 additional pulls and featured rewards'
    );
    assert(
      control('Starting pity').value === '3',
      'Planner starts with the selected history known trailing pity'
    );
    assert(
      control('Additional pulls').getAttribute('min') === '0' &&
        control('Additional pulls').getAttribute('max') === '20000',
      'Planner exposes its supported budget range'
    );
    const table = () => required(
      personal().querySelector('[role="table"][aria-label="Luck statistics comparisons"]'),
      'luck comparison table'
    );
    assert(
      table().querySelectorAll('[role="columnheader"]').length === 3 &&
        table().querySelectorAll('.metric[role="row"]').length === 3,
      'Comparison table separates observed result, model, and other accounts'
    );
    assert(table().textContent?.includes('16 of 64'), 'Comparison displays server aggregate counts');
    assert(
      peerBars()[0].getAttribute('aria-label')?.includes('75.0%'),
      'Comparison scale excludes ties using one minus the better-or-equal fraction'
    );
    assert(
      workerQueries.slice(queryStart).includes('statisticsSummary') &&
        workerQueries.slice(queryStart).every((method) => method === 'statisticsSummary'),
      'Statistics reads only its production worker aggregate'
    );
    const request = comparisons.at(-1)!.body;
    assert(
      request.elite?.budget === 73 &&
        request.featured?.budget === 73 &&
        request.featured.count === 7,
      'Comparison includes trailing exposure and excludes the classified anchor'
    );
    await until(
      () =>
        personal().querySelectorAll('.mc-chart svg').length >= 5 &&
        personal().querySelectorAll('.comparison:not(.community) .luck-scale').length === 3 &&
        personal().querySelectorAll('.distribution-grid .mc-chart').length === 3,
      'history summary, acquisition and planning probability workers'
    );
    for (const chart of personal().querySelectorAll('svg[role="img"]')) {
      const ids = chart.getAttribute('aria-labelledby')?.split(' ') ?? [];
      assert(
        ids.length === 2 && ids.every((id) => document.getElementById(id)?.textContent),
        'Every chart has a resolvable title and description'
      );
    }
    const values = required(
      personal().querySelector<HTMLDetailsElement>('.mc-values'),
      'numerical chart values'
    );
    values.open = true;
    assert(
      values.querySelector('caption')?.textContent &&
        values.querySelectorAll('tbody tr').length > 0,
      'Charts expose numerical table values'
    );
    log(
      'PASS Statistics production aggregate query, real synthetic classifications, comparison table and accessible charts'
    );

    input(control('Starting pity'), '17');
    await until(
      () => personal().textContent?.includes('your override') && planReady(),
      'explicit planner override'
    );
    clickButton('Use history state', personal());
    await until(
      () =>
        control('Starting pity').value === '3' &&
        !personal().querySelector('.planning .notice')?.textContent?.includes('your override'),
      'history state reset'
    );
    input(control('Additional pulls'), '0');
    await until(
      () =>
        personal().querySelector('.planner-chart h3')?.textContent?.includes('0 more pulls') &&
        planReady(),
      'zero-budget plan'
    );
    assert(
      personal().querySelector('.planner-stats')?.textContent?.includes('0.0 rewards'),
      'Zero additional pulls predicts zero rewards'
    );
    input(control('Additional pulls'), '20000');
    await until(
      () =>
        personal().querySelector('.planner-chart h3')?.textContent?.includes('20,000 more pulls') &&
        planReady(),
      'maximum supported budget plan'
    );
    input(control('Additional pulls'), '20001');
    await until(
      () =>
        personal().querySelector('.planning [role="status"]')?.textContent?.includes('0–20,000') &&
        !planReady(),
      'out-of-range budget hides stale plan'
    );
    input(control('Additional pulls'), '20000');
    await wait(0);
    input(control('Additional pulls'), '0');
    await until(
      () =>
        personal().querySelector('.planner-chart h3')?.textContent?.includes('0 more pulls') &&
        planReady(),
      'new zero budget supersedes an in-flight large plan'
    );
    assert(
      personal().querySelector('.planner-stats')?.textContent?.includes('0.0 rewards'),
      'Superseded planner cannot restore the former budget result'
    );
    input(control('Additional pulls'), '75');
    input(control('Starting pity'), '17');
    input(control('Recruitment history'), '4');
    await until(
      () =>
        control('Starting pity').value === '2' &&
        control('Starting pity').getAttribute('max') === '69' &&
        planReady(),
      'weapon category replaces planner model and override'
    );
    assert(
      !personal().querySelector('.planning .notice')?.textContent?.includes('your override'),
      'Category change clears the former model override'
    );
    log(
      'PASS planner default, known pity, explicit/reset state, zero and 20,000 budgets, invalid input and recruitment model change'
    );

    comparisonContributors = 49;
    input(control('Recruitment history'), '3');
    await until(() => table().textContent?.includes('16 of 49'), 'counts-only comparison cohort');
    assert(
      peerBars().length === 0,
      'Fewer than 50 comparable histories show counts without a luck bar'
    );
    comparisonStatus = 'privacy_suppressed';
    const privateComparisonStart = comparisons.length;
    input(control('Recruitment history'), '4');
    await until(
      () =>
        comparisons.length > privateComparisonStart &&
        personal().querySelector('.community strong')?.textContent === 'Not available',
      'privacy-suppressed comparison'
    );
    assert(
      peerBars().length === 0 &&
        !personal().querySelector('.community')?.textContent?.includes('16 of'),
      'Privacy suppression removes comparison counts and bars'
    );
    comparisonStatus = 'ok';
    comparisonContributors = 64;
    holdComparison = true;
    input(control('Recruitment history'), '3');
    await until(() => releaseComparison, 'held aggregate comparison');
    const pending = comparisons.at(-1)!;
    input(control('History profile'), emptyProfile);
    await until(
      () =>
        control('History profile').value === emptyProfile &&
        personal().textContent?.includes('No recorded history') &&
        pending.signal?.aborted,
      'profile change aborts comparison'
    );
    assert(activeProfile().value === profile, 'Statistics profile selection preserves the My history profile');
    releaseComparison!();
    releaseComparison = undefined;
    await wait(100);
    assert(
      !personal().textContent?.includes('16 of 64') && peerBars().length === 0,
      'Late comparison cannot populate another profile'
    );
    input(control('Starting pity'), '17');
    input(control('Planning model'), 'weapons');
    await until(
      () =>
        control('Starting pity').value === '0' &&
        control('Starting pity').getAttribute('max') === '69' &&
        planReady(),
      'assumed model resets override'
    );
    input(control('Starting pity'), '12');
    clickButton('Reset assumed state', personal());
    await until(
      () => control('Starting pity').value === '0' && planReady(),
      'assumed planner state resets'
    );
    log(
      'PASS comparison cohort/privacy thresholds, aborted stale profile reply, and empty-profile model reset'
    );

    input(control('History profile'), profile);
    await until(
      () => control('Starting pity').value === '3' && peerBars().length === 3,
      'return to imported profile'
    );
    clickButton('Community statistics');
    await until(
      () =>
        !document.querySelector('.personal-statistics') &&
        findButton('Community statistics')?.getAttribute('aria-pressed') === 'true',
      'community view'
    );
    clickButton('Your statistics');
    await until(
      () => document.querySelector('.personal-statistics') && peerBars().length === 3,
      'personal view restored'
    );
    const archiveAfter = await archiveSnapshot();
    if (archiveAfter !== archiveBefore) {
      let first = 0;
      while (archiveBefore[first] === archiveAfter[first] && first < archiveBefore.length) first++;
      log(`Archive difference at serialized character ${first}: before=${archiveBefore.slice(Math.max(0, first - 60), first + 100)}; after=${archiveAfter.slice(Math.max(0, first - 60), first + 100)}`);
    }
    assert(
      archiveAfter === archiveBefore,
      'Statistics and planning leave the archive unchanged'
    );
    await navigate('backup');
    assert(findButton('Disconnect'), 'Statistics navigation preserves the Drive connection');
    input(activeProfile(), originalProfile);
    await navigate('history');
    assert(document.querySelector('#history-title'), 'Existing My history remains available');
    log('PASS Statistics view navigation, unchanged archive and retained Drive session');
  }
  function statisticsExport() {
    // Reviewed synthetic pools within their date bounds provide a real classified
    // featured anchor, complete later intervals, and a known trailing pity.
    const records = [
      ...Array.from({ length: 83 }, (_, index) => ({
        source_type_id: 3,
        source_page: 1,
        record: {
          item: (index + 1) % 10 === 0 ? 1013 : 11007,
          pool_id: 13001,
          item_num: 1,
          time: Date.parse('2025-12-01T12:00:00Z') / 1000 + index
        }
      })),
      ...Array.from({ length: 42 }, (_, index) => ({
        source_type_id: 4,
        source_page: 1,
        record: {
          item: (index + 1) % 10 === 0 ? 10133 : 11007,
          pool_id: 14001,
          item_num: 1,
          time: Date.parse('2025-12-01T12:00:00Z') / 1000 + index
        }
      }))
    ];
    return new File(
      [
        JSON.stringify({
          schema_version: 1,
          exported_at: '2026-09-20T12:00:00Z',
          account_fingerprint: `sha256:${'a'.repeat(64)}`,
          endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
          server: '1',
          game_channel_id: '1',
          records: records.reverse()
        })
      ],
      'statistics-synthetic.json',
      { type: 'application/json' }
    );
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
      assert(visibleText(document.querySelector('.history-title')).includes(`${count.toLocaleString()} records`), 'Overlapping file imports preserve exact occurrences');
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
        const beforeDiagnostics = await archiveCall<{ archiveReads: number; engineBuilds: number }>('diagnostics');
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
          const allRarities = required(document.querySelector<HTMLButtonElement>('.all-rarities'), 'all rarity selection');
          timings.push(await interaction('reward rarity selection', () => allRarities.click(), historySettled, 'rewards'));
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
        // Network-stalled Drive does not occupy the archive worker. Measure a
        // real export/compression ahead of preview requests as a separate case.
        const contentionStart = queryTimings.length;
        const exportPromise = archiveCall<Uint8Array>('exportBackup');
        const contention = await interaction('rapid rarity selection behind real backup compression', rapidRarityChanges, historySettled, 'rewards');
        const backup = await exportPromise;
        assert(backup.length > 0, 'Contended operation produced an actual compressed backup');
        const exportTiming = queryTimings.slice(contentionStart).find((query) => query.method === 'exportBackup');
        const rapidSelection = await interaction('rapid rarity selection without worker contention', rapidRarityChanges, historySettled, 'rewards');
        const afterDiagnostics = await archiveCall<{ archiveReads: number; engineBuilds: number }>('diagnostics');
        assert(afterDiagnostics.engineBuilds === beforeDiagnostics.engineBuilds, 'Warm interactions rebuilt the archive engine');
        // Ensure the two-row 5-star preview contains real bundled artwork.
        const artRecruitment = required(document.querySelector<HTMLSelectElement>('.recruitment-select select'), 'artwork recruitment');
        if (artRecruitment.value !== '6') await interaction('artwork recruitment setup', () => input(artRecruitment, '6'), historySettled, 'rewards');
        const rarityInputs = [...document.querySelectorAll<HTMLInputElement>('.rarity-controls input')];
        if (rarityInputs.some((checkbox, index) => checkbox.checked !== (index === 0))) {
          await interaction('5-star artwork setup', () => {
            rarityInputs.forEach((checkbox, index) => { if (checkbox.checked !== (index === 0)) checkbox.click(); });
          }, historySettled, 'rewards');
        }
        const artwork = [await visibleArtwork(false), await visibleArtwork(true)];
        const sorted = timings.filter((timing) => !timing.action.startsWith('search')).map((timing) => timing.eventToPaintMs).sort((a, b) => a - b);
        const report = { records: profile.records, importsMs: profile.importMs, timings,
          nonSearchP95Ms: sorted[Math.ceil(sorted.length * .95) - 1], nonSearchMaxMs: Math.max(...sorted),
          warmTargetMet: sorted.every((ms) => ms < 200), longTasks: tasks.filter((task) => task.start >= runStart),
          rapidSelection, contention, compression: exportTiming, artwork,
          diagnostics: { before: beforeDiagnostics, after: afterDiagnostics },
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
    const toggleResults = document.createElement('button');
    toggleResults.textContent = 'Hide results';
    toggleResults.setAttribute('aria-expanded', 'true');
    toggleResults.onclick = () => {
      results.hidden = !results.hidden;
      panel.style.position = results.hidden ? 'static' : 'fixed';
      toggleResults.textContent = results.hidden ? 'Show results' : 'Hide results';
      toggleResults.setAttribute('aria-expanded', String(!results.hidden));
    };
    button.onclick = () => location.assign('/__routing/reset');
    const performanceButton = document.createElement('button');
    performanceButton.textContent = 'Run DOM performance';
    performanceButton.onclick = () => { sessionStorage.setItem(RUN, 'performance'); location.assign('/__routing/reset'); };
    panel.append(button, performanceButton, toggleResults, results);
    document.body.append(panel);
    if (submissionFixture) {
      button.disabled = true; results.textContent = 'Running unified submission controls…\n';
      runSubmission((message) => { results.textContent += `${message}\n`; }).then(() => {
        panel.dataset.result = 'pass';
      }, (error) => { results.textContent += `FAIL ${error.stack || error}\n`; panel.dataset.result = 'fail'; });
      return;
    }
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
      loadingAudit = watchLoadingRegions();
      run((message) => { results.textContent += `${message}\n`; }).then(() => {
        results.textContent += 'PASS all routing checks\n';
        panel.dataset.result = 'pass';
      }, (error) => {
        results.textContent += `FAIL ${error.stack || error}\n`;
        panel.dataset.result = 'fail';
        running = false;
      }).finally(() => { loadingAudit?.stop(); button.disabled = false; });
    }
  });
})();
