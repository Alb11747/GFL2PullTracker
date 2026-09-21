import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('server error hook excludes client errors while preserving failures and opt-out', async () => {
  const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const telemetryUrl = moduleUrl(`
    export const reports = [];
    export function reportServerError(error, operation, allowed) {
      if (allowed) reports.push({ error, operation });
    }
  `);
  // Load the actual hook with its framework environment and external send boundary
  // replaced. The real request-preference policy still runs; no SDK can send data.
  const modules: Record<string, string> = {
    '$env/dynamic/private': moduleUrl('export const env = { GFL2_MODE: "local" };'),
    '$env/dynamic/public': moduleUrl('export const env = {};'),
    '$lib/proxy': moduleUrl('export function backendUrl() {}'),
    '$lib/telemetry/server': telemetryUrl,
    '$lib/telemetry/server-policy': new URL(
      '../src/lib/telemetry/server-policy.ts',
      import.meta.url
    ).href
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return modules[specifier]
        ? { url: modules[specifier], shortCircuit: true }
        : nextResolve(specifier, context);
    }
  });
  try {
    const { handleError } = await import('../src/hooks.server.ts');
    const { reports } = await import(telemetryUrl);
    const invoke = (status: number, headers: Record<string, string> = {}) => {
      const error = new Error('private request details');
      return handleError({
        error,
        status,
        message: 'Request failed',
        event: { request: new Request('https://tracker.example/unknown', { headers }) }
      } as Parameters<typeof handleError>[0]);
    };
    for (const status of [400, 401, 403, 404, 405, 429, 499]) await invoke(status);
    assert.equal(reports.length, 0, 'expected HTTP failures must not become server issues');
    for (const status of [500, 502, 503]) {
      assert.deepEqual(await invoke(status), {
        message: 'The tracker could not complete this request.'
      });
    }
    assert.equal(reports.length, 3, 'unexpected server failures still reach telemetry');
    assert.ok(reports.every((report: { operation: string }) => report.operation === 'request'));
    await invoke(500, { cookie: 'gfl2_telemetry=0' });
    await invoke(500, { dnt: '1' });
    assert.equal(reports.length, 3, 'server failures still honor the telemetry preference');
  } finally {
    hooks.deregister();
  }
});
