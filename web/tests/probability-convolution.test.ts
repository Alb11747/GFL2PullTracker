import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acquisition,
  COUNT_TAIL_LIMIT,
  MAX_COEFFICIENTS,
  MAX_COUNT_BUDGET,
  MODELS,
  mean,
  pmf,
  power,
  rewardCounts,
  sum
} from '../src/lib/statistics/probability.ts';

function close(actual: number, expected: number, tolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function convolve(a: Float64Array, b: Float64Array): Float64Array {
  const result = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) result[i + j] += a[i] * b[j];
  }
  return result;
}

function direct(base: Float64Array, count: number): Float64Array {
  let result: Float64Array = Float64Array.of(1);
  for (let i = 0; i < count; i++) result = convolve(result, base);
  return result;
}

test('waiting-time FFT agrees with direct convolution through 101 rewards', () => {
  for (const p of Object.values(MODELS)) {
    const base = pmf(p);
    for (const count of [0, 1, 101]) {
      const actual = power(base, count),
        expected = direct(base, count);
      assert.equal(actual.length, expected.length);
      actual.forEach((value, i) => close(value, expected[i]));
      close(sum(actual), 1);
      close(mean(actual), count * mean(base), 1e-7);
    }
    const featured = convolve(base, base).map(
      (value, i) => value * (1 - p.p) + (base[i] || 0) * p.p
    );
    const actual = acquisition({
      p,
      intervals: [20, 30],
      featuredIntervals: [40, 70],
      wins: { wins: 2, trials: 4 }
    });
    for (const [metric, reference] of [
      [actual.elite, direct(base, 2)],
      [actual.featured, direct(featured, 2)],
      [actual.wins, direct(Float64Array.of(1 - p.p, p.p), 4)]
    ] as const) {
      assert.equal(metric.missing, false);
      metric.dist.forEach((value, i) => close(value, reference[i]));
    }
  }
});

test('largest supported waiting distributions retain full support and correct means', () => {
  for (const p of Object.values(MODELS)) {
    const base = pmf(p);
    for (const count of [1000, Math.floor((MAX_COEFFICIENTS - 1) / p.max)]) {
      const dist = power(base, count);
      assert.equal(dist.length, p.max * count + 1);
      assert.ok(dist.every((value) => Number.isFinite(value) && value >= 0));
      assert.ok(dist.slice(0, count).every((value) => value === 0));
      close(sum(dist), 1);
      close(mean(dist), count * mean(base), 1e-5);
    }
  }
  for (const rate of [0, 1]) {
    const dist = power(Float64Array.of(1 - rate, rate), 1000);
    close(sum(dist), 1);
    close(mean(dist), 1000 * rate, 1e-7);
  }
  assert.throws(() => power(pmf(MODELS.dolls), 4000), { code: 'HISTORY_TOO_LARGE' });
});

test('finite-budget rewards retain exact deterministic counts and bounded omitted tails', () => {
  for (const budget of [0, 1, 2, 3, 10, MAX_COUNT_BUDGET]) {
    const result = rewardCounts(Float64Array.of(0, 0, 1), budget);
    assert.equal(result.dist[Math.floor(budget / 2)], 1);
    assert.equal(result.expected, Math.floor(budget / 2));
    assert.equal(result.omittedMassBound, 0);
  }
  const base = pmf(MODELS.dolls);
  for (const budget of [3540, 10967]) {
    const result = rewardCounts(base, budget);
    assert.equal(result.approximation, 'bounded-renewal');
    assert.ok(result.omittedMassBound <= COUNT_TAIL_LIMIT);
    close(sum(result.dist), 1, 1e-8);
    close(mean(result.dist), result.expected, result.expectedErrorBound + 1e-6);
  }
  assert.throws(() => rewardCounts(Float64Array.of(0, 1), MAX_COUNT_BUDGET + 1), {
    code: 'COUNT_CAPACITY'
  });
  assert.throws(() => rewardCounts(Float64Array.of(0, 0.5, 0.5), -1), { code: 'INVALID_INPUT' });
  assert.throws(() => rewardCounts(Float64Array.of(1), 1), { code: 'INVALID_INPUT' });
  const costly = new Float64Array(1001);
  costly[1] = 0.999;
  costly[1000] = 0.001;
  assert.throws(() => rewardCounts(costly, MAX_COUNT_BUDGET), { code: 'COUNT_CAPACITY' });
});
