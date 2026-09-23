import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from 'posthog-js';
import {
  createLocalDiagnostics,
  LOCAL_DIAGNOSTICS_MUTED_KEY
} from '../src/lib/telemetry/local-diagnostics.ts';

const origin = 'https://tracker.example';
const config = { available: true, key: 'phc_test', release: 'a'.repeat(40), environment: 'test' };
function fixture(
  options: {
    storage?: Map<string, string>;
    send?: (payload: CaptureResult) => Promise<void>;
    now?: () => number;
  } = {}
) {
  const storage = options.storage ?? new Map<string, string>();
  const sent: CaptureResult[] = [];
  const diagnostics = createLocalDiagnostics({
    origin,
    now: options.now,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      }
    },
    send:
      options.send ??
      (async (payload) => {
        sent.push(payload);
      })
  });
  diagnostics.configure(config);
  return { diagnostics, sent, storage };
}
function error(line = 7) {
  const value = new TypeError('SECRET_CAPTURE', { cause: new Error('SECRET_CAUSE') });
  value.stack = `TypeError: SECRET_CAPTURE\n    at SECRET_ACCOUNT (${origin}/_app/immutable/chunks/app.js?SECRET_QUERY:${line}:3)\n    at https://secret.invalid/private.js:1:1`;
  return value;
}

test('diagnostics stay local until one explicit sanitized report is sent', async () => {
  const { diagnostics, sent } = fixture();
  const states: unknown[] = [];
  const unsubscribe = diagnostics.subscribe((state) => states.push(state));
  diagnostics.pageview('/history?SECRET_ACCOUNT#SECRET_CAPTURE');
  diagnostics.operation('import', 'failed', 12.6);
  diagnostics.report(error(), 'import');
  assert.equal(sent.length, 0);
  assert.equal(diagnostics.state.pending, true);
  assert.equal(JSON.stringify(states).includes('SECRET'), false);
  await diagnostics.sendReport();
  assert.equal(sent.length, 1);
  const payload = sent[0];
  assert.equal(payload.event, '$exception');
  assert.equal(payload.properties.distinct_id, payload.uuid);
  assert.equal(payload.properties.$pathname, '/history');
  assert.equal(payload.properties.operation, 'import');
  assert.equal(payload.properties.report_mode, 'user_submitted');
  assert.equal(payload.properties.$process_person_profile, false);
  assert.equal(payload.properties.$geoip_disable, true);
  assert.equal(JSON.stringify(payload).includes('SECRET'), false);
  assert.equal(JSON.stringify(payload).includes('secret.invalid'), false);
  assert.deepEqual(payload.properties.recent_activity, [
    { type: 'pageview', path: '/history' },
    { type: 'operation', operation: 'import', outcome: 'failed', duration_ms: 13 }
  ]);
  assert.equal(diagnostics.state.status, 'sent');
  diagnostics.report(error(8));
  await diagnostics.sendReport();
  assert.notEqual(sent[1].properties.distinct_id, payload.properties.distinct_id);
  unsubscribe();
});

test('only the latest twenty allowlisted breadcrumbs are frozen at the error', async () => {
  const { diagnostics, sent } = fixture();
  for (let i = 0; i < 25; i++) diagnostics.operation('backup', 'success', i);
  diagnostics.operation('SECRET' as never, 'failed', 2);
  diagnostics.operation('import', 'SECRET' as never, 2);
  diagnostics.report(error());
  diagnostics.pageview('/privacy');
  diagnostics.operation('restore', 'success', 999);
  await diagnostics.sendReport();
  const breadcrumbs = sent[0].properties.recent_activity as { duration_ms: number }[];
  assert.equal(breadcrumbs.length, 20);
  assert.equal(breadcrumbs[0].duration_ms, 5);
  assert.equal(breadcrumbs.at(-1)?.duration_ms, 24);
  assert.equal(JSON.stringify(breadcrumbs).includes('/privacy'), false);
});

test('double sends coalesce and errors during a send cannot join the approved report', async () => {
  let complete!: () => void;
  const sent: CaptureResult[] = [];
  const { diagnostics } = fixture({
    send: (payload) => {
      sent.push(payload);
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    }
  });
  diagnostics.report(error());
  const sending = diagnostics.sendReport();
  assert.equal(diagnostics.state.sending, true);
  await diagnostics.sendReport();
  diagnostics.report(error(99));
  complete();
  await sending;
  assert.equal(sent.length, 1);
  assert.equal(diagnostics.state.pending, false);
});

test('dismiss this time clears context and repeated errors without disabling later prompts', () => {
  const { diagnostics, sent } = fixture();
  diagnostics.pageview('/history');
  diagnostics.report(error());
  diagnostics.dismiss();
  assert.equal(diagnostics.state.muted, false);
  diagnostics.report(error());
  assert.equal(diagnostics.state.pending, false);
  diagnostics.report(error(8));
  assert.equal(diagnostics.state.pending, true);
  assert.equal(sent.length, 0);
});

