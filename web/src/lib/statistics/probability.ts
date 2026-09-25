import type {
  AcquisitionInput,
  HistoryProbabilityResult,
  PlannerInput,
  PlannerResult,
  ProbabilityError,
  ProbabilityMetric,
  ProbabilityParameters,
  ProbabilityRequest,
  ProbabilityResult,
  Reward,
  SummaryInput,
  WinsObservation
} from './probability-types.ts';
export { DEFAULT_PLANNER_BUDGET, DEFAULT_REWARD, MODELS } from './probability-types.ts';
export type * from './probability-types.ts';

interface RewardCountDistribution {
  dist: Float64Array;
  expected: number;
  omittedMassBound: number;
  expectedErrorBound: number;
  approximation: 'exact' | 'bounded-renewal';
}

export function probabilityError(error: unknown): ProbabilityError {
  if (error instanceof Error)
    return {
      code: 'code' in error && typeof error.code === 'string' ? error.code : 'MODEL_ERROR',
      message: error.message
    };
  return { code: 'MODEL_ERROR', message: 'The probability model could not be calculated.' };
}

// Zero-pity analytical distributions from Pull Calculations.py. Waiting-time
// FFTs retain full support. Reward counts report any bounded omitted tail.
export const MAX_COEFFICIENTS = 262145;
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
export function sum(values: readonly number[] | Float64Array): number {
  let result = 0;
  for (const value of values) result += value;
  return result;
}
export function mean(values: readonly number[] | Float64Array): number {
  let result = 0;
  for (let i = 0; i < values.length; i++) result += i * values[i];
  return result;
}

