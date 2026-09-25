<script lang="ts">
  import { onDestroy } from 'svelte';
  import { mean, pmf } from '$lib/statistics/probability';
  import {
    createProbabilityClient,
    type ProbabilityClient
  } from '$lib/statistics/probability-client';
  import {
    MODELS,
    type ProbabilityResult,
    type ProbabilityMetric
  } from '$lib/statistics/probability-types';
  import type { ProfileOverview } from '$lib/reward-query';
  import type { HistoryStatistics } from '$lib/statistics/history-types';
  export let summary: HistoryStatistics | null = null;
  export let overview: ProfileOverview | null = null;
  export let pending = false;
  export let error = '';
  $: type = summary?.typeId ?? overview?.selectedType;
  $: supported = type === 3 || type === 4;
  $: model = type === 4 ? MODELS.weapons : MODELS.dolls;
  $: expectedPullRate = supported ? 100 / mean(pmf(model)) : null;
  $: expectedWinRate = supported ? model.p * 100 : null;
  $: hardPity = type === 4 ? 70 : type === 3 ? 80 : null;
  $: pity = summary
    ? summary.currentPity
    : overview?.currentUncertain
      ? null
      : (overview?.currentPity ?? null);
  $: guarantee = summary
    ? summary.currentGuarantee
    : (overview?.featured?.current_guarantee ?? null);
  $: elite =
    summary?.eliteCount ??
    overview?.breakdown.find((entry) => entry.rarity === 'Elite')?.count ??
    0;
  $: unknown = overview?.breakdown.find((entry) => entry.rarity === 'Unknown')?.count ?? 0;
  $: wins =
    summary?.wins ??
    (overview?.featured
      ? {
          wins: overview.featured.wins,
          trials: overview.featured.wins + overview.featured.losses,
          guaranteed: overview.featured.guaranteed,
          unknown: overview.featured.unknown_outcomes
        }
      : null);
  $: total =
    summary?.total ?? overview?.breakdown.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
  $: pullRate = total ? (elite / total) * 100 : 0;
  $: winPercent = wins?.trials ? (wins.wins / wins.trials) * 100 : 0;
  let modelResult: ProbabilityResult | null = null;
  let modelPending = false;
  let modelError = '';
  let markerTooltip: 'pull' | 'win' | null = null;
  let probabilityClient: ProbabilityClient | undefined;
  let modelRequest = 0;
  $: void calculateLuck(summary, supported, type, pending, error);
  async function calculateLuck(
    history: HistoryStatistics | null,
    usable: boolean,
    typeId: number | null | undefined,
    loading: boolean,
    failure: string
  ) {
    markerTooltip = null;
    const request = ++modelRequest;
    probabilityClient?.dispose();
    probabilityClient = undefined;
    modelResult = null;
    modelError = '';
    modelPending = false;
    if (loading || failure || !history?.total || !usable) return;
    const client = (probabilityClient = createProbabilityClient());
    modelPending = true;
    try {
      const result = await client.run({
        method: 'summary',
        p: typeId === 4 ? MODELS.weapons : MODELS.dolls,
        windows: { elite: history.windows.elite },
        wins: history.wins
      });
      if (request === modelRequest) modelResult = result;
    } catch (cause) {
      if (request === modelRequest)
        modelError = cause instanceof Error ? cause.message : 'Model comparison unavailable.';
    } finally {
      client.dispose();
      if (request === modelRequest) modelPending = false;
    }
  }
  onDestroy(() => {
    modelRequest++;
    probabilityClient?.dispose();
  });
  const percentile = (metric?: ProbabilityMetric) => {
    if (!metric || metric.missing || metric.error || metric.tail === undefined) return null;
    const value = Math.max(0, Math.min(100, (1 - metric.tail) * 100));
    return value > 99.95 ? '>99.9%' : value > 0 && value < 0.05 ? '<0.1%' : `${value.toFixed(1)}%`;
  };
  $: eliteLuck = percentile(modelResult?.elite);
  $: winLuck = percentile(modelResult?.wins);
  function unavailable(
    metric: ProbabilityMetric | undefined,
    reward: boolean,
    modelPending: boolean,
    pending: boolean,
    summary: HistoryStatistics | null,
    supported: boolean,
    total: number,
    modelError: string
  ) {
    if (modelPending || pending) return 'Calculating model comparison…';
    if (!total) return 'Import history to compare your luck.';
    if (!supported) return 'No probability model for this recruitment.';
    if (modelError || metric?.error)
      return modelError || metric?.error?.message || 'Model comparison unavailable.';
    if (!summary) return 'Model comparison requires browser history.';
    return reward ? summary.windowReasons.elite : 'No classifiable non-guaranteed attempts.';
  }
