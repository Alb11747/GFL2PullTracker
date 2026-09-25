import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distribution,
  distributionBins,
  observed,
  observedBins,
  niceTicks,
  xTicks
} from '../src/lib/statistics/charts.ts';
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
test('distribution bins preserve exact discrete event boundaries including ties', () => {
  const uniform = Array<number>(101).fill(1 / 101);
  for (const direction of ['lower', 'upper'] as const) {
    const d = distributionBins(uniform, 43, direction)!;
    assert.ok(d.bins.some((b) => b.lo === 43 && b.hi === 43 && b.observed));
    close(
      d.bins.reduce((s, b) => s + b.mass, 0),
      1
    );
    const event = direction === 'lower' ? 44 / 101 : 58 / 101;
    close(d.eventMass!, event);
    close(
      d.bins.filter((b) => b.event).reduce((s, b) => s + b.mass, 0),
      event
    );
    assert.ok(d.bins.every((b) => !b.event || (direction === 'lower' ? b.hi <= 43 : b.lo >= 43)));
  }
  for (const direction of ['lower', 'upper'] as const)
    close(
      distributionBins(uniform, 43.5, direction)!.eventMass!,
      direction === 'lower' ? 44 / 101 : 57 / 101
    );
  for (const observation of [-1, 200])
    for (const direction of ['lower', 'upper'] as const) {
      const html = distribution({ dist: uniform, observation, direction });
      assert.match(html, /outside plotted range/);
      assert.doesNotMatch(html, /NaN/);
    }
  assert.deepEqual(distributionBins([0, 0, 1], 2)!.bins, [
    { lo: 2, hi: 2, mass: 1, event: true, observed: true }
  ]);
  for (const invalid of [[], [0, 0], [0.5, -0.1]]) assert.equal(distributionBins(invalid), null);
});
test('cropped chart tails retain full probability and offscreen means remain textual', () => {
  const tails = Array<number>(100).fill(0);
  tails[0] = 0.0001;
  tails[50] = 0.9998;
  tails[99] = 0.0001;
  const d = distributionBins(tails)!;
  close(d.bins.reduce((s, b) => s + b.mass, 0) + d.croppedLow + d.croppedHigh, 1);
  assert.match(distribution({ dist: tails, expected: 50 }), /Cropped tails:/);
  const html = distribution({ dist: tails, expected: 49.5, planner: true });
  assert.match(html, /Model mean: 49.5 \(outside plotted range\)/);
  assert.doesNotMatch(html, /stroke-dasharray/);
  const concentrated = Array<number>(16).fill(0);
  concentrated[2] = 0.1;
  concentrated[3] = 0.4;
  concentrated[4] = 0.4;
  concentrated[5] = 0.099999999999;
  concentrated[15] = 1e-12;
  const c = distributionBins(concentrated, null, 'lower', true)!;
  assert.equal(c.lo, 2);
  assert.equal(c.hi, 5);
  assert.deepEqual(xTicks(1609, 1877), [1700, 1800]);
  assert.deepEqual(xTicks(1, 80, true), [1, 20, 40, 60, 80]);
  assert.deepEqual(niceTicks(0.18), [0, 0.05, 0.1, 0.15, 0.2]);
});
test('chart labels are escaped and planner contains no observed or luck annotations', () => {
  const html = distribution({
    key: 'a11y',
    title: 'Pulls <img src=x onerror=alert(1)>',
    axisLabel: '<script>unsafe</script>',
    dist: new Float64Array([0.1, 0.2, 0.7]),
    observation: 1,
    expected: 1.6
  });
  for (const text of [
    'role="img"',
    'aria-labelledby="mc-a11y-title mc-a11y-desc"',
    'Probability per bin',
    '30% probability',
    '<details',
    '<table',
    '<caption',
    '&lt;img',
    '&lt;script'
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<img|<script|<text/);
  const planner = distribution({
    dist: [0.1, 0.6, 0.3],
    expected: 1.2,
    observation: 2,
    tail: 0.3,
    planner: true
  });
  assert.doesNotMatch(planner, /Observed:|At most the observation/);
  assert.match(planner, /Central 90% model range/);
  assert.doesNotMatch(distribution({ dist: [1], expected: 0, planner: true }), /NaN/);
});
test('observed histogram preserves intervals outside model and muted dashed expectation', () => {
  const pmf = Array<number>(81).fill(0);
  pmf[1] = 0.2;
  pmf[80] = 0.8;
  const d = observedBins([1, 5, 6, 80, 83], pmf, 80);
  assert.equal(d.hi, 83);
  assert.equal(d.bins.length, 17);
  assert.deepEqual(d.bins[0], { lo: 1, hi: 5, count: 2, expected: 1 });
  close(
    d.bins.reduce((s, b) => s + b.count, 0),
    5
  );
  close(
    d.bins.reduce((s, b) => s + (b.expected ?? 0), 0),
    5
  );
  const html = observed({ intervals: [1, 5, 80, 83], modelPmf: pmf, max: 80, soft: 59 });
  for (const text of [
    'Model expected count',
    'Soft-pity region',
    '1 to 83',
    'Axis extended',
    'Expected outline equals',
    'Observed mean',
    'stroke="#78848e" stroke-width="1" stroke-dasharray="3 3"'
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(observed({ intervals: [1], max: 80 }), /Model expected count/);
  assert.match(observed({ intervals: [] }), /No complete intervals/);
});
