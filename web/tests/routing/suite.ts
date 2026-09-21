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
    request.onsuccess = () => { sessionStorage.setItem(RUN, 'yes'); location.replace('/history'); };
    request.onerror = () => { document.body.textContent = 'Could not reset fixture storage.'; };
    request.onblocked = () => { document.body.textContent = 'Close other routing-fixture tabs, then refresh.'; };
    return;
  }

  const originalFetch = window.fetch.bind(window);
  type DriveMetadata = { description: string; appProperties: Record<string, string> };
  const cloud = new Map<string, { id: string; metadata: DriveMetadata; data: Uint8Array<ArrayBuffer> }>();
  const errors: string[] = [];
  const counts = { authorization: 0, game: 0, upload: 0 };
  let releaseAuthorization: (() => void) | undefined;
  let releaseCapture: (() => void) | undefined;
  let captureSignal: AbortSignal | null | undefined;
  let deferAuthorization = false, deferCapture = false, running = false;
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
    if (url.origin === origin && url.pathname === '/api/public/config') return json({
      mode: 'public', csrf_token: 'synthetic-routing-csrf',
      features: { server_backup: false, community_contribution: false, relay_import: false },
      identity_verification: { available: false, reason: 'Routing fixture' }, accounts: [], limits: {}
    });
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
        return json({ id });
      }
      if (url.searchParams.get('alt') === 'media') {
        const item = cloud.get(url.pathname.split('/').pop() ?? '');
        if (!item) throw new Error('Unknown synthetic Drive revision');
        return new Response(item.data);
      }
      if (url.pathname === '/drive/v3/files') return json({ files: [...cloud.values()].map(({ id, metadata }) => ({
        id, description: metadata.description, appProperties: metadata.appProperties
      })) });
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
    panel.append(button, results);
    document.body.append(panel);
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
