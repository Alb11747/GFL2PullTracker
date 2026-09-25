<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { Profile } from '$lib/api';
  import type { PublicClient, VerifiedAccount, CommunityComparison } from '$lib/public-api';
  import type { PersonalStatisticsResponse } from '$lib/statistics/history-types';
  import {
    MODELS,
    DEFAULT_PLANNER_BUDGET,
    DEFAULT_REWARD,
    type Reward,
    type ProbabilityMetric,
    type ProbabilityResult,
    type ProbabilityParameters
  } from '$lib/statistics/probability-types';
  import type { ProbabilityClient } from '$lib/statistics/probability-client';
  import * as charts from '$lib/statistics/charts';
  import '$lib/statistics/charts.css';
  import StatisticsLuckScale from './StatisticsLuckScale.svelte';
  let {
    profiles,
    activeProfileId,
    revision,
    query,
    publicApi,
    verifiedAccounts,
    onprofilechange
  }: {
    profiles: Profile[];
    activeProfileId: string;
    revision: number | string;
    query: (profileId: string, typeId: number | null) => Promise<PersonalStatisticsResponse>;
    publicApi: PublicClient;
    verifiedAccounts: VerifiedAccount[];
    onprofilechange?: (id: string) => void;
  } = $props();
  type MetricKey = 'elite' | 'featured' | 'wins';
  const keys: MetricKey[] = ['elite', 'featured', 'wins'];
  const titles = { elite: '5★ results', featured: 'Featured results', wins: 'Rate-up wins' };
  let profileId = $state(''),
    typeId = $state<number | null>(null),
    response = $state<PersonalStatisticsResponse | null>(null);
  let loading = $state(false),
    loadError = $state(''),
    retry = $state(0);
  let summary = $state<ProbabilityResult | null>(null),
    acquisition = $state<ProbabilityResult | null>(null);
  let summaryError = $state(''),
    acquisitionError = $state('');
  let community = $state<CommunityComparison | null>(null),
    communityError = $state(''),
    communityLoading = $state(false);
  let assumedModel = $state<'dolls' | 'weapons'>('dolls');
  let budget = $state<number | undefined>(DEFAULT_PLANNER_BUDGET),
    reward = $state<Reward>(DEFAULT_REWARD);
  let pity = $state<number | undefined>(0),
    guarantee = $state(false),
    pityOverride = $state(false),
    guaranteeOverride = $state(false);
  let planner = $state<ProbabilityResult | null>(null),
    plannerError = $state(''),
    plannerLoading = $state(false),
    explanationOpen = $state(false);
  let explanation: HTMLDetailsElement | undefined;
  async function showExplanation(event: MouseEvent) {
    event.preventDefault();
    explanationOpen = true;
    await tick();
    explanation?.focus();
    explanation?.scrollIntoView({ block: 'start' });
  }
  const h = $derived(response?.summary ?? null);
  const supported = $derived(h?.typeId === 3 || h?.typeId === 4);
  const model = $derived(
    h?.typeId === 4 ? MODELS.weapons : h?.typeId === 3 ? MODELS.dolls : MODELS[assumedModel]
  );
  const noun = $derived(h?.typeId === 4 ? 'weapons' : h?.typeId === 3 ? 'dolls' : 'rewards');
  const knownPity = $derived(
    supported &&
      h?.currentPity !== null &&
      h?.currentPity !== undefined &&
      h.currentPity < model.max
  );
  const knownGuarantee = $derived(supported && typeof h?.currentGuarantee === 'boolean');
  const planned = $derived(planner?.[reward]);
  const plannerValid = $derived(
    budget !== undefined &&
      Number.isInteger(budget) &&
      budget >= 0 &&
      budget <= 20000 &&
      pity !== undefined &&
      Number.isInteger(pity) &&
      pity >= 0 &&
      pity < model.max
  );
  const num = (n: number) => n.toLocaleString();
  const pct = (n: number | undefined) =>
    n === undefined ? 'Not available' : n > 0 && n < 0.001 ? '<0.1%' : `${(n * 100).toFixed(1)}%`;
  const typeName = (n: number) =>
    n === 3 ? 'Targeted dolls' : n === 4 ? 'Targeted weapons' : `Recruitment type ${n}`;
  const message = (e: unknown) =>
    e instanceof Error
      ? e.message
      : 'This calculation could not finish. Change the inputs to try again.';
  function reason(key: MetricKey, metric: ProbabilityMetric | undefined, error = '') {
    if (error) return error;
    if (!supported) return 'No probability model is available for this recruitment category.';
    if (metric?.error)
      return 'This comparison exceeds the model or calculation limits. Other results are unaffected.';
    if (key === 'wins')
      return 'No non-guaranteed rate-up attempts can be classified in this history.';
    return (
      h?.windowReasons[key] || 'No continuous history with a known starting state is available.'
    );
  }
  function resetPlanner() {
    pity = knownPity ? h!.currentPity! : 0;
    guarantee = knownGuarantee ? h!.currentGuarantee! : false;
    pityOverride = false;
    guaranteeOverride = false;
  }
  function comparisonWindow(w: import('$lib/statistics/history-types').ComparisonWindow | null) {
    return w
      ? { budget: w.budget, count: w.count, startingPity: w.startingPity, guaranteed: w.guaranteed }
      : null;
  }
  function selectProfile() {
    typeId = null;
    onprofilechange?.(profileId);
  }
  function modelPmf(p: ProbabilityParameters) {
    let survival = 1;
    const d = new Float64Array(p.max + 1);
    for (let i = 1; i <= p.max; i++) {
      const chance =
        i < p.soft ? p.base : p.base + ((1 - p.base) * (i - p.soft)) / (p.max - p.soft);
      d[i] = survival * chance;
      survival *= 1 - chance;
    }
    return d;
  }
  $effect(() => {
    const next = activeProfileId;
    untrack(() => {
      profileId = next || profiles[0]?.id || '';
      typeId = null;
    });
  });
  $effect(() => {
    const id = profileId,
      selected = typeId,
      version = revision,
      attempt = retry;
    void version;
    void attempt;
    let cancelled = false;
    response = null;
    loadError = '';
    loading = Boolean(id);
    if (id)
      query(id, selected)
        .then((value) => {
          if (!cancelled) response = value;
        })
        .catch((e) => {
          if (!cancelled) loadError = message(e);
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    return () => {
      cancelled = true;
    };
  });
  $effect(() => {
    const history = response;
    const p = model;
    void history;
    void p;
    untrack(resetPlanner);
  });
  // Separate workers isolate failed or expensive dimensions and terminate stale calculations.
  $effect(() => {
    // Svelte deep state proxies cannot cross the structured-clone worker boundary.
    // Snapshot only the aggregate summary; raw recruitment records never enter this component.
    const history = $state.snapshot(h),
      p = model,
      usable = supported;
    let cancelled = false;
    const clients: ProbabilityClient[] = [];
    summary = null;
    acquisition = null;
    summaryError = '';
    acquisitionError = '';
    if (history?.total && usable)
      void import('$lib/statistics/probability-client')
        .then(({ createProbabilityClient }) => {
          if (cancelled) return;
          const s = createProbabilityClient(),
            a = createProbabilityClient();
          clients.push(s, a);
          void s
            .run({ method: 'summary', p, windows: history.windows, wins: history.wins })
            .then((v) => {
              if (!cancelled) summary = v;
            })
            .catch((e) => {
              if (!cancelled) summaryError = message(e);
            });
          void a
            .run({
              method: 'acquisition',
              p,
              intervals: history.intervals,
              featuredIntervals: history.featuredIntervals,
              wins: history.wins
            })
            .then((v) => {
              if (!cancelled) acquisition = v;
            })
            .catch((e) => {
              if (!cancelled) acquisitionError = message(e);
            });
        })
        .catch((e) => {
          if (!cancelled) {
            summaryError = message(e);
            acquisitionError = message(e);
          }
        });
    return () => {
      cancelled = true;
      clients.forEach((c) => c.dispose());
    };
  });
  $effect(() => {
    const data = response,
      api = publicApi,
      accounts = verifiedAccounts,
      usable = supported;
    const controller = new AbortController();
    community = null;
    communityError = '';
    communityLoading = false;
    if (data && usable && data.summary.total) {
      const identity = data.identity;
      if (identity.endpoint_host && identity.server && identity.game_channel_id) {
        const same = identity.account_fingerprint
          ? accounts.find(
              (a) =>
                a.identity.account_fingerprint === identity.account_fingerprint &&
                a.identity.endpoint_host === identity.endpoint_host &&
                a.identity.server === identity.server &&
                a.identity.game_channel_id === identity.game_channel_id
            )
          : undefined;
        communityLoading = true;
        void api
          .compareStatistics(
            {
              endpoint_host: identity.endpoint_host,
              server: identity.server,
              game_channel_id: identity.game_channel_id,
              type_id: data.selectedType!,
              rules_version: data.rulesVersion,
              elite: comparisonWindow(data.summary.windows.elite),
              featured: comparisonWindow(data.summary.windows.featured),
              wins: data.summary.wins.trials
                ? { wins: data.summary.wins.wins, trials: data.summary.wins.trials }
                : null,
              ...(same ? { exclude_account_id: same.account_id } : {})
            },
            controller.signal
          )
          .then((value) => {
            if (!controller.signal.aborted) community = value;
          })
          .catch(() => {
            if (!controller.signal.aborted)
              communityError =
                'Community comparison could not load. Your local results remain available.';
          })
          .finally(() => {
            if (!controller.signal.aborted) communityLoading = false;
          });
      } else
        communityError =
          'A complete server and region identity is needed to find comparable histories.';
    }
    return () => controller.abort();
  });
  $effect(() => {
    const p = model,
      b = budget,
      s = pity,
      g = guarantee,
      valid = plannerValid;
    let cancelled = false,
      client: ProbabilityClient | undefined;
    planner = null;
    plannerError = '';
    plannerLoading = valid;
    if (valid)
      void import('$lib/statistics/probability-client')
        .then(({ createProbabilityClient }) => {
          if (cancelled) return;
          client = createProbabilityClient();
          return client
            .run({ method: 'planner', p, budget: b!, startingPity: s!, guaranteed: g })
            .then((v) => {
              if (!cancelled) planner = v;
            });
        })
        .catch((e) => {
          if (!cancelled) plannerError = message(e);
        })
        .finally(() => {
          if (!cancelled) plannerLoading = false;
        });
    return () => {
      cancelled = true;
      client?.dispose();
    };
  });
</script>

<section class="personal-statistics" aria-label="Your statistics">
  <div class="toolbar">
    <label class="profile-field"
      >History profile<select
        bind:value={profileId}
        onchange={selectProfile}
        disabled={!profiles.length}
        >{#each profiles as profile}<option value={profile.id}>{profile.name}</option
          >{/each}</select
      ></label
    >
    <label
      >Recruitment history<select
        value={typeId ?? response?.selectedType ?? ''}
        onchange={(e) => (typeId = Number(e.currentTarget.value))}
        disabled={loading || !response?.types.length}
        >{#each response?.types ?? [] as type}<option value={type}>{typeName(type)}</option
          >{/each}</select
      ></label
    >
    <a class="import-link" href="/history">Import history</a>
  </div>
  <p class="data-note">
    Your saved history is analyzed on this device. Community comparisons send aggregate windows and
    counts only, never raw recruitment records.
  </p>
  {#if loading}<p role="status" class="loading-status">Reading your saved statistics…</p>{/if}
  {#if loadError}<p role="alert" class="error">{loadError}</p>
    <button onclick={() => retry++}>Retry statistics</button>{/if}
  <section class="history-summary" aria-label="History summary">
    <div><span>Recorded pulls</span><strong>{num(h?.total ?? 0)}</strong></div>
    <div><span>5★ recruited</span><strong>{num(h?.eliteCount ?? 0)}</strong></div>
    <div>
      <span>Featured recruited</span><strong
        >{num(h?.featuredCount ?? 0)}{h?.unknownFeaturedCount ? ' known' : ''}</strong
      >
    </div>
    <div>
      <span>Current pity</span><strong
        >{h?.currentPity === null || !h ? 'Unknown' : `${h.currentPity} pulls`}</strong
      >
    </div>
    <p>
      Completed 5★ intervals: {h?.intervals.length ?? 0} of {h?.eliteCount ?? 0} · {h?.excludedCount ??
        0} uncertain intervals excluded{h?.unknownFeaturedCount
        ? ` · ${h.unknownFeaturedCount} featured identities unknown`
        : ''}. Current pity is included in summary windows when its starting state is known.
    </p>
  </section>
  <section aria-labelledby="luck-title">
    <div class="section-heading">
      <div>
        <h2 id="luck-title">Luck statistics</h2>
        <p>Probability-model comparisons and other accounts are separate sources.</p>
      </div>
      <a href="#statistics-math" onclick={showExplanation}>How it works</a>
    </div>
    {#if h?.total && !supported}<p class="notice">
        No probability model is available for {h.name || 'this recruitment category'}. Recorded
        results remain visible; planning below uses an explicitly chosen model and assumed starting
        state.
      </p>{/if}
    <div role="table" aria-label="Luck statistics comparisons" aria-colcount="3">
      <div class="table-head" role="row">
        <span role="columnheader">Your result</span><span role="columnheader"
          >Probability model</span
        ><span role="columnheader">Other accounts</span>
      </div>
      <div class="metrics" role="rowgroup">
        {#if !h?.total}<div role="row" class="empty">
            <div role="cell" aria-colspan="3">
              <h3>No recorded history</h3>
              <p>
                <a href="/history">Import your history</a> to see comparisons. Planning is available below.
              </p>
            </div>
          </div>
        {:else}{#each keys as key}
            {@const metric = summary?.[key]}{@const window =
              key === 'wins' ? null : h.windows[key]}{@const n =
              key === 'wins' ? h.wins.trials : (window?.count ?? 0)}{@const peer =
              community?.metrics[key]}
            <div class="metric" role="row">
              <div class="metric-main" role="rowheader">
                <h3 class="metric-title">{titles[key]}</h3>
                <strong class="result"
                  >{key === 'wins'
                    ? `${h.wins.wins} of ${h.wins.trials}`
                    : window
                      ? `${num(window.count)} ${key === 'elite' ? '× 5★' : 'featured'} in ${num(window.budget)} pulls`
                      : 'Not available'}</strong
                >
                <span class="result-support"
                  >{key === 'wins'
                    ? `Rate-ups won · ${h.wins.guaranteed} guaranteed 5★ excluded`
                    : metric && !metric.missing
                      ? `Model average: ${metric.expected.toFixed(1)} ${key === 'elite' ? '5★' : 'featured'} for this budget`
                      : 'Latest continuous stretch with a known start'}</span
                >
                {#if key === 'featured'}<span class="result-support"
                    >Combines acquisition timing and rate-up outcomes</span
                  >{/if}
                <span class="coverage-line"
                  >{key === 'wins'
                    ? `${h.wins.unknown} 5★ outcomes unclassified`
                    : window
                      ? `Used: ${num(window.budget)} of ${num(h.total)} recorded pulls · starting pity ${window.startingPity}${key === 'featured' ? `, ${window.guaranteed ? 'guaranteed' : 'not guaranteed'}` : ''}`
                      : reason(key, metric)}</span
                >
              </div>
              <div role="cell" class:quiet={n < 10} class="comparison">
                <span class="comparison-label">Probability model</span>
                {#if metric && !metric.missing && metric.tail !== undefined}<strong
                    >{pct(metric.tail)}</strong
                  ><StatisticsLuckScale tail={metric.tail} source="Probability model" /><small
                    >Chance of this result or better.{metric.tail > 0 && metric.tail < 0.001
                      ? ` About 1 in ${num(Math.round(1 / metric.tail))} model outcomes.`
                      : ''}</small
                  >{#if n < 10}<span class="sample-warning"
                      >Based on {n} {key === 'wins' ? 'attempts' : 'rewards'} — small sample</span
                    >{/if}
                {:else}<strong class="unavailable"
                    >{!summary && !summaryError && supported
                      ? 'Calculating…'
                      : 'Not available'}</strong
                  ><small>{reason(key, metric, summaryError)}</small>{/if}
              </div>
              <div role="cell" class="comparison community">
                <span class="comparison-label">Other accounts</span>
                {#if peer?.status === 'ok' && peer.contributors !== null && peer.better_or_equal !== null}<strong
                    >{num(peer.better_or_equal)} of {num(peer.contributors)}</strong
                  >{#if peer.contributors >= 50 && peer.percentage !== null}<StatisticsLuckScale
                      tail={peer.percentage}
                      source="Other saved accounts"
                    />{/if}<small
                    >Did as well or better{peer.contributors >= 50 && peer.percentage !== null
                      ? ` (${pct(peer.percentage)})`
                      : '. Counts only for fewer than 50 histories'}.</small
                  ><small
                    >{key === 'wins'
                      ? 'Same number of non-guaranteed attempts.'
                      : 'Same pull budget, starting state and recruitment model.'}</small
                  >
                {:else}<strong class="unavailable"
                    >{communityLoading
                      ? 'Loading…'
                      : peer?.status === 'insufficient_cohort'
                        ? 'Not enough histories'
                        : 'Not available'}</strong
                  ><small
                    >{communityError ||
                      peer?.reason ||
                      (!supported
                        ? 'No supported model for this category.'
                        : 'No comparable saved histories are available.')}</small
                  >{/if}
              </div>
            </div>
          {/each}{/if}
      </div>
    </div>
    <p class="section-foot">
      Equal results count as matching yours. Bars show the share of outcomes strictly below yours.
      Each result shows the history used for its comparison.{community?.self_excluded
        ? ' Your verified account is excluded from the comparison.'
        : community
          ? ' These saved accounts may include your account; this profile is not verified in the current session.'
          : ''}
    </p>
  </section>
  <section aria-labelledby="distribution-title">
    <div class="section-heading">
      <div>
        <h2 id="distribution-title">Pull distributions</h2>
        <p>Completed acquisitions only. The summary above also includes unfinished current pity.</p>
      </div>
    </div>
    {#if h?.total}<article class="distribution-panel observed-panel">
        <h3>When your 5★ {noun} arrived</h3>
        {@html charts.observed({
          key: 'personal-observed',
          title: `When your 5★ ${noun} arrived`,
          intervals: h.intervals,
          modelPmf: supported ? modelPmf(model) : null,
          max: supported ? model.max : h.intervals.reduce((max, n) => Math.max(max, n), 1),
          soft: supported ? model.soft : null
        })}
        <details class="chart-explanation">
          <summary>About these intervals</summary>
          <p>
            Observed bars use complete intervals from all eligible stretches; they exclude uncertain
            intervals and current unfinished pity.
          </p>
        </details>
      </article>
      <div class="distribution-grid">
        {#each keys as key}{@const metric = acquisition?.[key]}{@const count =
            key === 'elite'
              ? h.intervals.length
              : key === 'featured'
                ? h.featuredIntervals.length
                : h.wins.trials}{@const title =
            key === 'wins'
              ? `Rate-up wins in ${count} attempts`
              : `Pulls needed for ${count} ${key === 'elite' ? '× 5★' : 'featured'} ${noun}`}
          <article class="distribution-panel">
            <h3>{title}</h3>
            {#if metric && !metric.missing}{@html charts.distribution({
                key: `personal-${key}`,
                title,
                dist: metric.dist,
                expected: metric.expected,
                observation: metric.observation,
                tail: metric.tail,
                direction: key === 'wins' ? 'upper' : 'lower',
                axisLabel: key === 'wins' ? 'Non-guaranteed wins' : 'Total pulls'
              })}{:else}<p class="chart-unavailable">
                {!acquisition && !acquisitionError && supported
                  ? 'Calculating…'
                  : reason(key, metric, acquisitionError)}
              </p>{/if}
            <details class="chart-explanation">
              <summary>About this comparison</summary>
              <p>
                {key === 'wins'
                  ? 'Guaranteed rewards are excluded. Only classifiable non-guaranteed attempts are counted.'
                  : 'This distribution uses completed acquisitions. The summary includes trailing pity in its latest valid history window, so its probability can differ.'}
              </p>
            </details>
          </article>{/each}
      </div>
    {:else}<p class="empty">No history to chart. Planning is available below.</p>{/if}
  </section>
  <section class="planning" aria-labelledby="planning-title">
    <div class="section-heading">
      <div>
        <h2 id="planning-title">Planning</h2>
        <p>
          What additional pulls could give you under the {model === MODELS.weapons
            ? 'weapon'
            : 'doll'} model.
        </p>
      </div>
    </div>
    <div class="planner-controls">
      {#if !supported}<label
          >Planning model<select bind:value={assumedModel}
            ><option value="dolls">Doll model</option><option value="weapons">Weapon model</option
            ></select
          ></label
        >{/if}
      <label
        >Additional pulls<input
          type="number"
          min="0"
          max="20000"
          step="1"
          inputmode="numeric"
          bind:value={budget}
        /></label
      >
      <label
        >Rewards<select bind:value={reward}
          ><option value="featured">Featured</option><option value="elite">All 5★</option></select
        ></label
      >
      <label
        >Starting pity<input
          type="number"
          min="0"
          max={model.max - 1}
          step="1"
          inputmode="numeric"
          bind:value={pity}
          oninput={() => (pityOverride = true)}
        /></label
      >
      <label
        >Starting guarantee<select
          bind:value={guarantee}
          onchange={() => (guaranteeOverride = true)}
          ><option value={false}>Not guaranteed</option><option value={true}>Guaranteed</option
          ></select
        ></label
      >
      <button onclick={resetPlanner}
        >{supported ? 'Use history state' : 'Reset assumed state'}</button
      >
    </div>
    <p class="notice">
      Starting pity {pity ?? '—'} ({pityOverride
        ? 'your override'
        : knownPity
          ? 'from history'
          : 'assumed; history does not establish it'}) · {guarantee
        ? 'Guaranteed'
        : 'Not guaranteed'} ({guaranteeOverride
        ? 'your override'
        : knownGuarantee
          ? 'from history'
          : 'assumed; history does not establish it'}).
    </p>
    {#if !plannerValid}<p role="status" class="error">
        Enter 0–20,000 additional pulls and starting pity from 0 to {model.max - 1}.
      </p>{:else if plannerError}<p role="alert" class="error">
        {plannerError}
      </p>{:else if plannerLoading}<p role="status" class="empty">
        Calculating your plan…
      </p>{:else if planned}
      <div class="planner-stats">
        <div>
          <span>Model average</span><strong
            >{planned.missing ? 'Not available' : `${planned.expected.toFixed(1)} rewards`}</strong
          >
        </div>
        <div>
          <span>Middle 90% range</span><strong
            >{planned.missing ? 'Not available' : `${planned.low}–${planned.high} rewards`}</strong
          >
        </div>
        <div>
          <span>Chance of at least 1 featured</span><strong
            >{planner?.featured.missing
              ? 'Not available'
              : pct(planner?.featured.chanceAtLeastOne)}</strong
          >
        </div>
      </div>
      <article class="distribution-panel planner-chart">
        <h3>{reward === 'elite' ? '5★' : 'Featured'} rewards from {num(budget ?? 0)} more pulls</h3>
        {#if !planned.missing}{@html charts.distribution({
            key: 'personal-planner',
            title: `${reward === 'elite' ? '5★' : 'Featured'} rewards from ${budget} more pulls`,
            dist: planned.dist,
            expected: planned.expected,
            direction: 'upper',
            axisLabel: 'Rewards',
            planner: true
          })}{#if planned.omittedMassBound}<p class="section-foot">
              Omitted model tail ≤ {planned.omittedMassBound.toExponential(1)} probability.
            </p>{/if}{:else}<p class="chart-unavailable">
            This distribution exceeds the calculation limit. Reduce the pull budget to chart it.
          </p>{/if}
      </article>
    {/if}
    <p class="section-foot">
      Based on the selected probability model and the starting state shown above. Past results do
      not change these odds.
    </p>
  </section>
  <details id="statistics-math" bind:this={explanation} bind:open={explanationOpen} tabindex="-1">
    <summary
      >How this is calculated<svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d="m6 8 4 4 4-4" /></svg
      ></summary
    >
    <div class="math-body">
      <h3>Where these numbers come from</h3>
      <dl>
        <dt>Model assumptions</dt>
        <dd>
          {(model.base * 100).toFixed(1)}% base 5★ probability; the selected model stays at the base
          rate through pull {model.soft}, then rises linearly to 100% at {model.max}. Non-guaranteed
          featured probability: {model.p * 100}%. These are model assumptions, not independently
          verified published rates.
        </dd>
        <dt>Summary versus acquisition charts</dt>
        <dd>
          The summary uses the latest continuous stretch with a known starting state, including
          pulls after the last 5★. Acquisition charts use completed intervals from eligible
          stretches. These are model comparisons, not ranks among players; how a history was
          selected can affect their interpretation.
        </dd>
        <dt>Featured results</dt>
        <dd>
          Featured acquisition combines when 5★ rewards arrived and which were featured. It overlaps
          with overall 5★ acquisition. Guarantees are excluded from rate-up attempts; unclassified
          outcomes remain unknown.
        </dd>
        <dt>Other accounts and privacy</dt>
        <dd>
          Comparisons use real server-saved histories with the same recruitment model, pull budget
          and starting state, or the same rate-up attempt count. Counts are hidden below the privacy
          threshold and percentages below 50 comparable histories. Privacy-protected results show no
          luck bar. A verified account is excluded only when its complete identity matches this
          profile. Imported histories are not independently verified, and sharing and coverage
          differences can affect comparisons. Aggregate windows and counts are sent for this
          comparison; raw personal records stay on this device.
        </dd>
        <dt>Coverage and unknown state</dt>
        <dd>
          A gap or unclassified record can invalidate a comparison window. A later reward can
          establish a new starting state; that establishing reward is excluded from the new window.
          Featured results use banner mappings or the standard five-star loss pool. Guaranteed
          rewards are counted separately from rate-up wins. Unsupported providers and unresolved
          standard-item rate-up banners remain unknown.
        </dd>
        <dt>Planning</dt>
        <dd>
          The first reward is conditional on starting pity and guarantee state. Later rewards follow
          the usual model. The range uses the 5th and 95th percentiles and can contain more than 90%
          of outcomes because reward counts are discrete. Planner inputs are assumptions where saved
          history cannot establish them.
        </dd>
      </dl>
    </div>
  </details>
</section>

<style>
  .history-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px 28px;
    padding: 18px 0 20px;
    border-block: 1px solid var(--line);
    border-bottom: 2px solid #20252b;
  }
  .history-summary > div {
    display: grid;
    gap: 4px;
  }
  .history-summary span {
    font-size: 13px;
    color: var(--muted);
  }
  .history-summary strong {
    font-family: 'Barlow Condensed';
    font-weight: 600;
    font-size: 30px;
    font-variant-numeric: tabular-nums;
  }
  .history-summary > p {
    grid-column: 1/-1;
    font-size: 13px;
    color: var(--muted);
    max-width: none;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin: 28px 0 18px;
  }
  .section-heading p {
    font-size: 14px;
    color: var(--muted);
  }
  .section-heading a {
    font-size: 14px;
    white-space: nowrap;
  }
  .table-head {
    display: grid;
    grid-template-columns: 1.2fr 1fr 1fr;
    gap: 24px;
    padding: 12px 16px;
    background: #20252b;
    color: #fbfcfd;
    font-size: 13px;
  }
  .metric {
    display: grid;
    grid-template-columns: 1.2fr 1fr 1fr;
    gap: 24px;
    padding: 18px 16px;
    border-bottom: 1px solid var(--line);
  }
  .metric-title {
    font-family: Barlow;
    font-size: 14px;
    letter-spacing: 0;
  }
  .result {
    font-family: 'Barlow Condensed';
    font-size: 28px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    display: block;
    margin: 7px 0;
  }
  .result-support,
  .coverage-line,
  .comparison small {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
    display: block;
  }
  .coverage-line {
    margin-top: 6px;
  }
  .comparison {
    align-self: center;
  }
  .comparison-label {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 5px;
  }
  .comparison strong {
    display: block;
    font-family: 'Barlow Condensed';
    font-size: 28px;
    color: var(--orange);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .comparison.community strong {
    color: var(--slate);
  }
  .comparison small {
    margin-top: 5px;
  }
  .comparison .unavailable {
    font-size: 20px;
    color: var(--muted);
  }
  .comparison.quiet strong {
    color: #20252b;
    font-size: 23px;
  }
  .sample-warning {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
  }
  .section-foot {
    font-size: 12px;
    color: var(--muted);
    margin: 12px 0 22px;
  }
  .empty {
    padding: 25px 0;
    font-size: 14px;
    color: var(--muted);
  }
  .empty h3 {
    color: #20252b;
  }
  .distribution-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 24px;
  }
  .distribution-panel {
    min-width: 0;
    border-top: 1px solid var(--line);
    padding: 20px 0;
  }
  .distribution-panel > h3 {
    font-size: 25px;
  }
  .chart-unavailable {
    color: var(--muted);
    font-size: 13px;
    min-height: 130px;
    padding: 18px 0;
  }
  .observed-panel {
    max-width: 850px;
    margin-bottom: 22px;
  }
  .planning {
    margin-top: 25px;
    border-top: 2px solid #20252b;
  }
  .planner-controls {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    gap: 12px;
  }
  .planner-controls label {
    flex: 1;
    min-width: 140px;
  }
  .planner-controls input,
  .planner-controls select {
    width: 100%;
  }
  .planner-controls button {
    font-size: 13px;
  }
  .planner-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 22px;
    margin: 22px 0;
  }
  .planner-stats span {
    display: block;
    font-size: 13px;
    color: var(--muted);
  }
  .planner-stats strong {
    display: block;
    font-size: 27px;
    font-family: 'Barlow Condensed';
    font-weight: 600;
    margin-top: 5px;
  }
  .planner-chart {
    max-width: 850px;
  }
  .chart-explanation {
    border: 0;
    margin-top: 10px;
  }
  .chart-explanation p {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 14px;
  }
  details {
    border-block: 1px solid var(--line);
  }
  summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    list-style: none;
    font-size: 14px;
    font-weight: 600;
    padding: 16px 0;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  details[open] > summary svg {
    transform: rotate(180deg);
  }
  .math-body {
    padding: 12px 0 26px;
    max-width: 75ch;
  }
  .math-body dt {
    font-size: 14px;
    font-weight: 600;
    margin-top: 20px;
  }
  .math-body dd {
    font-size: 14px;
    color: var(--muted);
    line-height: 1.6;
    margin: 5px 0 0;
  }
  .loading-status {
    position: absolute;
    top: 0;
    right: 0;
    margin: 0;
    padding: 4px 8px;
    background: var(--paper, #f0f2f4);
    font-size: 0.8rem;
  }
  .personal-statistics {
    position: relative;
    --orange: #a64000;
    --muted: #555e68;
    --line: #c3c9d0;
    --slate: #526273;
    color: #20252b;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 12px;
  }
  .toolbar > label {
    flex: 1;
    min-width: 160px;
  }
  .toolbar .profile-field {
    flex: 1.25;
    min-width: 230px;
  }
  .toolbar select {
    width: 100%;
  }
  .import-link {
    display: inline-flex;
    align-items: center;
    min-height: 42px;
    padding: 9px 12px;
  }
  .data-note {
    font-size: 13px;
    color: var(--muted);
    margin: 12px 0 22px;
  }
  .error {
    color: #a62932;
  }
  .notice {
    background: #e3e7eb;
    padding: 10px 13px;
    font-size: 13px;
    line-height: 1.5;
    margin: 14px 0;
    max-width: none;
  }
  button,
  select,
  input {
    font: inherit;
    color: inherit;
    border: 1px solid #7a8591;
    border-radius: 3px;
    min-height: 42px;
    background: #fbfcfd;
    padding: 9px 12px;
    max-width: 100%;
  }
  button,
  select,
  summary {
    cursor: pointer;
  }
  input {
    caret-color: var(--orange);
  }
  button {
    font-weight: 600;
    background: transparent;
  }
  button:hover {
    background: #dce2e8;
  }
  button:disabled,
  select:disabled {
    opacity: 0.55;
    cursor: default;
  }
  a {
    color: var(--orange);
    text-underline-offset: 4px;
  }
  :is(a, button, select, input, summary):focus-visible {
    outline: 3px solid var(--orange);
    outline-offset: 3px;
  }
  label {
    font-size: 13px;
    font-weight: 600;
    display: grid;
    gap: 6px;
  }
  p {
    line-height: 1.5;
    margin: 8px 0 0;
    max-width: 75ch;
  }
  h2,
  h3 {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0;
    text-wrap: balance;
  }
  h2 {
    font-size: 31px;
  }
  h3 {
    font-size: 24px;
  }
  .quiet {
    --luck-color: #6f7d8a;
  }
  .community {
    --luck-color: #526273;
  }
  @media (min-width: 651px) {
    .comparison-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  }
  @media (max-width: 1000px) {
    .distribution-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .distribution-grid > .distribution-panel:last-child {
      grid-column: 1/-1;
      max-width: 600px;
    }
    .table-head,
    .metric {
      gap: 18px;
      grid-template-columns: 1.1fr 1fr 1fr;
    }
  }
  @media (max-width: 650px) {
    .toolbar > label,
    .toolbar .profile-field {
      min-width: 100%;
      width: 100%;
    }
    h2 {
      font-size: 28px;
    }
    .history-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .history-summary strong {
      font-size: 27px;
    }
    .section-heading {
      display: block;
      margin-top: 25px;
    }
    .section-heading a {
      display: inline-block;
      margin-top: 9px;
    }
    .section-heading p {
      font-size: 13px;
    }
    .table-head {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .metrics {
      display: block;
    }
    .metric {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      padding: 19px 0;
    }
    .metric-main {
      grid-column: 1/-1;
    }
    .result {
      font-size: 27px;
    }
    .comparison {
      align-self: start;
    }
    .comparison strong {
      font-size: 25px;
    }
    .distribution-grid {
      display: block;
    }
    .distribution-panel > h3 {
      font-size: 25px;
    }
    .observed-panel {
      margin-bottom: 10px;
    }
    .planner-controls {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .planner-controls label {
      min-width: 0;
    }
    .planner-controls button {
      grid-column: 1/-1;
    }
    .planner-stats {
      gap: 14px;
      grid-template-columns: 1fr 1fr;
    }
    .planner-stats > div:last-child {
      grid-column: 1/-1;
    }
    .planner-stats strong {
      font-size: 26px;
    }
    .planner-stats span {
      font-size: 12px;
    }
    .chart-unavailable {
      min-height: 70px;
    }
    .notice {
      font-size: 12px;
    }
    .math-body dd {
      font-size: 13px;
    }
  }
</style>