</script>

<div class="history-summary" aria-busy={pending} data-luck-ready={!pending && !modelPending}>
  {#if error}<p class="error" role="alert">Summary unavailable: {error}</p>
  {:else}
    {#if pending}<p class="loading" role="status">Loading recruitment summary…</p>{/if}
    <h2 class="sr-only">Recruitment summary</h2>
    <div class="summary-grid" class:pending>
      <article class="metric current-pity">
        <h3>Current pity</h3>
        <div class="value accent">
          {#if total && pity !== null}<span class="value-label"
              >{elite > 0 ? 'Since last 5★' : 'Before first 5★'}</span
            >{/if}
          <strong>{total ? (pity ?? '—') : '—'}</strong>{#if total && pity !== null}<span
              >pulls</span
            >{/if}
        </div>
        <p class="support">
          {!total
            ? 'Import history to see current pity.'
            : pity === null
              ? 'Pity uncertain · history may be incomplete.'
              : supported
                ? guarantee === null
                  ? 'Guarantee unknown'
                  : guarantee
                    ? 'Guaranteed'
                    : 'Not guaranteed'
                : 'Recorded pity'}
        </p>
        <div class="bar-group">
          <div class="bar-labels">
            <span
              >{pity !== null && hardPity
                ? `${Math.max(0, hardPity - pity)} to hard pity`
                : 'Saved recruitment history'}</span
            ><span>{hardPity ? `Hard pity ${hardPity}` : ''}</span>
          </div>
          <div class="bar" aria-hidden="true">
            <span
              class="pity-fill"
              style:width={`${pity !== null && hardPity ? Math.min(100, (pity / hardPity) * 100) : 0}%`}
            ></span>
          </div>
        </div>
      </article>
      <article class="metric pull-rate">
        <h3>5★ pull rate</h3>
        <div class="value luck-value">
          {#if eliteLuck}<span>Luckier than</span><strong>{eliteLuck}</strong>{:else}<strong
              >—</strong
            >{/if}
        </div>
        <p class="support">
          {total
            ? `${elite.toLocaleString()} five-stars in ${total.toLocaleString()} recorded pulls`
            : 'Import history to see your 5-star pull rate.'}
        </p>
        <div class="bar-group">
          {#if eliteLuck}
            {#if summary?.windows.elite && summary.windows.elite.count < 10}<p class="model-label">
                Small sample
              </p>{/if}
          {:else}<p class="model-label">
              {unavailable(
                modelResult?.elite,
                true,
                modelPending,
                pending,
                summary,
                supported,
                total,
                modelError
              )}
            </p>{/if}
          {#if total}
            <div class="bar-labels">
              <span
                >{elite
                  ? `${(total / elite).toFixed(1)} pulls per five-star`
                  : `${total.toLocaleString()} recorded pulls`}</span
              ><span>{pullRate.toFixed(2)}% of pulls</span>
            </div>
            <div
              class="bar"
              role="group"
              aria-label="Recorded rate and model expectation"
              onmouseleave={(event) => {
                if (!event.currentTarget.contains(document.activeElement)) markerTooltip = null;
              }}
            >
              <span aria-hidden="true" style:width={`${pullRate}%`}></span>
              {#if expectedPullRate !== null}
                <button
                  type="button"
                  class="expected-marker"
                  style:left={`${expectedPullRate}%`}
                  aria-label={`Model expected: ${expectedPullRate.toFixed(2)}% long-run pull rate`}
                  onmouseenter={() => (markerTooltip = 'pull')}
                  onfocus={() => (markerTooltip = 'pull')}
                  onblur={() => (markerTooltip = null)}
                  onclick={() => (markerTooltip = 'pull')}
                  onkeydown={(event) => {
                    if (event.key === 'Escape') markerTooltip = null;
                  }}
                ></button>
                {#if markerTooltip === 'pull'}<span class="expected-tooltip" role="tooltip"
                    >Model expected: {expectedPullRate.toFixed(2)}% long-run pull rate</span
                  >{/if}
              {/if}
            </div>
          {/if}
        </div>
      </article>
      <article class="metric rate-up-wins">
        <h3>Rate-up wins</h3>
        <div class="value luck-value">
          {#if winLuck}<span>Luckier than</span><strong>{winLuck}</strong>{:else}<strong>—</strong
            >{/if}
        </div>
        <p class="support">
          {supported && wins
            ? `${wins.wins} of ${wins.trials} rate-ups won`
            : 'No classifiable rate-up attempts.'}
        </p>
        <div class="bar-group">
          {#if winLuck}
            {#if wins && wins.trials < 10}<p class="model-label">Small sample</p>{/if}
          {:else}<p class="model-label">
              {unavailable(
                modelResult?.wins,
                false,
                modelPending,
                pending,
                summary,
                supported,
                total,
                modelError
              )}
            </p>{/if}
          {#if supported && wins && wins.trials}
            <div class="bar-labels">
              <span>{wins.wins} wins · {wins.trials - wins.wins} losses</span><span
                >{winPercent.toFixed(1)}% won</span
              >
            </div>
            <div
              class="bar"
              role="group"
              aria-label="Recorded rate and model expectation"
              onmouseleave={(event) => {
                if (!event.currentTarget.contains(document.activeElement)) markerTooltip = null;
              }}
            >
              <span aria-hidden="true" style:width={`${winPercent}%`}></span>
              {#if expectedWinRate !== null}
                <button
                  type="button"
                  class="expected-marker"
                  style:left={`${expectedWinRate}%`}
                  aria-label={`Model expected: ${expectedWinRate.toFixed(2)}% wins`}
                  onmouseenter={() => (markerTooltip = 'win')}
                  onfocus={() => (markerTooltip = 'win')}
                  onblur={() => (markerTooltip = null)}
                  onclick={() => (markerTooltip = 'win')}
                  onkeydown={(event) => {
                    if (event.key === 'Escape') markerTooltip = null;
                  }}
                ></button>
                {#if markerTooltip === 'win'}<span class="expected-tooltip" role="tooltip"
                    >Model expected: {expectedWinRate.toFixed(2)}% wins</span
                  >{/if}
              {/if}
            </div>
          {/if}
        </div>
      </article>
    </div>
    <div class="summary-coverage" class:pending>
      <p>
        {total.toLocaleString()} recorded pulls in this recruitment.
        {#if summary?.windows.elite}{' '}Five-star luck uses {summary.windows.elite.count} five-stars
          in {summary.windows.elite.budget.toLocaleString()} pulls from the latest known-start stretch,
          including current pity.{/if}
        {#if supported && wins}{' '}{wins.guaranteed} guaranteed rewards and {wins.unknown} unknown outcomes
          excluded from rate-up wins.{/if}
        {#if unknown}{' '}Unknown rarity: {unknown} recorded pulls.{/if}
      </p>
      <details>
        <summary>What these count</summary>
        <p>
          Headlines show the share of outcomes under the selected probability model strictly below
          your result. Ties are excluded; these are not rankings of players. Five-star luck uses
          only the latest continuous stretch with known starting pity, including trailing pulls.
          Rate-up luck compares classifiable non-guaranteed attempts. Small samples can produce
          extreme percentiles.
        </p>
        <p>
          The bottom bars show your recorded pull rate and rate-up win rate. Dashed markers show the
          model’s long-run five-star rate (including pity) and non-guaranteed rate-up chance; they
          are not percentiles. The raw pull rate uses all recorded five-stars divided by all
          recorded pulls in this recruitment. Its coverage may differ from the model comparison;
          missing pulls can affect it. The model uses the same assumptions as Statistics, not
          verified live game rates.
        </p>
      </details>
    </div>
  {/if}
</div>

<style>
  .value.luck-value > span,
  .value > .value-label {
    grid-column: 1 / -1;
    grid-row: 1;
    justify-self: end;
    white-space: nowrap;
    line-height: 1.25;
  }
  .value-label,
  .luck-value span,
  .model-label {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .model-label {
    margin: 0;
    line-height: 1.4;
  }
  .history-summary {
    position: relative;
  }
  .pending {
    visibility: hidden;
  }
  .loading {
    position: absolute;
    top: 12px;
    left: 0;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: 0.8fr 1fr 1fr;
    gap: 32px;
    padding: 16px 0;
    border-block: 1px solid var(--line);
  }
  .metric {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto 1fr;
    min-width: 0;
    column-gap: 12px;
  }
  .metric + .metric::before {
    content: '';
    position: absolute;
    left: -16px;
    inset-block: 0;
    border-left: 1px solid var(--line);
  }
  h3 {
    margin: 0;
    font-family: 'Barlow', sans-serif;
    font-size: 1rem;
    line-height: 1.3;
    grid-column: 1;
    grid-row: 1;
  }
  .value {
    grid-column: 2;
    grid-row: 1 / 3;
    display: grid;
    grid-template-columns: auto auto;
    grid-template-rows: 1rem auto;
    align-items: baseline;
    align-content: start;
    gap: 2px 6px;
    justify-content: end;
  }
  .value strong,
  .value.accent > span:not(.value-label) {
    grid-row: 2;
  }
  .value.luck-value {
    grid-template-columns: auto;
  }
  .value.luck-value > span {
    grid-row: 1;
  }
  strong {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 2rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .value span {
    color: var(--muted);
  }
  .accent strong {
    color: var(--accent-text);
  }
  .support {
    grid-column: 1;
    grid-row: 2;
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .bar-group {
    grid-column: 1 / -1;
    grid-row: 3;
    align-self: start;
    margin-top: 12px;
  }
  .bar-labels {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 16px;
  }
  .bar-labels span:last-child {
    white-space: nowrap;
  }
  .bar {
    position: relative;
    height: 8px;
    background: var(--track);
  }
  .expected-marker {
    position: absolute;
    top: -8px;
    width: 24px;
    height: 24px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    transform: translateX(-50%);
    cursor: help;
  }
  .expected-marker::after {
    content: '';
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: calc(50% - 1px);
    border-left: 2px dashed var(--ink, #20252b);
  }
  .expected-marker:focus-visible {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .bar > .expected-tooltip {
    position: absolute;
    z-index: 2;
    top: 100%;
    left: 0;
    width: max-content;
    max-width: 100%;
    height: auto;
    padding: 6px 8px;
    color: #fff;
    background: #20252b;
    font-size: 0.8rem;
    line-height: 1.4;
    pointer-events: auto;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent-text);
  }
  .bar > .pity-fill {
    background: #6f7d8a;
  }
  .summary-coverage {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 16px;
    margin: 8px 0 16px;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .summary-coverage p {
    margin: 0;
    line-height: 1.5;
  }
  details[open] {
    flex-basis: 100%;
  }
  details p {
    max-width: 75ch;
    padding: 8px 0;
  }
  summary {
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .error {
    color: var(--danger);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 1000px) {
    .support {
      grid-column: 1 / -1;
    }
    .value {
      grid-row: 1;
    }
  }
  @media (max-width: 650px) {
    .summary-grid {
      grid-template-columns: 1fr;
      gap: 0;
      padding: 0;
    }
    .metric {
      padding: 12px 0;
    }
    .metric + .metric::before {
      left: 0;
      right: 0;
      top: 0;
      bottom: auto;
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    strong {
      font-size: 1.75rem;
    }
    .bar-group {
      margin-top: 10px;
    }
  }
</style>
