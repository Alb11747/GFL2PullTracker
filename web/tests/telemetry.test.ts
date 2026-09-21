import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult, PostHogConfig } from 'posthog-js';
import { createTelemetry, TELEMETRY_STORAGE_KEY } from '../src/lib/telemetry/browser.ts';
import { safePath, sanitizeCapture, sanitizeError } from '../src/lib/telemetry/privacy.ts';
import { telemetryEnvironment } from '../src/lib/telemetry/deployment.ts';

const origin = 'https://tracker.example';
const id = '01996542-3456-7456-8456-0123456789ab';
const config = {
  enabled: true,
  key: 'phc_test',
  host: 'https://us.i.posthog.com',
  release: 'abc123'
};
const context = { origin, release: config.release, key: config.key, enabled: true };
const event = (name: string, properties: Record<string, unknown>): CaptureResult => ({
  uuid: id,
  event: name,
  properties
});

test('telemetry transmits only allowed route labels and operation fields', () => {
  for (const route of [
    '/history?token=secret#secret',
    '/history#secret',
    'https://elsewhere.invalid/history?secret'
  ])
    assert.equal(safePath(route), '/history');
  assert.equal(safePath('/profiles/secret-account'), '/unknown');
  const clean = sanitizeCapture(
    event('tracker_operation', {
      distinct_id: id,
      operation: 'import',
      outcome: 'failed',
      duration_ms: 12.6,
      $current_url: `${origin}/history?token=secret#secret`,
      token: 'secret',
      filename: 'secret.json',
      account_id: 'secret',
      $set: { secret: true },
      $referrer: 'https://private.example/secret',
      $initial_current_url: 'secret'
    }),
    context
  )!;
  assert.equal(clean.properties.distinct_id, id);
  assert.equal(clean.properties.duration_ms, 13);
  assert.equal(clean.properties.$current_url, `${origin}/history`);
  assert.equal(clean.properties.token, 'phc_test');
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(sanitizeCapture(event('arbitrary-private-event', {}), context), null);
  assert.equal(
    sanitizeCapture(
      event('tracker_operation', { operation: 'account-secret', outcome: 'success' }),
      context
    ),
    null
  );
  assert.equal(sanitizeCapture(event('$pageview', {}), { ...context, enabled: false }), null);
});

