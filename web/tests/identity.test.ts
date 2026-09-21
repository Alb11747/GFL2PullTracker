import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentity, type GoogleIdentity } from '../src/lib/sync/identity.ts';

test('identity loader shares a bounded script request and retries stalls, errors, and incomplete loads', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = ['window', 'document'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  const browser: { google?: GoogleIdentity } = {};
  const scripts: Array<{
    src: string;
    async: boolean;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    removed: boolean;
    remove(): void;
  }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        return {
          src: '',
          async: false,
          onload: null,
          onerror: null,
          removed: false,
          remove() {
            this.removed = true;
          }
        };
      },
      head: {
        append(script: (typeof scripts)[number]) {
          scripts.push(script);
        }
      }
    }
  });
  try {
    const first = loadIdentity(),
      shared = loadIdentity();
    assert.equal(first, shared);
    assert.equal(scripts.length, 1);
    const stalled = assert.rejects(first, /could not load/);
    const lateLoad = scripts[0].onload!;
    context.mock.timers.tick(14_999);
    assert.equal(scripts[0].removed, false);
    context.mock.timers.tick(1);
    await stalled;
    assert.equal(scripts[0].removed, true);
    assert.equal(scripts[0].onload, null);
    const retry = loadIdentity();
    const failed = assert.rejects(retry, /could not load/);
    assert.equal(scripts.length, 2);
    lateLoad(); // An obsolete event must not settle or reset the new attempt.
    assert.equal(loadIdentity(), retry);
    scripts[1].onerror!();
    await failed;
    const missing = loadIdentity();
    const missingRejected = assert.rejects(missing, /could not load/);
    scripts[2].onload!();
    await missingRejected;
    assert.equal(scripts[2].removed, true);
    const loaded = loadIdentity();
    browser.google = {
      accounts: {
        oauth2: {
          initTokenClient() {
            return { requestAccessToken() {} };
          }
        }
      }
    };
    scripts[3].onload!();
    assert.equal(await loaded, browser.google);
    context.mock.timers.tick(30_000);
    assert.equal(scripts[3].removed, false);
    assert.equal(await loadIdentity(), browser.google);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
