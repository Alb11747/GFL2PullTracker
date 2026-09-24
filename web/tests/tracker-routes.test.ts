import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match } from '../src/params/trackerSection.ts';

test('main page matcher accepts exactly the public panel slugs', () => {
  for (const slug of ['history', 'backup', 'profiles', 'statistics', 'privacy', 'about']) {
    assert.equal(match(slug), true, slug);
  }
  for (const slug of ['', 'tracker', 'History', 'unknown', 'privacy-policy', 'api', 'guides', 'history/extra']) {
    assert.equal(match(slug), false, slug);
  }
});
