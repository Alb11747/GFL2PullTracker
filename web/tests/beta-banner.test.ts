import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const template = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
const bootstrap = template.match(/<script nonce="%sveltekit.nonce%">([\s\S]*?)<\/script>/)![1];

test('beta dismissal is applied before body parsing and tolerates unavailable storage', () => {
  assert.ok(template.indexOf(bootstrap) < template.indexOf('<body'));
  for (const preference of [null, '0', '1', 'blocked']) {
    const dataset: Record<string, string> = {};
    runInNewContext(bootstrap, {
      document: { documentElement: { dataset } },
      sessionStorage: { getItem(key: string) {
        assert.equal(key, 'gfl2.beta-banner-dismissed');
        if (preference === 'blocked') throw new Error('Storage unavailable');
        return preference;
      } }
    });
    assert.equal(dataset.betaDismissed, preference === '1' ? 'true' : undefined);
  }
});
