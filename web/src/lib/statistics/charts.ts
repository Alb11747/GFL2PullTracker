/* Chart geometry uses SVG; labels stay in HTML so they remain readable at 320px. */
export type Distribution = readonly number[] | Float64Array;
type Direction = 'lower' | 'upper';
interface DistributionOptions {
  key?: string;
  title?: string;
  dist: Distribution;
  expected?: number;
  observation?: number | null;
  tail?: number | null;
  direction?: Direction;
  axisLabel?: string;
  planner?: boolean;
}
interface ObservedOptions {
  key?: string;
  title?: string;
  intervals?: readonly number[];
  modelPmf?: Distribution | null;
  max?: number;
  soft?: number | null;
}
interface PlotOptions {
  key?: string;
  title: string;
  description: string;
  lo: number;
  hi: number;
  ticks: number[];
  yLabel: string;
  axisLabel: string;
  bars: string;
  overlays?: string;
  percent?: boolean;
  preserveEndpoints?: boolean;
}
const C = {
  bar: '#6f7d8a',
  event: '#a64000',
  observed: '#526273',
  ink: '#20252b',
  grid: '#c3c9d0'
};
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
const number = (n: number | null) =>
  Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const probability = (value: number | null) => {
  const p = value ?? 0;
  return p === 0
    ? '0%'
    : p < 0.0001
      ? (p * 100).toExponential(2) + '%'
      : p < 1 && p > 0.9999
        ? '>99.99%'
        : number(p * 100) + '%';
};
const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0);
function niceStep(value: number) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value)),
    n = value / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}