test('exceptions discard messages, causes, private frames and locals while retaining source-map chunk identifiers', () => {
  const error = new TypeError('secret capture data', { cause: new Error('secret cause') });
  error.stack = `TypeError: secret\n    at privateAccount (${origin}/_app/immutable/chunks/app.js?token=secret:17:23)\n    at https://private.invalid/secret.js:1:1\n    at file:///C:/Users/secret/app.js:1:1`;
  const clean = sanitizeError(error, origin)!;
  assert.equal(clean.name, 'TypeError');
  assert.equal(clean.cause, undefined);
  assert.equal(
    clean.stack,
    `TypeError: Application error\n    at ${origin}/_app/immutable/chunks/app.js:17:23`
  );
  assert.equal(sanitizeError(new DOMException('secret', 'AbortError'), origin), null);
  assert.equal(
    sanitizeError(Object.assign(new Error('server secret'), { name: 'PublicApiError' }), origin),
    null
  );
  const result = sanitizeCapture(
    event('$exception', {
      $exception_list: [
        {
          type: 'TypeError',
          value: 'secret',
          stacktrace: {
            frames: [
              {
                filename: `${origin}/_app/immutable/chunks/app.js?secret`,
                lineno: 17,
                colno: 23,
                chunk_id: id,
                vars: { secret: 'secret' },
                context_line: 'secret',
                function: 'secret'
              },
              { filename: 'https://private.invalid/secret.js', lineno: 1 }
            ]
          }
        }
      ],
      $exception_message: 'secret',
      $exception_stack_trace_raw: 'secret'
    }),
    context
  )!;
  const list = result.properties.$exception_list;
  assert.equal(list[0].stacktrace.frames.length, 1);
  assert.equal(list[0].stacktrace.frames[0].chunk_id, id);
  assert.equal(list[0].stacktrace.frames[0].function, '?');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('exception frames accept revision-namespaced assets while rejecting arbitrary path segments', () => {
  const revision = 'a'.repeat(40);
  const filename = `${origin}/_app/${revision}/immutable/chunks/app.js`;
  const error = new Error('secret');
  error.stack = `Error: secret\n    at ${filename}?secret:7:42\n    at ${origin}/_app/private-account/immutable/chunks/app.js:7:42`;
  assert.equal(
    sanitizeError(error, origin)?.stack,
    `Error: Application error\n    at ${filename}:7:42`
  );
  const clean = sanitizeCapture(
    event('$exception', {
      $exception_list: [
        {
          type: 'Error',
          value: 'secret',
          stacktrace: {
            frames: [
              { filename: `${filename}?secret`, lineno: 7, colno: 42, chunk_id: id },
              {
                filename: `${origin}/_app/private-account/immutable/chunks/app.js`,
                lineno: 7,
                colno: 42
              }
            ]
          }
        }
      ]
    }),
    context
  )!;
  assert.deepEqual(clean.properties.$exception_list[0].stacktrace.frames, [
    {
      platform: 'web:javascript',
      filename,
      function: '?',
      in_app: true,
      lineno: 7,
      colno: 42,
      chunk_id: id
    }
  ]);
});

test('replay metadata strips private URLs and drops custom/network/console plugin events', () => {
  const result = sanitizeCapture(
    event('$snapshot', {
      $snapshot_data: [
        {
          type: 4,
          timestamp: 1,
          data: {
            href: `${origin}/history?secret#secret`,
            width: 1024,
            height: 768,
            private: 'secret'
          }
        },
        { type: 5, timestamp: 2, data: { tag: 'private', payload: 'secret' } },
        { type: 6, timestamp: 3, data: { plugin: 'console', payload: 'secret' } }
      ]
    }),
    context
  )!;
  assert.equal(result.properties.$snapshot_data.length, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('replay full and incremental snapshots scrub all DOM strings and discard unsafe incremental sources', () => {
  const result = sanitizeCapture(
    event('$snapshot', {
      $snapshot_data: [
        {
          type: 2,
          timestamp: 1,
          data: {
            node: {
              id: 1,
              type: 2,
              tagName: 'div',
              attributes: { 'data-secret': 'secret', title: 'secret', rr_width: '100px' },
              childNodes: [{ id: 2, type: 3, textContent: 'secret' }]
            },
            initialOffset: { top: 0, left: 0 }
          }
        },
        {
          type: 3,
          timestamp: 2,
          data: {
            source: 0,
            texts: [{ id: 2, value: 'secret' }],
            attributes: [{ id: 1, attributes: { title: 'secret' } }],
            adds: [],
            removes: []
          }
        },
        { type: 3, timestamp: 3, data: { source: 5, id: 3, text: 'secret', isChecked: false } },
        ...[7, 8, 9, 10, 11, 13, 15, 16].map((source) => ({
          type: 3,
          timestamp: 4,
          data: { source, payload: 'secret' }
        }))
      ]
    }),
    context
  )!;
  assert.equal(result.properties.$snapshot_data.length, 3);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.properties.$snapshot_data[0].data.node.attributes.rr_width, '100px');
  assert.equal(result.properties.$snapshot_data[2].data.text, '******');
});

test('deployment labels are allowlisted and dev builds cannot claim production', () => {
  for (const value of ['production', 'staging', 'test', 'development']) {
    assert.equal(telemetryEnvironment(value), value);
    assert.equal(telemetryEnvironment(value, true), 'development');
  }
  for (const value of [undefined, '', 'private-configuration', {}, null])
    assert.equal(telemetryEnvironment(value), 'development');
});

test('browser send boundary labels events and replay from deployment configuration', async () => {
  for (const [environment, expected] of [
    ['production', 'production'],
    ['staging', 'staging'],
    ['test', 'test'],
    ['development', 'development'],
    [undefined, 'development'],
    ['SECRET', 'development']
  ]) {
    const h = harness();
    h.client.init({ ...config, environment });
    await h.loaded();
    const send = h.sdkConfig!.before_send;
    assert.equal(typeof send, 'function');
    for (const name of ['$pageview', 'tracker_operation', '$exception', '$snapshot']) {
      const clean = (send as (value: CaptureResult) => CaptureResult | null)(
        event(name, {
          distinct_id: id,
          environment: 'SECRET',
          operation: 'import',
          outcome: 'success',
          $exception_list: [{ type: 'Error', value: 'SECRET' }],
          $snapshot_data: [{ type: 4, data: { href: origin, width: 800, height: 600 } }]
        })
      );
      assert.ok(clean);
      assert.equal(clean.properties.environment, expected);
      assert.doesNotMatch(JSON.stringify(clean), /SECRET/);
    }
  }
});

function harness(saved: string | null = null, privacySignal = false) {
  let sdkConfig: Partial<PostHogConfig> | undefined;
  let storageListener: (key: string | null, value: string | null) => void = () => {};
  let errorListener: (error: unknown) => void = () => {};
  let resolveSdk: (
    value: Awaited<ReturnType<Parameters<typeof createTelemetry>[1]>>
  ) => void = () => {};
  let loads = 0;
  const calls: string[] = [];
  const events: Array<{ event: string; properties: unknown }> = [];
  const storage = new Map<string, string>(saved === null ? [] : [[TELEMETRY_STORAGE_KEY, saved]]);
  let cookie = '';
  const sdk = {
    init(_key: string, options: Partial<PostHogConfig>) {
      sdkConfig = options;
      calls.push('init');
    },
    capture(event: string, properties: unknown) {
      events.push({ event, properties });
    },
    captureException(error: Error) {
      events.push({ event: '$exception', properties: error });
    },
    opt_in_capturing() {
      calls.push('in');
    },
    opt_out_capturing() {
      calls.push('out');
    },
    startSessionRecording() {
      calls.push('start');
    },
    stopSessionRecording() {
      calls.push('stop');
    }
  } as unknown as Awaited<ReturnType<Parameters<typeof createTelemetry>[1]>>;
  const client = createTelemetry(
    {
      origin,
      privacySignal: () => privacySignal,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        }
      },
      readCookie: () => cookie,
      writeCookie: (value) => {
        cookie = value;
      },
      listenStorage(callback) {
        storageListener = callback;
      },
      listenErrors(callback) {
        errorListener = callback;
      }
    },
    () => {
      loads++;
      return new Promise((resolve) => {
        resolveSdk = resolve;
      });
    }
  );
  return {
    client,
    calls,
    events,
    storage,
    get loads() {
      return loads;
    },
    get cookie() {
      return cookie;
    },
    get sdkConfig() {
      return sdkConfig;
    },
    async loaded() {
      resolveSdk(sdk);
      await new Promise((resolve) => setImmediate(resolve));
    },
    storageChange(value: string | null) {
      storageListener(TELEMETRY_STORAGE_KEY, value);
    },
    error(error: unknown) {
      errorListener(error);
    }
  };
}

test('local mode and persistent opt-out never load the SDK or capture data', () => {
  for (const [saved, enabled] of [
    ['0', true],
    [null, false]
  ] as const) {
    const h = harness(saved);
    h.client.init({ ...config, enabled });
    h.client.pageview('/history');
    h.client.operation('import', 'success', 100);
    h.error(new Error('secret'));
    assert.equal(h.loads, 0);
    assert.equal(h.events.length, 0);
    assert.equal(h.client.enabled(), false);
  }
});

test('browser privacy signals override the default and a manual opt-in', () => {
  const h = harness(null, true);
  h.client.init(config);
  h.client.setEnabled(true);
  h.client.pageview('/history');
  assert.equal(h.loads, 0);
  assert.equal(h.client.enabled(), false);
  assert.match(h.cookie, /^gfl2_telemetry=0;/);
});

test('opt-out while SDK is loading discards pending events and never initializes it', async () => {
  const h = harness();
  h.client.init(config);
  h.client.pageview('/history');
  h.client.setEnabled(false);
  await h.loaded();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(h.storage.get(TELEMETRY_STORAGE_KEY), '0');
  assert.match(h.cookie, /^gfl2_telemetry=0;/);
});

test('singleton initialization, navigation deduplication, error deduplication and cross-tab opt-out', async () => {
  const h = harness();
  const states: boolean[] = [];
  h.client.subscribe((state) => states.push(state));
  h.client.init(config);
  h.client.init(config);
  h.client.pageview('/history?secret');
  h.client.pageview('/history');
  h.client.pageview('/privacy');
  await h.loaded();
  assert.equal(h.loads, 1);
  assert.equal(h.calls.filter((call) => call === 'init').length, 1);
  assert.equal(h.events.length, 2);
  const error = new Error('secret');
  h.client.reportError(error);
  h.error(error);
  assert.equal(h.events.filter((event) => event.event === '$exception').length, 1);
  h.storageChange('0');
  assert.deepEqual(h.calls.slice(-2), ['out', 'stop']);
  assert.equal(states.at(-1), false);
  const count = h.events.length;
  h.client.pageview('/backup');
  h.client.operation('backup', 'success', 1);
  h.client.init(config);
  assert.equal(h.events.length, count);
  assert.equal(h.client.enabled(), false);
  h.client.setEnabled(true);
  await h.loaded();
  assert.deepEqual(h.calls.slice(-2), ['in', 'start']);
  assert.match(h.cookie, /^gfl2_telemetry=1;/);
});

test('SDK settings pin privacy controls and optional capture off', async () => {
  const h = harness();
  h.client.init(config);
  await h.loaded();
  const options = h.sdkConfig!;
  assert.equal(options.person_profiles, 'never');
  assert.equal(options.autocapture, false);
  assert.equal(options.capture_exceptions, false);
  assert.equal(options.capture_pageview, false);
  assert.equal(options.enable_recording_console_log, false);
  const replay = options.session_recording!;
  assert.equal(replay.maskAllInputs, true);
  assert.equal(replay.maskTextSelector, '*');
  assert.equal(replay.maskAllElementAttributes, true);
  assert.equal(replay.recordHeaders, false);
  assert.equal(replay.recordBody, false);
  assert.equal(replay.sampleRate, 1);
  assert.equal(replay.compress_events, false);
  assert.equal(options.request_batching, false);
  assert.equal(options.disable_beacon, true);
  assert.equal(
    replay.maskCapturedNetworkRequestFn!({ name: `${origin}/history?secret` } as never)?.name,
    `${origin}/history`
  );
  assert.equal(
    replay.maskCapturedNetworkRequestFn!({ name: '/secret', method: 'GET' } as never),
    null
  );
});

test('opt-out permanently aborts old transport and retry options across a later opt-in', async () => {
  const h = harness();
  h.client.init(config);
  await h.loaded();
  const oldConfig = h.sdkConfig!;
  const oldFetchOptions = oldConfig.fetch_options as RequestInit;
  assert.equal(oldFetchOptions.signal?.aborted, false);
  h.client.pageview('/history');
  h.storageChange('0');
  assert.equal(oldFetchOptions.signal?.aborted, true);
  h.client.setEnabled(true);
  await h.loaded();
  assert.notEqual(h.sdkConfig?.fetch_options, oldFetchOptions);
  assert.equal((h.sdkConfig?.fetch_options as RequestInit).signal?.aborted, false);
  // The native fetch boundary rejects retained request options before dispatch,
  // even if an SDK retry runs after a new consent epoch has started.
  await assert.rejects(fetch('data:text/plain,retired-telemetry', oldFetchOptions), {
    name: 'AbortError'
  });
  assert.equal(typeof oldConfig.before_send, 'function');
  if (typeof oldConfig.before_send === 'function')
    assert.equal(oldConfig.before_send(event('$pageview', {})), null);
});

test('shared cookie immediately blocks another tab when localStorage is unavailable', async () => {
  let cookie = '';
  const tabs = [0, 1].map(() => {
    let listener: (key: string | null, value: string | null) => void = () => {};
    let options: Partial<PostHogConfig> = {};
    const calls: string[] = [];
    const sdk = {
      init(_key: string, value: Partial<PostHogConfig>) {
        options = value;
      },
      capture() {
        calls.push('capture');
      },
      captureException() {
        calls.push('error');
      },
      opt_in_capturing() {},
      opt_out_capturing() {
        calls.push('out');
      },
      startSessionRecording() {},
      stopSessionRecording() {
        calls.push('stop');
      }
    } as unknown as Awaited<ReturnType<Parameters<typeof createTelemetry>[1]>>;
    const client = createTelemetry(
      {
        origin,
        storage: {
          getItem() {
            throw new Error('denied');
          },
          setItem() {
            throw new Error('denied');
          }
        },
        readCookie: () => cookie,
        writeCookie: (value) => {
          cookie = value;
        },
        listenStorage(value) {
          listener = value;
        },
        listenErrors() {}
      },
      async () => sdk
    );
    client.init(config);
    return {
      client,
      calls,
      get options() {
        return options;
      },
      refreshCookie() {
        listener(TELEMETRY_STORAGE_KEY, '0');
      }
    };
  });
  await new Promise((resolve) => setImmediate(resolve));
  tabs[0].client.setEnabled(false);
  assert.equal(tabs[1].client.enabled(), false);
  tabs[1].client.pageview('/history');
  assert.equal(tabs[1].calls.includes('capture'), false);
  const beforeSend = tabs[1].options.before_send;
  assert.equal(typeof beforeSend, 'function');
  if (typeof beforeSend === 'function') assert.equal(beforeSend(event('$pageview', {})), null);
  tabs[1].refreshCookie();
  assert.deepEqual(tabs[1].calls.slice(-2), ['out', 'stop']);
});
