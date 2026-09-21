import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestTelemetryAllowed,
  safeServerError,
  sanitizeServerEvent
} from '../src/lib/telemetry/server-policy.ts';
import { createServerTelemetry } from '../src/lib/telemetry/server.ts';
import { PostHog } from 'posthog-node';
import { forward } from '../src/lib/proxy.ts';

test('request telemetry defaults on and fails closed for conflicting or malformed preferences', () => {
  assert.equal(requestTelemetryAllowed(new Headers()), true);
  assert.equal(
    requestTelemetryAllowed(new Headers({ cookie: 'gfl2_telemetry=1', 'x-gfl2-telemetry': '1' })),
    true
  );
  for (const headers of [
    { cookie: 'gfl2_telemetry=0' },
    { cookie: 'gfl2_telemetry=1; gfl2_telemetry=0' },
    { cookie: 'gfl2_telemetry=secret' },
    { 'x-gfl2-telemetry': '0' },
    { 'x-gfl2-telemetry': '1, 0' },
    { 'x-gfl2-telemetry': 'true' },
    { dnt: '1' },
    { 'sec-gpc': '1' }
  ] as Record<string, string>[])
    assert.equal(requestTelemetryAllowed(new Headers(headers)), false);
});

test('server exceptions preserve only safe code locations and fixed text', () => {
  const error = new TypeError('SECRET capture?token=SECRET', { cause: new Error('SECRET') });
  error.stack =
    'TypeError: SECRET\n    at x (file:///app/build/server/chunks/api-abc.js:14:9)\n    at SECRET (https://game.example/SECRET:4:8)\n    at x (/private/SECRET.js:5:1)';
  const safe = safeServerError(error);
  assert.equal(safe.name, 'TypeError');
  assert.equal(safe.stack?.split('\n').length, 2);
  assert.match(safe.stack!, /api-abc\.js:14:9/);
  assert.equal(safe.cause, undefined);
  assert.doesNotMatch(safe.stack!, /SECRET|token|private|game\.example/);
  assert.doesNotThrow(() =>
    safeServerError({
      get stack() {
        throw Error('SECRET');
      }
    })
  );
});

const options = {
  mode: 'public' as const,
  publicOrigin: 'https://tracker.example',
  allowedBackends: ['http://api:8000'],
  clientAddress: '192.0.2.1'
};
function request(headers: Record<string, string> = {}) {
  return new Request('https://tracker.example/api/public/config', {
    headers: { host: 'tracker.example', ...headers }
  });
}

test('proxy sends only normalized telemetry preference and keeps the cookie private', async () => {
  for (const [headers, expected] of [
    [{}, '1'],
    [{ cookie: 'gfl2_telemetry=0' }, '0'],
    [{ 'x-gfl2-telemetry': 'secret, 1' }, '0']
  ] as [Record<string, string>, string][]) {
    await forward(
      request(headers),
      'http://api:8000',
      async (_url, init) => {
        const forwarded = new Headers(init?.headers);
        assert.equal(forwarded.get('x-gfl2-telemetry'), expected);
        assert.equal(forwarded.get('cookie'), null);
        return Response.json({});
      },
      options
    );
  }
});

test('only proxy transport failures report, once, unless opted out', async () => {
  let reports = 0;
  const monitored = {
    ...options,
    reportError() {
      reports++;
    }
  };
  const broken = async () => {
    throw new Error('synthetic transport error');
  };
  assert.equal((await forward(request(), 'http://api:8000', broken, monitored)).status, 503);
  assert.equal(reports, 1);
  await forward(request({ cookie: 'gfl2_telemetry=0' }), 'http://api:8000', broken, monitored);
  await forward(
    request(),
    'http://api:8000',
    async () => Response.json({}, { status: 500 }),
    monitored
  );
  await forward(
    request(),
    'http://api:8000',
    async () => Response.json({}, { status: 503 }),
    monitored
  );
  assert.equal(reports, 1);
  assert.equal(
    (
      await forward(request(), 'http://api:8000', broken, {
        ...options,
        reportError() {
          throw Error('SDK unavailable');
        }
      })
    ).status,
    503
  );
});

test('Node reporting is disabled outside configured public production and respects request opt-out', () => {
  const valid = {
    GFL2_MODE: 'public',
    PUBLIC_POSTHOG_KEY: 'phc_synthetic',
    PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com'
  };
  let created = 0;
  const factory = () => {
    created++;
    throw Error('must not construct');
  };
  for (const environment of [
    { ...valid, GFL2_MODE: 'local' },
    { ...valid, PUBLIC_POSTHOG_KEY: '' },
    { ...valid, PUBLIC_POSTHOG_HOST: 'https://other.example' },
    { ...valid, NODE_ENV: 'test' }
  ])
    createServerTelemetry(environment, factory).report(new Error('SECRET'), 'request', true);
  createServerTelemetry(valid, factory).report(new Error('SECRET'), 'request', false);
  assert.equal(created, 0);
});