function checkedLength(degree: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0)
    fail('INVALID_INPUT', 'Acquisition counts must be nonnegative integers.');
  const length = degree * count + 1;
  if (!Number.isSafeInteger(length) || length > MAX_COEFFICIENTS) {
    fail(
      'HISTORY_TOO_LARGE',
      `This history needs ${length.toLocaleString()} probability values. The model supports at most ${MAX_COEFFICIENTS.toLocaleString()} per distribution; no history was discarded or approximated.`
    );
  }
  return length;
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width;
    const rootRe = Math.cos(angle),
      rootIm = Math.sin(angle),
      half = width / 2;
    for (let offset = 0; offset < n; offset += width) {
      let wr = 1,
        wi = 0;
      for (let j = 0; j < half; j++) {
        const a = offset + j,
          b = a + half;
        const br = re[b] * wr - im[b] * wi,
          bi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
        const nextRe = wr * rootRe - wi * rootIm;
        wi = wr * rootIm + wi * rootRe;
        wr = nextRe;
        // Long recurrence chains drift away from the unit circle. Reset the
        // twiddle periodically before exponentiation can amplify that error.
        if ((j & 63) === 63) {
          wr = Math.cos(angle * (j + 1));
          wi = Math.sin(angle * (j + 1));
        }
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
}

export function power(base: Float64Array, count: number): Float64Array {
  const length = checkedLength(base.length - 1, count);
  if (count === 0) return Float64Array.of(1);
  if (count === 1) return Float64Array.from(base);
  let size = 1;
  while (size < length) size *= 2;
  const re = new Float64Array(size),
    im = new Float64Array(size);
  re.set(base);
  fft(re, im, false);
  for (let i = 0; i < size; i++) {
    // Tiny Fourier magnitudes legitimately underflow for large counts. Integer
    // powers in polar form avoid unstable repeated complex multiplication.
    const radius = Math.hypot(re[i], im[i]);
    if (radius > 1 + 1e-8)
      fail('NUMERICAL_ERROR', 'The probability transform exceeded its numerical tolerance.');
    const magnitude = Math.pow(Math.min(1, radius), count);
    const angle = Math.atan2(im[i], re[i]) * count;
    re[i] = magnitude * Math.cos(angle);
    im[i] = magnitude * Math.sin(angle);
  }
  fft(re, im, true);
  const result = re.slice(0, length);
  let negativeMass = 0;
  // The exact distribution cannot occur below count times its first supported
  // index. Remove numerical leakage outside that mathematically known support.
  const first = base.findIndex((value) => value > 0),
    minimum = first * count;
  for (let i = 0; i < result.length; i++) {
    if (!Number.isFinite(result[i]))
      fail('NUMERICAL_ERROR', 'The probability calculation was not finite.');
    if (result[i] < 0) {
      negativeMass -= result[i];
      result[i] = 0;
    }
    if (i < minimum) result[i] = 0;
  }
  const mass = sum(result);
  if (negativeMass > 1e-7 || Math.abs(mass - 1) > 1e-7)
    fail('NUMERICAL_ERROR', 'The probability calculation failed its normalization check.');
  for (let i = 0; i < result.length; i++) result[i] /= mass;
  const expected = count * mean(base);
  if (Math.abs(mean(result) - expected) > Math.max(1e-6, expected * 1e-8))
    fail('NUMERICAL_ERROR', 'The probability calculation failed its expected-value check.');
  return result;
}

export function pmf(p: ProbabilityParameters): Float64Array {
  const values = new Float64Array(p.max + 1);
  let survival = 1;
  for (let i = 1; i <= p.max; i++) {
    const chance = i < p.soft ? p.base : p.base + ((1 - p.base) * (i - p.soft)) / (p.max - p.soft);
    values[i] = survival * chance;
    survival *= 1 - chance;
  }
  return values;
}

function tail(dist: Float64Array, from: number, to: number): number {
  let value = 0;
  for (let i = Math.max(0, from); i < Math.min(dist.length, to); i++) value += dist[i];
  return Math.min(1, Math.max(0, value));
}

export const COUNT_TAIL_LIMIT = 1e-12;
export const MAX_COUNT_BUDGET = 20000;
export const MAX_COUNT_WORK = 32000000;

// The renewal mean includes every count, including the bounded omitted tail.
export function renewalMean(
  base: Float64Array,
  budget: number,
  first: Float64Array = base
): number {
  const renewal = new Float64Array(budget + 1);
  let expected = 0;
  for (let t = 1; t <= budget; t++) {
    let value = first[t] || 0;
    for (let j = 1; j < base.length && j <= t; j++) value += base[j] * renewal[t - j];
    renewal[t] = value;
    expected += value;
  }
  return expected;
}

export function rewardCounts(
  input: Float64Array,
  budget: number,
  firstInput: Float64Array = input
): RewardCountDistribution {
  if (!Number.isSafeInteger(budget) || budget < 0)
    fail('INVALID_INPUT', 'The pull budget must be a nonnegative integer.');
  if (budget > MAX_COUNT_BUDGET)
    fail(
      'COUNT_CAPACITY',
      `Reward-count modeling supports budgets up to ${MAX_COUNT_BUDGET.toLocaleString()} eligible pulls. Waiting-time distributions are still available.`
    );
  let degree = input.length - 1;
  while (degree > 0 && input[degree] === 0) degree--;
  const base = input.slice(0, degree + 1),
    minimum = base.findIndex((value) => value > 0);
  if (minimum < 1 || Math.abs(sum(base) - 1) > 1e-10)
    fail('INVALID_INPUT', 'Renewal intervals must be a normalized positive-integer distribution.');
  let firstDegree = firstInput.length - 1;
  while (firstDegree > 0 && firstInput[firstDegree] === 0) firstDegree--;
  const first = firstInput.slice(0, firstDegree + 1),
    firstMinimum = first.findIndex((value) => value > 0);
  if (firstMinimum < 1 || Math.abs(sum(first) - 1) > 1e-10)
    fail(
      'INVALID_INPUT',
      'The initial waiting time must be a normalized positive-integer distribution.'
    );
  const maximumCount =
    budget < firstMinimum ? 0 : 1 + Math.floor((budget - firstMinimum) / minimum);
  if (!maximumCount || (minimum === degree && firstMinimum === firstDegree)) {
    const count = maximumCount,
      dist = new Float64Array(count + 1);
    dist[count] = 1;
    return {
      dist,
      expected: count,
      omittedMassBound: 0,
      approximation: 'exact',
      expectedErrorBound: 0
    };
  }
  // Chernoff: P(S_k <= T) <= exp(theta*T) E[exp(-theta*X)]^k.
  // Select a count cutoff from a fixed grid; every candidate is itself a valid
  // bound, so no optimizer convergence or asymptotic assumption is required.
  let cutoff = maximumCount + 1,
    omittedMassBound = 0;
  for (let theta = 1e-6; theta <= 16; theta *= 1.18) {
    let laplace = 0,
      firstLaplace = 0;
    for (let j = minimum; j <= degree; j++) laplace += base[j] * Math.exp(-theta * j);
    for (let j = firstMinimum; j <= firstDegree; j++)
      firstLaplace += first[j] * Math.exp(-theta * j);
    if (!(laplace > 0 && laplace < 1 && firstLaplace > 0)) continue;
    const logLaplace = Math.log(laplace);
    const candidate =
      1 +
      Math.max(
        0,
        Math.ceil(
          (Math.log(COUNT_TAIL_LIMIT) - theta * budget - Math.log(firstLaplace)) / logLaplace
        )
      );
    if (candidate > 0 && candidate < cutoff) {
      cutoff = candidate;
      omittedMassBound = Math.exp(
        theta * budget + Math.log(firstLaplace) + (candidate - 1) * logLaplace
      );
    }
  }
  let size = 1;
  while (size < firstDegree + degree * (cutoff - 1) + 1) size *= 2;
  // All transformed inputs are real. Conjugate frequency pairs contribute
  // equally to the real CDF inner product, so evaluate only one of each pair.
  const frequencies = size / 2 + 1;
  if (size > 524288 || frequencies * cutoff > MAX_COUNT_WORK)
    fail(
      'COUNT_CAPACITY',
      'This reward-count distribution exceeds the bounded calculation capacity. Waiting-time distributions are still available.'
    );
  const re = new Float64Array(size),
    im = new Float64Array(size);
  re.set(base);
  fft(re, im, false);
  // The CDF is the inner product with the transformed [0,T] indicator.
  // This avoids one inverse FFT for every possible reward count.
  const wr = new Float64Array(size),
    wi = new Float64Array(size);
  wr.fill(1, 0, Math.min(size, budget + 1));
  fft(wr, wi, false);
  const pr = new Float64Array(size),
    pi = new Float64Array(size);
  pr.set(first);
  fft(pr, pi, false);
  const dist = new Float64Array(cutoff);
  let previous = 1;
  for (let k = 1; k <= cutoff; k++) {
    let cdf = 0;
    for (let i = 0; i < frequencies; i++) {
      if (k > 1) {
        const next = pr[i] * re[i] - pi[i] * im[i];
        pi[i] = pr[i] * im[i] + pi[i] * re[i];
        pr[i] = next;
      }
      const weight = i === 0 || i === size / 2 ? 1 : 2;
      cdf += weight * (pr[i] * wr[i] + pi[i] * wi[i]);
    }
    cdf /= size;
    if (firstDegree + (k - 1) * degree <= budget) cdf = 1;
    if (firstMinimum + (k - 1) * minimum > budget) cdf = 0;
    if (!Number.isFinite(cdf) || cdf < -1e-8 || cdf > previous + 1e-8)
      fail('NUMERICAL_ERROR', 'Reward-count probabilities failed the monotonicity check.');
    cdf = Math.max(0, Math.min(previous, cdf));
    dist[k - 1] = previous - cdf;
    previous = cdf;
  }
  const expected = renewalMean(base, budget, first);
  // Bounds describe omitted model probability, separately from FFT roundoff.
  const expectedErrorBound = maximumCount * omittedMassBound;
  if (
    previous > omittedMassBound + 1e-8 ||
    Math.abs(mean(dist) - expected) > expectedErrorBound + 1e-6
  )
    fail('NUMERICAL_ERROR', 'Reward-count probabilities failed their mass or mean check.');
  return {
    dist,
    expected,
    omittedMassBound,
    expectedErrorBound,
    approximation: omittedMassBound ? 'bounded-renewal' : 'exact'
  };
}

function validateParameters(p: ProbabilityParameters): void {
  if (
    !p ||
    !Number.isInteger(p.soft) ||
    !Number.isInteger(p.max) ||
    p.soft < 1 ||
    p.max <= p.soft ||
    p.max > 1000 ||
    !Number.isFinite(p.base) ||
    p.base <= 0 ||
    p.base > 1 ||
    !Number.isFinite(p.p) ||
    p.p < 0 ||
    p.p > 1
  )
    fail('INVALID_INPUT', 'The supplied model parameters are invalid.');
}

function unavailable(error?: unknown): ProbabilityMetric {
  return {
    missing: true,
    dist: new Float64Array(),
    expected: 0,
    ...(error ? { error: probabilityError(error) } : {})
  };
}

function isolated(calculate: () => ProbabilityMetric): ProbabilityMetric {
  try {
    return calculate();
  } catch (error) {
    return unavailable(error);
  }
}

function convolve(a: Float64Array, b: Float64Array): Float64Array {
  const result = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++)
    if (a[i]) for (let j = 0; j < b.length; j++) result[i + j] += a[i] * b[j];
  return result;
}

