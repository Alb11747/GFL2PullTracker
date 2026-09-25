import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planner,
  summary,
  acquisition,
  residualElite,
  pmf,
  sum,
  mean,
  MAX_COUNT_BUDGET
} from '../src/lib/statistics/probability.ts';
import type {
  PlannerInput,
  ProbabilityMetric,
  ProbabilityParameters
} from '../src/lib/statistics/probability-types.ts';
const close = (a: number, b: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

// Independent Markov state enumeration advances one pull at a time. It uses
// neither renewal convolutions nor the worker's conditional-wait helper.
function enumerate(
  p: ProbabilityParameters,
  budget: number,
  initialPity: number,
  initialGuarantee: boolean,
  featured: boolean
): Float64Array {
  let states = new Map([[`${initialPity},${Number(initialGuarantee)},0`, 1]]);
  for (let t = 0; t < budget; t++) {
    const next = new Map<string, number>();
    const add = (pity: number, guarantee: number, count: number, mass: number) => {
      if (!mass) return;
      const key = `${pity},${guarantee},${count}`;
      next.set(key, (next.get(key) || 0) + mass);
    };
    for (const [key, mass] of states) {
      const [oldPity, guarantee, count] = key.split(',').map(Number),
        pity = oldPity + 1;
      const hazard =
        pity < p.soft ? p.base : p.base + ((1 - p.base) * (pity - p.soft)) / (p.max - p.soft);
      add(pity, guarantee, count, mass * (1 - hazard));
      if (!featured || guarantee) add(0, 0, count + 1, mass * hazard);
      else {
        add(0, 0, count + 1, mass * hazard * p.p);
        add(0, 1, count, mass * hazard * (1 - p.p));
      }
    }
    states = next;
  }
  const result = new Float64Array(budget + 1);
  for (const [key, mass] of states) result[Number(key.split(',')[2])] += mass;
  return result;
}
function referenceQuantile(dist: Float64Array, probability: number): number {
  let cdf = 0;
  for (let k = 0; k < dist.length; k++) if ((cdf += dist[k]) >= probability) return k;
  assert.fail('Missing reference quantile');
}
function check(actual: ProbabilityMetric, expected: Float64Array): void {
  assert.equal(actual.missing, false, JSON.stringify(actual.error));
  assert.ok(actual.dist.every((v) => Number.isFinite(v) && v >= 0));
  for (let k = 0; k < expected.length; k++) close(actual.dist[k] || 0, expected[k], 3e-10);
  close(sum(actual.dist), 1, (actual.omittedMassBound ?? 0) + 1e-9);
  close(actual.expected, mean(expected));
  close(actual.chanceAtLeastOne!, 1 - expected[0]);
  assert.equal(actual.low, referenceQuantile(expected, 0.05));
  assert.equal(actual.high, referenceQuantile(expected, 0.95));
}
test('168 conditional-pity and guarantee cases match independent per-pull enumeration', () => {
  let cases = 0;
  for (const rate of [0, 0.35, 1]) {
    const p = { base: 0.2, soft: 2, max: 4, p: rate };
    for (const pity of [0, 1, 2, 3]) {
      const unconditional = pmf(p),
        conditional = residualElite(p, pity);
      const survival = sum(unconditional.slice(pity + 1));
      for (let s = 1; s < conditional.length; s++)
        close(conditional[s], unconditional[pity + s] / survival);
      for (const guaranteed of [false, true])
        for (const budget of [0, 1, 2, 4, 9, 20, 40]) {
          const actual = planner({ p, budget, startingPity: pity, guaranteed });
          check(actual.elite, enumerate(p, budget, pity, guaranteed, false));
          check(actual.featured, enumerate(p, budget, pity, guaranteed, true));
          cases++;
        }
    }
  }
  assert.equal(cases, 168);
});
const doll = { soft: 59, max: 80, base: 0.006, p: 0.5 };
const weapon = { soft: 51, max: 70, base: 0.007, p: 0.75 };
test('eight maximum-budget combinations retain bounded mass, exact renewal means and quantiles', () => {
  for (const p of [doll, weapon])
    for (const startingPity of [0, p.max - 1])
      for (const guaranteed of [false, true]) {
        const result = planner({ p, budget: MAX_COUNT_BUDGET, startingPity, guaranteed });
        for (const metric of Object.values(result)) {
          assert.equal(metric.missing, false, JSON.stringify(metric.error));
          assert.ok(metric.omittedMassBound! <= 1e-12);
          close(sum(metric.dist), 1, 1e-8);
          close(mean(metric.dist), metric.expected, metric.expectedErrorBound! + 1e-6);
          assert.ok(metric.low! <= metric.expected && metric.high! >= metric.expected);
        }
      }
});
test('planner edges, input validation and per-metric capacity isolation', () => {
  const guaranteeEdge = planner({
    p: { ...doll, p: 0 },
    budget: 1,
    startingPity: 79,
    guaranteed: true
  });
  assert.equal(guaranteeEdge.featured.dist[1], 1);
  const noGuaranteeEdge = planner({
    p: { ...doll, p: 0 },
    budget: 1,
    startingPity: 79,
    guaranteed: false
  });
  assert.equal(noGuaranteeEdge.featured.dist[0], 1);
  const zero = planner({ p: doll, budget: 0, startingPity: 79, guaranteed: true });
  for (const metric of Object.values(zero)) {
    assert.deepEqual(Array.from(metric.dist), [1]);
    assert.equal(metric.expected, 0);
    assert.equal(metric.low, 0);
    assert.equal(metric.high, 0);
  }
  for (const args of [
    { budget: 20001 },
    { budget: -1 },
    { budget: 1.5 },
    { startingPity: 80 },
    { startingPity: -1 },
    { guaranteed: 'yes' }
  ]) {
    for (const metric of Object.values(planner({ p: doll, budget: 5, ...args } as PlannerInput)))
      assert.ok(metric.error);
  }
  const isolated = summary({
    p: doll,
    windows: {
      elite: { budget: 20001, count: 1 },
      featured: { budget: 100, count: 1, startingPity: 70, guaranteed: true }
    },
    wins: { wins: 1, trials: 3 }
  });
  assert.equal(isolated.elite.error?.code, 'COUNT_CAPACITY');
  assert.equal(isolated.featured.missing, false);
  assert.equal(isolated.wins.missing, false);
  close(isolated.wins.tail!, 0.875);
  // A deterministic Elite process is cheap even when its featured process
  // exceeds the FFT work limit: the planner must preserve the valid metric.
  const splitCapacity = planner({
    p: { base: 1, soft: 2, max: 4, p: 0.5 },
    budget: MAX_COUNT_BUDGET
  });
  assert.equal(splitCapacity.elite.missing, false);
  assert.equal(splitCapacity.elite.expected, MAX_COUNT_BUDGET);
  assert.equal(splitCapacity.featured.error?.code, 'COUNT_CAPACITY');
});
test('summary tails and acquisition samples are independently available', () => {
  const small = { base: 0.2, soft: 2, max: 4, p: 0.35 };
  const window = { budget: 20, count: 3, startingPity: 2, guaranteed: true };
  const counts = summary({ p: small, windows: { elite: window, featured: window }, wins: null });
  for (const key of ['elite', 'featured'] as const) {
    const reference = enumerate(small, 20, 2, true, key === 'featured');
    close(counts[key].tail!, sum(reference.slice(3)));
    assert.equal(counts[key].count, 3);
    assert.equal(counts[key].budget, 20);
  }
  assert.equal(counts.wins.missing, true);
  const acquisitionResult = acquisition({
    p: doll,
    intervals: [20, 30],
    featuredIntervals: [40, 70],
    wins: { wins: 1, trials: 3 }
  });
  assert.equal(acquisitionResult.elite.count, 2);
  assert.equal(acquisitionResult.featured.budget, 110);
  close(acquisitionResult.elite.expected, 2 * mean(pmf(doll)));
  close(acquisitionResult.featured.expected, 3 * mean(pmf(doll)));
  const capacity = acquisition({
    p: doll,
    intervals: [20],
    featuredIntervals: Array(2000).fill(40),
    wins: { wins: 1, trials: 2 }
  });
  assert.equal(capacity.featured.error?.code, 'HISTORY_TOO_LARGE');
  assert.equal(capacity.elite.missing, false);
  assert.equal(capacity.wins.missing, false);
  const absent = acquisition({
    p: doll,
    intervals: [],
    featuredIntervals: null,
    wins: { wins: 0, trials: 0 }
  });
  assert.ok(Object.values(absent).every((metric) => metric.missing && !metric.error));
});