test('dismiss this time suppresses an immediate error storm but allows the same error after a minute', () => {
  let timestamp = 0;
  const { diagnostics, sent } = fixture({ now: () => timestamp });
  diagnostics.report(error());
  diagnostics.dismiss();
  for (timestamp = 0; timestamp < 60_000; timestamp += 1_000) {
    diagnostics.report(error());
    assert.equal(diagnostics.state.pending, false);
  }
  diagnostics.report(error());
  assert.equal(diagnostics.state.pending, true);
  assert.equal(diagnostics.state.muted, false);
  assert.equal(sent.length, 0);
});

test('forever dismissal persists across reloads and can explicitly be restored', () => {
  const { diagnostics, storage } = fixture();
  diagnostics.report(error());
  diagnostics.dismiss(true);
  assert.equal(storage.get(LOCAL_DIAGNOSTICS_MUTED_KEY), '1');
  assert.equal(diagnostics.state.pending, false);
  const reload = fixture({ storage }).diagnostics;
  reload.report(error());
  assert.equal(reload.state.muted, true);
  assert.equal(reload.state.pending, false);
  reload.restorePrompts();
  reload.report(error());
  assert.equal(reload.state.pending, true);
  assert.equal(storage.get(LOCAL_DIAGNOSTICS_MUTED_KEY), '0');
});

test('unavailable configuration clears reports and context without transmission', async () => {
  const { diagnostics, sent } = fixture();
  diagnostics.pageview('/history');
  diagnostics.report(error());
  diagnostics.configure({ ...config, available: false });
  await diagnostics.sendReport();
  diagnostics.report(error(8));
  assert.equal(diagnostics.state.pending, false);
  assert.equal(sent.length, 0);
  diagnostics.configure(config);
  diagnostics.report(error(9));
  await diagnostics.sendReport();
  assert.deepEqual(sent[0].properties.recent_activity, []);
});

test('an uncertain send is terminal and cannot be retried automatically or by another click', async () => {
  let requests = 0;
  const { diagnostics } = fixture({
    send: async () => {
      requests++;
      throw new Error('Network response lost');
    }
  });
  diagnostics.report(error());
  await diagnostics.sendReport();
  assert.equal(diagnostics.state.status, 'uncertain');
  assert.equal(diagnostics.state.pending, false);
  await diagnostics.sendReport();
  diagnostics.report(error());
  await diagnostics.sendReport();
  assert.equal(requests, 1);
});

test('cross-tab mute clears pending reports and storage clearing does not unmute', async () => {
  const { diagnostics, sent } = fixture();
  diagnostics.report(error());
  diagnostics.storageChanged('unrelated', '1');
  assert.equal(diagnostics.state.pending, true);
  diagnostics.storageChanged(LOCAL_DIAGNOSTICS_MUTED_KEY, '1');
  assert.equal(diagnostics.state.muted, true);
  assert.equal(diagnostics.state.pending, false);
  diagnostics.storageChanged(null, null);
  diagnostics.report(error(8));
  await diagnostics.sendReport();
  assert.equal(sent.length, 0);
  diagnostics.storageChanged(LOCAL_DIAGNOSTICS_MUTED_KEY, '0');
  diagnostics.report(error(9));
  assert.equal(diagnostics.state.pending, true);
});

test('unavailable storage preserves session mute and hostile errors cannot break reporting', () => {
  const diagnostics = createLocalDiagnostics({
    origin,
    storage: {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      }
    },
    send: async () => {
      throw new Error('must not send');
    }
  });
  diagnostics.configure(config);
  const hostile = {
    get name() {
      throw new Error('SECRET');
    }
  };
  assert.doesNotThrow(() => diagnostics.report(hostile));
  diagnostics.report(new DOMException('SECRET', 'AbortError'));
  assert.equal(diagnostics.state.pending, false);
  diagnostics.dismiss(true);
  diagnostics.report(error());
  assert.equal(diagnostics.state.muted, true);
  assert.equal(diagnostics.state.pending, false);
  diagnostics.restorePrompts();
  diagnostics.report(error());
  assert.equal(diagnostics.state.pending, true);
});

test('muting during a send cannot resurrect its completion notice', async () => {
  let complete!: () => void;
  const { diagnostics } = fixture({
    send: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  });
  diagnostics.report(error());
  const sending = diagnostics.sendReport();
  diagnostics.dismiss(true);
  complete();
  await sending;
  assert.deepEqual(diagnostics.state, {
    muted: true,
    pending: false,
    sending: false,
    status: 'idle'
  });
});