function featuredCycle(elite: Float64Array, rate: number): Float64Array {
  if (rate === 1) return Float64Array.from(elite);
  const result = convolve(elite, elite);
  for (let i = 0; i < result.length; i++)
    result[i] = result[i] * (1 - rate) + (elite[i] || 0) * rate;
  return result;
}

export function residualElite(p: ProbabilityParameters, startingPity: number): Float64Array {
  if (!Number.isSafeInteger(startingPity) || startingPity < 0 || startingPity >= p.max)
    fail('INVALID_INPUT', `Starting pity must be between 0 and ${p.max - 1}.`);
  // Reconstruct the conditional hazards directly. Dividing tiny unconditional
  // survival values would underflow for otherwise valid high-pity states.
  const result = new Float64Array(p.max - startingPity + 1);
  let survival = 1;
  for (let wait = 1; wait < result.length; wait++) {
    const pull = startingPity + wait;
    const chance =
      pull < p.soft ? p.base : p.base + ((1 - p.base) * (pull - p.soft)) / (p.max - p.soft);
    result[wait] = survival * chance;
    survival *= 1 - chance;
  }
  return result;
}

function countDistribution(
  p: ProbabilityParameters,
  budget: number,
  startingPity = 0,
  guaranteed = false,
  featured = false
): RewardCountDistribution {
  validateParameters(p);
  if (typeof guaranteed !== 'boolean')
    fail('INVALID_INPUT', 'The starting guarantee must be a boolean.');
  const elite = pmf(p),
    residual = residualElite(p, startingPity);
  if (!featured) return rewardCounts(elite, budget, residual);
  const cycle = featuredCycle(elite, p.p);
  let first: Float64Array = residual;
  if (!guaranteed) {
    first = convolve(residual, elite);
    for (let i = 0; i < first.length; i++)
      first[i] = first[i] * (1 - p.p) + (residual[i] || 0) * p.p;
  }
  return rewardCounts(cycle, budget, first);
}

