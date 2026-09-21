import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'vite';

// Use an existing Playwright installation; the tracker does not ship a browser/test runner.
const playwright = process.env.PLAYWRIGHT_MODULE;
const { chromium } = playwright
  ? await import(pathToFileURL(playwright).href)
  : await import('playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const root = fileURLToPath(new URL('.', import.meta.url));
const sdkDist = new URL('../../node_modules/posthog-js/dist/', import.meta.url);
const replayerPath =
  process.env.RRWEB_REPLAYER ??
  fileURLToPath(new URL('../../node_modules/rrweb/dist/rrweb.umd.cjs', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] }
  },
  logLevel: 'warn'
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {})
});
const remoteConfig = {
  hasFeatureFlags: false,
  sessionRecording: { endpoint: '/s/', sampleRate: 1, minimumDurationMilliseconds: 0 },
  capturePerformance: false,
  autocapture_opt_out: true
};
const events = [];
const requests = [];
const errors = [];
let blocked = false;
let failIngestion = false;

function decode(request) {
  const body = request.postDataBuffer();
  if (!body?.length) return [];
  let text = body[0] === 31 && body[1] === 139 ? gunzipSync(body).toString() : body.toString();
  if (text.startsWith('data='))
    text = Buffer.from(new URLSearchParams(text).get('data'), 'base64').toString();
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : Array.isArray(value.batch) ? value.batch : [value];
}

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out: ${label}; requests=${JSON.stringify(requests)} errors=${JSON.stringify(errors)}`
  );
}

try {
  // HeadlessChrome is deliberately rejected by the SDK's bot filter. Keep the
  // production filter enabled while exercising an ordinary desktop user agent.
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    requests.push(url.pathname);
    if (blocked) return route.abort('blockedbyclient');
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (!['us.i.posthog.com', 'us-assets.i.posthog.com'].includes(url.hostname)) {
      errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (/\/config(?:\.js)?$/.test(url.pathname))
      return route.fulfill({
        headers,
        contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'application/json',
        body: url.pathname.endsWith('.js')
          ? `window._POSTHOG_REMOTE_CONFIG={phc_synthetic_telemetry_fixture:{config:${JSON.stringify(remoteConfig)}}};`
          : JSON.stringify(remoteConfig)
      });
    if (url.pathname.endsWith('.js')) {
      const name = url.pathname
        .split('/')
        .at(-1)
        .replace(/-\d+(?:\.\d+)*\.js$/, '.js');
      const source = new URL(name, sdkDist);
      if (existsSync(source))
        return route.fulfill({
          headers,
          contentType: 'text/javascript',
          body: await readFile(source)
        });
      errors.push(`Unknown SDK extension ${url.pathname}`);
      return route.abort();
    }
    try {
      events.push(...decode(request));
    } catch (error) {
      errors.push(String(error));
    }
    return route.fulfill({
      status: failIngestion ? 503 : 200,
      headers,
      contentType: 'application/json',
      body: failIngestion ? '{"status":0}' : '{"status":1}'
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(origin + '/?capture=SENTINEL_URL_QUERY#SENTINEL_URL_HASH');
  await page.waitForFunction(() => !!window.telemetryFixture);
  await page.locator('#private-input').fill('SENTINEL_TYPED');
  await page.evaluate(() => {
    document.querySelector('#private-text').textContent = 'SENTINEL_MUTATION_TEXT';
    document
      .querySelector('#private-text')
      .setAttribute('data-secret', 'SENTINEL_MUTATION_ATTRIBUTE');
    const error = new TypeError('SENTINEL_ERROR_MESSAGE');
    error.stack =
      'TypeError: SENTINEL_ERROR_MESSAGE\n    at SENTINEL_FUNCTION (' +
      location.origin +
      '/_app/immutable/chunks/example.js?token=SENTINEL_STACK_QUERY:12:34)';
    window.telemetryFixture.reportBrowserError(error);
    window.telemetryFixture.reportBrowserError(error);
    window.telemetryFixture.trackOperation('backup', 'success', 10);
    window.telemetryFixture.navigate('/history?capture=SENTINEL_NAV_QUERY#SENTINEL_NAV_HASH');
    window.telemetryFixture.capturePageview('/history?capture=SENTINEL_DUPLICATE_QUERY');
  });
  await waitFor(
    () => events.some((event) => event.event === '$snapshot'),
    'actual SDK replay ingestion'
  );
  await waitFor(
    () =>
      events.filter((event) => event.event === '$pageview').length >= 2 &&
      events.some((event) => event.event === '$exception'),
    'pageview and error ingestion'
  );
  const mutationStart = Date.now();
  await page.locator('#private-input').fill('SENTINEL_RECORDED_INPUT');
  await page.evaluate(() => {
    document.querySelector('#private-text').textContent = 'SENTINEL_RECORDED_MUTATION';
    document
      .querySelector('#private-text')
      .setAttribute('data-secret', 'SENTINEL_RECORDED_ATTRIBUTE');
  });
  await waitFor(
    () =>
      [0, 5].every((source) =>
        events.some(
          (event) =>
            event.event === '$snapshot' &&
            event.properties.$snapshot_data.some(
              (snapshot) =>
                snapshot.type === 3 &&
                snapshot.timestamp >= mutationStart &&
                snapshot.data.source === source
            )
        )
      ),
    'incremental recorder input/DOM events'
  );
  assert.equal(
    events.filter((event) => event.event === '$pageview').length,
    2,
    'exactly one pageview per navigation'
  );
  assert.equal(
    events.filter((event) => event.event === '$exception').length,
    1,
    'same error object reported once'
  );
  const snapshots = events
    .filter((event) => event.event === '$snapshot')
    .flatMap((event) => event.properties.$snapshot_data);
  assert.ok(
    snapshots.some((event) => event.type === 2),
    'a real rrweb full DOM snapshot was decoded'
  );
  assert.ok(
    snapshots.some((event) => event.type === 4 && event.data.width > 0 && event.data.height > 0),
    'real rrweb metadata preserves viewport dimensions required for visible playback'
  );
  const captured = JSON.stringify(events);
  const leaked = captured.match(/SENTINEL_[A-Z_]+/g);
  assert.equal(leaked, null, `synthetic secrets reached ingestion: ${leaked}`);
  assert.ok(!requests.some((path) => path.includes('/flags')), 'feature flag API is unused');
  assert.deepEqual(errors, []);
  const replay = await context.newPage();
  await replay.setContent(
    '<!doctype html><title>Masked replay assertion</title><main id="replay"></main>'
  );
  await replay.addScriptTag({ content: await readFile(replayerPath, 'utf8') });
  await replay.evaluate((snapshots) => {
    const player = new rrweb.Replayer(snapshots, {
      root: document.querySelector('#replay'),
      mouseTail: false
    });
    player.play();
  }, snapshots);
  await replay
    .waitForFunction(() => {
      const frame = document.querySelector('iframe');
      return (
        frame?.getBoundingClientRect().width > 0 &&
        frame?.getBoundingClientRect().height > 0 &&
        frame?.contentDocument?.body?.querySelectorAll('*').length >= 6
      );
    })
    .catch(async (error) => {
      console.error({
        records: snapshots.map((s) => ({
          type: s.type,
          time: s.timestamp,
          data: s.type === 4 ? s.data : undefined
        })),
        iframe: await replay.evaluate(() => ({
          html: document.querySelector('iframe')?.outerHTML,
          nodes: document.querySelector('iframe')?.contentDocument?.body?.querySelectorAll('*')
            .length
        }))
      });
      throw error;
    });
  const playback = await replay.evaluate(() => {
    const frame = document.querySelector('iframe');
    const bounds = frame.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      text: frame.contentDocument.body.innerText,
      nodes: frame.contentDocument.body.querySelectorAll('*').length
    };
  });
  assert.ok(
    playback.width > 0 && playback.height > 0 && playback.nodes >= 6,
    'actual transmitted replay produces a visible reconstructed document'
  );
  assert.ok(
    playback.text.includes('***') && !playback.text.includes('SENTINEL_'),
    'actual replay playback masks private text'
  );
  await replay.close();
  console.log(
    `PASS actual SDK: ${events.length} events, ${snapshots.length} replay records; no synthetic input/text/attribute/URL/error secrets; pageviews and errors deduplicated`
  );

  failIngestion = true;
  const beforeSecondTab = events.length;
  const second = await context.newPage();
  await second.goto(origin);
  await second.waitForFunction(() => window.telemetryFixture?.telemetryEnabled());
  await waitFor(() => events.length > beforeSecondTab, 'a server-rejected batch queued for retry');
  await page.evaluate(() => {
    window.telemetryFixture.capturePageview('/profiles');
    window.telemetryFixture.setTelemetryEnabled(false);
  });
  await second.waitForFunction(() => !window.telemetryFixture.telemetryEnabled());
  // Let any request already dispatched before the click settle before checking future collection.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterOptOut = events.length;
  for (const tab of [page, second])
    await tab.evaluate(() => {
      window.telemetryFixture.navigate('/backup');
      window.telemetryFixture.trackOperation('backup', 'success', 10);
      window.telemetryFixture.reportBrowserError(new Error('SENTINEL_OPTED_OUT_ERROR'));
    });
  await page.reload();
  await page.waitForFunction(() => !!window.telemetryFixture);
  assert.equal(
    await page.evaluate(() => window.telemetryFixture.telemetryEnabled()),
    false,
    'opt-out survives reload'
  );
  await page.evaluate(() => window.telemetryFixture.navigate('/history'));
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  assert.equal(
    events.length,
    afterOptOut,
    'no collection after opt-out across tabs, reload, and navigation'
  );
  console.log(
    'PASS opt-out: persistent after reload/navigation, synchronized across tabs, no queued event, replay, or failed-request retry ingestion'
  );

  blocked = true;
  await page.evaluate(() => window.telemetryFixture.setTelemetryEnabled(true));
  await page.evaluate(() => {
    window.telemetryFixture.trackOperation('import', 'success', 12);
    window.telemetryFixture.trackOperation('restore', 'success', 13);
    window.telemetryFixture.disabledDeployment();
  });
  assert.equal(await page.evaluate(() => window.telemetryFixture.telemetryEnabled()), false);
  console.log('PASS blocked ingestion is non-throwing and runtime-disabled telemetry stops');
} finally {
  await browser.close();
  await server.close();
}
