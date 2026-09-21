import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePaginationAnchor } from '../src/lib/pagination-anchor.ts';

function setup(top = 500) {
  const position = { top, connected: true };
  const scrolls: ScrollToOptions[] = [];
  const button = {
    getBoundingClientRect: () => ({ top: position.top, bottom: position.top + 40 }),
    get isConnected() {
      return position.connected;
    }
  } as HTMLElement;
  const viewport = {
    innerHeight: 800,
    scrollBy: (options: ScrollToOptions) => scrolls.push(options)
  };
  return { position, scrolls, capture: () => capturePaginationAnchor(button, viewport) };
}

test('keeps the pager in place when a new page is taller or shorter', () => {
  for (const difference of [250, -300]) {
    const { position, scrolls, capture } = setup();
    const restore = capture();
    position.top += difference;
    restore();
    assert.deepEqual(scrolls, [{ top: difference, behavior: 'instant' }]);
  }
});

test('does not double-adjust native scroll anchoring or subpixel rounding', () => {
  const { position, scrolls, capture } = setup();
  const restore = capture();
  restore();
  position.top += 0.5;
  restore();
  assert.deepEqual(scrolls, []);
});

test('leaves the user where they scrolled when the pager is outside the viewport', () => {
  for (const top of [-50, 800]) {
    const { position, scrolls, capture } = setup(top);
    const restore = capture();
    position.top = 500;
    restore();
    assert.deepEqual(scrolls, []);
  }
});

test('does not restore an anchor removed by navigation or filtering', () => {
  const { position, scrolls, capture } = setup();
  const restore = capture();
  position.connected = false;
  position.top += 100;
  restore();
  assert.deepEqual(scrolls, []);
});