export function quantile(dist: Float64Array, probability: number): number {
  let cdf = 0;
  for (let i = 0; i < dist.length; i++) {
    cdf += dist[i];
    if (cdf >= probability) return i;
  }
  return fail(
    'NUMERICAL_ERROR',
    'The retained distribution does not contain the requested quantile.'
  );
}

export function planner({
  p,
  budget,
  startingPity = 0,
  guaranteed = false
}: PlannerInput): PlannerResult {
  const metric = (featured: boolean): ProbabilityMetric =>
    isolated(() => {
      const result = countDistribution(p, budget, startingPity, guaranteed, featured);
      return {
        ...result,
        missing: false,
        budget,
        low: quantile(result.dist, 0.05),
        high: quantile(result.dist, 0.95),
        chanceAtLeastOne: Math.max(0, 1 - result.dist[0])
      };
    });
  return { elite: metric(false), featured: metric(true) };
}

function winsMetric(p: ProbabilityParameters, wins?: WinsObservation | null): ProbabilityMetric {
  if (!wins) return unavailable();
  return isolated(() => {
    validateParameters(p);
    const { wins: count, trials } = wins;
    checkedLength(1, trials);
    if (!Number.isSafeInteger(count) || count < 0 || count > trials)
      fail('INVALID_INPUT', 'Wins must be an integer between zero and the number of trials.');
    if (!trials) return unavailable();
    const dist = power(Float64Array.of(1 - p.p, p.p), trials);
    return {
      dist,
      missing: false,
      count,
      observation: count,
      budget: trials,
      n: trials,
      expected: p.p * trials,
      tail: tail(dist, count, dist.length),
      omittedMassBound: 0
    };
  });
}