test('Node SDK resolves injected chunk IDs and sends only allowlisted exception metadata', async () => {
  const chunk = '01234567-89ab-4cde-8fab-0123456789ab';
  const releaseId = '01234567-89ab-4cde-8fab-0123456789ac';
  const globals = globalThis as typeof globalThis & {
    _posthogChunkIds?: Record<string, string>;
    _posthogReleaseId?: string;
  };
  const previousChunks = globals._posthogChunkIds,
    previousRelease = globals._posthogReleaseId;
  globals._posthogChunkIds = {
    'Error\n    at file:///app/build/server/chunks/telemetry-test.js:1:1': chunk
  };
  globals._posthogReleaseId = releaseId;
  const batches: {
    batch: {
      event: string;
      properties: {
        $exception_list: { stacktrace: { frames: { chunk_id?: string; filename: string }[] } }[];
        $release_id?: string;
        release?: string;
        $process_person_profile?: boolean;
      };
    }[];
  }[] = [];
  let sdk: PostHog | undefined;
  let shutdown: (() => void) | undefined;
  const telemetry = createServerTelemetry(
    {
      GFL2_MODE: 'public',
      PUBLIC_POSTHOG_KEY: 'phc_synthetic',
      PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
      PUBLIC_APP_RELEASE: 'a'.repeat(40)
    },
    (key, options) => {
      sdk = new PostHog(key, {
        ...options,
        disableCompression: true,
        fetch: async (_url, init) => {
          batches.push(JSON.parse(String(init?.body)));
          return { status: 200, text: async () => '{}', json: async () => ({}) };
        }
      });
      return sdk;
    },
    (callback) => {
      shutdown = callback;
    }
  );
  try {
    const error = new TypeError('SECRET', { cause: new Error('SECRET') });
    error.stack =
      'TypeError: SECRET\n    at privateFunctionSECRET (file:///app/build/server/chunks/telemetry-test.js:14:9)\n    at SECRET (/private/SECRET.js:8:2)';
    telemetry.report(error, 'proxy', true);
    telemetry.report(error, 'proxy', true);
    telemetry.report(new Error('SECRET'), 'request', false);
    assert.ok(sdk);
    sdk.withContext(
      { distinctId: 'SECRET', sessionId: 'SECRET', properties: { capture: 'SECRET' } },
      () => {
        const second = new Error('SECRET');
        second.stack =
          'Error: SECRET\n    at x (file:///app/build/server/chunks/telemetry-test.js:20:3)';
        telemetry.report(second, 'request', true);
      }
    );
    await sdk.flush();
    const events = batches.flatMap((batch) => batch.batch);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.event, '$exception');
      const frame = event.properties.$exception_list[0].stacktrace.frames[0];
      assert.equal(frame.chunk_id, chunk);
      assert.equal(frame.filename, 'app:///build/server/chunks/telemetry-test.js');
      assert.equal(event.properties.$release_id, releaseId);
      assert.equal(event.properties.release, 'a'.repeat(40));
      assert.equal(event.properties.$process_person_profile, false);
      assert.doesNotMatch(
        JSON.stringify(event),
        /SECRET|context_line|pre_context|post_context|session_id/
      );
    }
    assert.equal(typeof shutdown, 'function');
  } finally {
    await sdk?.shutdown(1500);
    if (previousChunks === undefined) delete globals._posthogChunkIds;
    else globals._posthogChunkIds = previousChunks;
    if (previousRelease === undefined) delete globals._posthogReleaseId;
    else globals._posthogReleaseId = previousRelease;
  }
});

test('Node final send boundary drops context enrichment and rejects invalid chunk metadata', () => {
  const event = sanitizeServerEvent(
    {
      event: '$exception',
      distinctId: 'SECRET',
      groups: { account: 'SECRET' },
      properties: {
        capture: 'SECRET',
        $set: { email: 'SECRET' },
        $release_id: 'SECRET',
        $exception_list: [
          {
            type: 'SECRET',
            value: 'SECRET',
            stacktrace: {
              frames: [
                {
                  filename: 'build/server/chunks/api.js',
                  lineno: 2,
                  colno: 3,
                  chunk_id: 'SECRET',
                  function: 'SECRET',
                  context_line: 'SECRET'
                },
                { filename: '/private/SECRET.js', lineno: 1 }
              ]
            }
          }
        ]
      }
    },
    'SECRET'
  );
  assert.ok(event);
  assert.equal(event.properties?.release, 'unknown');
  assert.equal(event.properties?.$exception_list[0].stacktrace.frames.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /SECRET|context_line|groups/);
  assert.equal(sanitizeServerEvent({ event: 'anything', distinctId: 'SECRET' }, ''), null);
});