export function niceTicks(maximum: number, integer = false) {
  const step = Math.max(integer ? 1 : 0, niceStep(maximum / 4));
  const top = Math.max(step, Math.ceil(maximum / step) * step);
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toPrecision(12));
}
function validPmf(dist: Distribution | null | undefined): dist is Distribution {
  return (
    (Array.isArray(dist) || ArrayBuffer.isView(dist)) &&
    dist.length > 0 &&
    Array.from(dist).every((p) => Number.isFinite(p) && p >= 0) &&
    sum(Array.from(dist)) > 0
  );
}
function quantile(dist: readonly number[], q: number) {
  const target = sum(dist) * q;
  let cumulative = 0;
  for (let i = 0; i < dist.length; i++) {
    cumulative += dist[i];
    if (cumulative >= target) return i;
  }
  return dist.length - 1;
}
export function distributionBins(
  dist: Distribution,
  observation: number | null = null,
  direction: Direction = 'lower',
  planner = false
) {
  if (!validPmf(dist)) return null;
  const d = Array.from(dist),
    mass = sum(d);
  let first = d.findIndex((p) => p > 0),
    last = d.length - 1;
  while (!d[last]) last--;
  let lo = quantile(d, 0.001),
    hi = quantile(d, 0.999);
  // Keep at most twelve discrete outcomes complete. Wider supports can contain
  // tiny numerical tails that would otherwise flatten a concentrated count chart.
  if (last - first + 1 <= 12) {
    lo = first;
    hi = last;
  }
  const hasObservation =
    !planner && typeof observation === 'number' && Number.isFinite(observation);
  if (hasObservation && observation >= first && observation <= last) {
    lo = Math.min(lo, Math.floor(observation));
    hi = Math.max(hi, Math.ceil(observation));
  }
  const step = Math.max(1, niceStep((hi - lo + 1) / 32)),
    bins = [];
  for (let start = lo; start <= hi; start += step) {
    const end = Math.min(hi, start + step - 1),
      cuts = [start, end + 1];
    if (hasObservation) {
      // Isolate an integer observation; otherwise split at the exact discrete event boundary.
      for (const cut of [Math.floor(observation) + 1, Math.ceil(observation)])
        if (cut > start && cut <= end) cuts.push(cut);
    }
    cuts.sort((a, b) => a - b);
    const unique = [...new Set(cuts)];
    for (let j = 0; j < unique.length - 1; j++) {
      const from = unique[j],
        to = unique[j + 1] - 1;
      bins.push({
        lo: from,
        hi: to,
        mass: sum(d.slice(from, to + 1)),
        event: hasObservation && (direction === 'upper' ? from >= observation : to <= observation),
        observed: hasObservation && from === observation && to === observation
      });
    }
  }
  const eventMass = hasObservation
    ? d.reduce(
        (s, p, i) => s + ((direction === 'upper' ? i >= observation : i <= observation) ? p : 0),
        0
      )
    : null;
  return {
    bins,
    lo,
    hi,
    first,
    last,
    mass,
    step,
    eventMass,
    croppedLow: sum(d.slice(0, lo)),
    croppedHigh: sum(d.slice(hi + 1)),
    central90: [quantile(d, 0.05), quantile(d, 0.95)]
  };
}
export function observedBins(
  intervals: readonly number[],
  modelPmf: Distribution | null,
  maximum: number
) {
  const values = (Array.isArray(intervals) ? intervals : []).filter(
    (x) => Number.isInteger(x) && x >= 1
  );
  let max = Number.isInteger(maximum) && maximum > 0 ? maximum : 1;
  for (const value of values) max = Math.max(max, value);
  const counts = new Map();
  values.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  const modeled = validPmf(modelPmf),
    bins = [];
  for (let lo = 1; lo <= max; lo += 5) {
    const hi = Math.min(max, lo + 4);
    let count = 0,
      expected = 0;
    for (let i = lo; i <= hi; i++) {
      count += counts.get(i) || 0;
      if (modeled) expected += (modelPmf[i] || 0) * values.length;
    }
    bins.push({ lo, hi, count, expected: modeled ? expected : null });
  }
  return {
    bins,
    lo: 1,
    hi: max,
    n: values.length,
    modeled,
    average: values.length ? sum(values) / values.length : null
  };
}
function rangeLabel(bin: { lo: number; hi: number }) {
  return bin.lo === bin.hi ? number(bin.lo) : `${number(bin.lo)}–${number(bin.hi)}`;
}
export function xTicks(lo: number, hi: number, preserveEndpoints = false) {
  if (lo === hi) return [lo];
  const step = Math.max(1, niceStep((hi - lo) / 4));
  const ticks = preserveEndpoints ? [lo] : [];
  // Quantile crop endpoints are rarely round; the tail notice records those
  // exact bounds while these labels retain a regular, readily scanned scale.
  for (let n = Math.ceil(lo / step) * step; n <= hi; n += step) {
    if (!preserveEndpoints || (n > lo && n - lo >= (hi - lo) * 0.15 && hi - n >= (hi - lo) * 0.15))
      ticks.push(n);
  }
  if (preserveEndpoints) ticks.push(hi);
  return ticks;
}
function line(x: number, y1: number, y2: number, color: string, dashed = false) {
  return `<line x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" stroke="${color}" stroke-width="1.5"${dashed ? ' stroke-dasharray="5 4"' : ''} vector-effect="non-scaling-stroke"/>`;
}
function swatch(type: string, label: string) {
  return `<span><i class="mc-swatch mc-${type}" aria-hidden="true"></i>${esc(label)}</span>`;
}
function plot({
  key,
  title,
  description,
  lo,
  hi,
  ticks,
  yLabel,
  axisLabel,
  bars,
  overlays = '',
  percent = false,
  preserveEndpoints = false
}: PlotOptions) {
  const id = 'mc-' + String(key || 'chart').replace(/[^a-zA-Z0-9_-]/g, '-');
  const top = ticks[ticks.length - 1];
  const yLabels = ticks
    .map(
      (value) =>
        `<span style="bottom:${(value / top) * 100}%">${percent ? probability(value) : number(value)}</span>`
    )
    .join('');
  const grid = ticks
    .map(
      (value) =>
        `<line x1="0" x2="1000" y1="${200 - (value / top) * 200}" y2="${200 - (value / top) * 200}" stroke="${C.grid}" stroke-width="1" vector-effect="non-scaling-stroke"/>`
    )
    .join('');
  const xLabels = xTicks(lo, hi, preserveEndpoints)
    .map(
      (value) =>
        `<span class="${lo === hi ? '' : value === lo ? 'mc-first' : value === hi ? 'mc-last' : ''}" style="left:${((value - lo + 0.5) / (hi - lo + 1)) * 100}%">${number(value)}</span>`
    )
    .join('');
  return `<div class="mc-chart"><div class="mc-y-title">${esc(yLabel)}</div><div class="mc-frame"><div class="mc-y-labels" aria-hidden="true">${yLabels}</div><div class="mc-plot"><svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${esc(title)}</title><desc id="${id}-desc">${esc(description)}</desc>${grid}${bars}${overlays}</svg></div><div class="mc-x-labels" aria-hidden="true">${xLabels}</div></div><div class="mc-axis-title">${esc(axisLabel)}</div></div>`;
}
function table(headers: string[], rows: string[][], caption: string) {
  return `<details class="mc-values"><summary>View numerical chart values</summary><div class="mc-table-scroll" tabindex="0" role="region" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, i) => `<${i ? 'td' : 'th scope="row"'}>${esc(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
export function distribution({
  key,
  title = 'Model distribution',
  dist,
  expected,
  observation = null,
  tail = null,
  direction = 'lower',
  axisLabel = 'Outcome',
  planner = false
}: DistributionOptions) {
  const data = distributionBins(dist, observation, direction, planner);
  if (!data) return '<p class="mc-unavailable">Model distribution unavailable.</p>';
  const { bins, lo, hi } = data,
    hasObservation = !planner && typeof observation === 'number' && Number.isFinite(observation);
  const mean =
    typeof expected === 'number' && Number.isFinite(expected)
      ? expected
      : Array.from(dist).reduce((s, p, i) => s + i * p, 0) / data.mass;
  const ticks = niceTicks(Math.max(...bins.map((b) => b.mass))),
    top = ticks[ticks.length - 1],
    span = hi - lo + 1;
  const x = (value: number) => Math.max(0, Math.min(1000, ((value - lo + 0.5) / span) * 1000));
  const bars = bins
    .map((b) => {
      const left = ((b.lo - lo) / span) * 1000,
        width = ((b.hi - b.lo + 1) / span) * 1000,
        height = (b.mass / top) * 200;
      return `<rect x="${left + 0.5}" y="${200 - height}" width="${Math.max(0.1, width - 1)}" height="${height}" fill="${b.event ? C.event : C.bar}"${b.observed ? ` stroke="${C.ink}" stroke-width="2" vector-effect="non-scaling-stroke"` : ''}/>`;
    })
    .join('');
  const outside = hasObservation && (observation < lo || observation > hi);
  const eventText = hasObservation
    ? `${probability(data.eventMass)} probability of ${number(observation)} ${direction === 'upper' ? 'or more' : 'or fewer'}`
    : '';
  const meanText = `Model mean: ${number(mean)}${mean < lo || mean > hi ? ' (outside plotted range)' : ''}`;
  const observationText = hasObservation
    ? `Observed: ${number(observation)}${outside ? ' (outside plotted range)' : ''}`
    : '';
  const cropped = data.croppedLow + data.croppedHigh;
  const cropText =
    cropped > 0
      ? `Cropped tails: ${probability(data.croppedLow)} below ${number(lo)}; ${probability(data.croppedHigh)} above ${number(hi)}. Probability uses the full distribution.`
      : '';
  const rangeText = planner
    ? `Central 90% model range: ${number(data.central90[0])}–${number(data.central90[1])}.`
    : '';
  const summary = [meanText, observationText, eventText, rangeText].filter(Boolean).join('. ');
  const description = `${title}. ${summary}. X axis: ${axisLabel}, ${number(lo)} to ${number(hi)}. Y axis: probability mass per displayed bin, 0 to ${probability(top)}. Bar widths show outcome ranges; heights show their summed probability, not probability density. ${cropText} Numerical values follow in an expandable table.`;
  // An off-chart mean remains in the summary; clamping its line to an edge
  // would falsely mark that edge as the expected outcome.
  let overlays = mean >= lo && mean <= hi ? line(x(mean), 0, 200, C.ink, true) : '';
  if (hasObservation) overlays += line(x(observation), 0, 200, C.event);
  const rows = bins.map((b) => [
    rangeLabel(b),
    probability(b.mass),
    hasObservation ? (b.event ? 'Included' : 'Not included') : '—'
  ]);
  return `<div class="mc-summary"><span>${esc(meanText)}</span>${hasObservation ? `<span>${esc(observationText)}</span><strong>${esc(eventText)}</strong>` : ''}</div>${plot({ key, title, description, lo, hi, ticks, yLabel: 'Probability per bin', axisLabel, bars, overlays, percent: true })}<div class="mc-legend">${swatch('bar', 'Model probability')}${hasObservation ? swatch('event', direction === 'upper' ? 'At least the observation' : 'At most the observation') + swatch('observed-line', 'Observed value') : ''}${swatch('mean', 'Model mean')}</div>${rangeText ? `<p class="mc-note">${esc(rangeText)}</p>` : ''}${cropText ? `<p class="mc-note">${esc(cropText)}</p>` : ''}${table(['Outcome range', 'Probability', 'Shaded event'], rows, `${title}: probability mass in each displayed bin`)}`;
}
export function observed({
  key = 'observed',
  title = 'Observed pulls between rewards',
  intervals = [],
  modelPmf = null,
  max = 80,
  soft = null
}: ObservedOptions) {
  const data = observedBins(intervals, modelPmf, max),
    { bins, lo, hi } = data;
  if (!data.n) return '<p class="mc-unavailable">No complete intervals to plot.</p>';
  const peak = bins.reduce((m, b) => Math.max(m, b.count, b.expected || 0), 0),
    ticks = niceTicks(peak, true),
    top = ticks[ticks.length - 1],
    span = hi - lo + 1;
  const softAvailable =
    typeof soft === 'number' && Number.isFinite(soft) && soft >= 1 && soft <= max;
  const band = softAvailable
    ? `<rect x="${((soft - lo) / span) * 1000}" y="0" width="${((max - soft + 1) / span) * 1000}" height="200" fill="${C.event}" opacity=".08"/>`
    : '';
  const bars = bins
    .map((b) => {
      const left = ((b.lo - lo) / span) * 1000,
        width = ((b.hi - b.lo + 1) / span) * 1000,
        h = (b.count / top) * 200;
      const expectedHeight = ((b.expected || 0) / top) * 200;
      return `<rect x="${left + 2}" y="${200 - h}" width="${Math.max(0.1, width - 4)}" height="${h}" fill="${C.observed}"/>${data.modeled ? `<rect x="${left + 1}" y="${200 - expectedHeight}" width="${Math.max(0.1, width - 2)}" height="${expectedHeight}" fill="none" stroke="#78848e" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ''}`;
    })
    .join('');
  const mean = `Observed mean: ${number(data.average)} pulls`;
  const softText = softAvailable ? `Soft-pity region: ${number(soft)}–${number(max)} pulls.` : '';
  const modelText = data.modeled
    ? 'Expected outline equals the number of observed intervals multiplied by the model probability in each five-pull bin.'
    : 'No theoretical model overlay is applied.';
  const extended =
    hi > max
      ? `Axis extended beyond the model maximum of ${number(max)} to include all observed intervals.`
      : '';
  const description = `${title}. ${data.n} complete intervals. ${mean}. X axis: pulls between rewards, 1 to ${number(hi)}. Y axis: interval counts, 0 to ${number(top)}. Observed filled bars group five pull values, with a shorter final bin when needed. ${modelText} ${softText} ${extended} Numerical values follow in an expandable table.`;
  const meanX = (((data.average ?? 0) - lo + 0.5) / span) * 1000;
  return `<div class="mc-summary"><span>${esc(mean)}</span></div>${plot({ key, title, description, lo, hi, ticks, yLabel: 'Completed intervals', axisLabel: 'Pulls between rewards', bars: band + bars, overlays: line(meanX, 0, 200, C.ink, true), preserveEndpoints: true })}<div class="mc-legend">${swatch('observed', 'Observed count')}${data.modeled ? swatch('expected', 'Model expected count') : ''}${swatch('mean', 'Observed mean')}${softAvailable ? swatch('soft', 'Soft-pity region') : ''}</div><p class="mc-note">${esc([modelText, softText, extended].filter(Boolean).join(' '))}</p>${table(
    ['Pull range', 'Observed count', 'Expected count'],
    bins.map((b) => [
      rangeLabel(b),
      number(b.count),
      b.expected === null ? 'Unavailable' : number(b.expected)
    ]),
    `${title}: completed intervals in five-pull bins`
  )}`;
}