export function summary({ p, windows, wins }: SummaryInput): HistoryProbabilityResult {
  const metric = (key: Reward, featured: boolean): ProbabilityMetric => {
    const window = windows && windows[key];
    if (!window) return unavailable();
    return isolated(() => {
      const { budget, count, startingPity = 0, guaranteed = false } = window;
      if (!Number.isSafeInteger(count) || count < 0 || count > budget)
        fail(
          'INVALID_INPUT',
          'The observed reward count must be an integer between zero and the pull budget.'
        );
      const result = countDistribution(p, budget, startingPity, guaranteed, featured);
      return {
        ...result,
        missing: false,
        budget,
        count,
        observation: count,
        tail: tail(result.dist, count, result.dist.length)
      };
    });
  };
  return {
    elite: metric('elite', false),
    featured: metric('featured', true),
    wins: winsMetric(p, wins)
  };
}

export function acquisition({
  p,
  intervals,
  featuredIntervals,
  wins
}: AcquisitionInput): HistoryProbabilityResult {
  const metric = (
    values: readonly number[] | null | undefined,
    featured: boolean
  ): ProbabilityMetric => {
    if (values == null) return unavailable();
    return isolated(() => {
      validateParameters(p);
      if (!Array.isArray(values)) fail('INVALID_INPUT', 'Acquisition intervals must be an array.');
      const limit = p.max * (featured ? 2 : 1);
      checkedLength(limit, values.length);
      for (const value of values)
        if (!Number.isSafeInteger(value) || value < 1 || value > limit)
          fail('INVALID_INPUT', `Complete intervals must contain between 1 and ${limit} pulls.`);
      if (!values.length) return unavailable();
      const elite = pmf(p),
        base = featured ? featuredCycle(elite, p.p) : elite;
      const dist = power(base, values.length),
        budget = sum(values);
      return {
        dist,
        missing: false,
        count: values.length,
        n: values.length,
        budget,
        observation: budget,
        expected: values.length * mean(base),
        tail: tail(dist, 0, budget + 1),
        omittedMassBound: 0
      };
    });
  };
  return {
    elite: metric(intervals, false),
    featured: metric(featuredIntervals, true),
    wins: winsMetric(p, wins)
  };
}

export function dispatch(data: ProbabilityRequest): ProbabilityResult {
  switch (data.method) {
    case 'planner':
      return planner(data);
    case 'summary':
      return summary(data);
    case 'acquisition':
      return acquisition(data);
    default:
      return fail('INVALID_INPUT', 'The requested probability method is unknown.');
  }
}
