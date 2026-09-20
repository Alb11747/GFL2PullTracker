<script lang="ts">
  import { onMount } from 'svelte';
  import { createPublicClient, type PublicClient, type CommunityStatistics } from '$lib/public-api';
  let { publicApi }: { publicApi?: PublicClient } = $props();
  let statistics = $state<CommunityStatistics | null>(null),
    loading = $state(true),
    error = $state('');
  let server = $state(''),
    source = $state(''),
    pool = $state('');
  type Breakdown = {
    endpoint_host: string;
    server: string;
    type_id: number;
    pool_id: number;
    contributors: number;
    total: number;
    rarities: { rarity: string; count: number; rate: number }[];
    items: { item_id: number; count: number }[];
    pity: { pulls: number; count: number }[];
    observed_pity_count: number;
    average_observed_pity: number | null;
  };
  const groups = $derived((statistics?.breakdowns ?? []) as unknown as Breakdown[]);
  const servers = $derived([
    ...new Set(groups.map((group) => `${group.endpoint_host}|${group.server}`))
  ]);
  const types = $derived(
    [
      ...new Set(
        groups
          .filter((group) => !server || `${group.endpoint_host}|${group.server}` === server)
          .map((group) => group.type_id)
      )
    ].sort((a, b) => a - b)
  );
  const pools = $derived(
    [
      ...new Set(
        groups
          .filter(
            (group) =>
              (!server || `${group.endpoint_host}|${group.server}` === server) &&
              (!source || String(group.type_id) === source)
          )
          .map((group) => group.pool_id)
      )
    ].sort((a, b) => a - b)
  );
  const selected = $derived(
    groups.filter(
      (group) =>
        (!server || `${group.endpoint_host}|${group.server}` === server) &&
        (!source || String(group.type_id) === source) &&
        (!pool || String(group.pool_id) === pool)
    )
  );
  const number = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
  const rate = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—');
  async function load() {
    loading = true;
    error = '';
    try {
      statistics = await (publicApi ?? createPublicClient()).statistics();
    } catch (cause) {
      statistics = null;
      error =
        cause instanceof Error
          ? cause.message
          : 'Community statistics could not load. Try again later.';
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
  });
</script>

<section class="community" aria-labelledby="community-heading" aria-busy={loading}>
  <header>
    <div>
      <h2 id="community-heading">Community statistics</h2>
      <p>
        Recruitment results contributed by players, fetched directly from official game services.
      </p>
    </div>
    <button disabled={loading} onclick={load}>{loading ? 'Loading…' : 'Refresh statistics'}</button>
  </header>
  <p class="context">
    These results cover accessible history, not every pull ever made. They describe this sample and
    do not predict your next recruitment result. Private histories and account identities are never
    listed here. Small rarity, item, and pity groups are also hidden, so published shares may not
    add up to 100%.
  </p>
  {#if loading}<p class="empty" role="status">Loading the community ledger…</p>
  {:else if error}<p class="empty error" role="alert">{error}</p>
  {:else if statistics?.suppressed}<div class="empty">
      <h3>Waiting for a larger sample</h3>
      <p>
        Results appear once at least {statistics.minimum_contributors} independent accounts contribute.
        Smaller groups remain hidden to protect individual histories.
      </p>
    </div>
  {:else if statistics}
    <dl class="totals">
      <div>
        <dt>Contributing accounts</dt>
        <dd>{number(statistics.contributors)}</dd>
      </div>
      <div>
        <dt>Recorded pulls</dt>
        <dd>{number(statistics.total)}</dd>
      </div>
      <div>
        <dt>Privacy threshold</dt>
        <dd>{number(statistics.minimum_contributors)} accounts per group</dd>
      </div>
    </dl>
    <div class="filters">
      <label
        >Server<select
          bind:value={server}
          onchange={() => {
            source = '';
            pool = '';
          }}
          ><option value="">All servers</option>{#each servers as item}<option value={item}
              >{item.split('|')[1]} · {item.split('|')[0]}</option
            >{/each}</select
        ></label
      ><label
        >Source type<select bind:value={source} onchange={() => (pool = '')}
          ><option value="">All types</option>{#each types as item}<option value={String(item)}
              >Type {item}</option
            >{/each}</select
        ></label
      ><label
        >Pool<select bind:value={pool}
          ><option value="">All pools</option>{#each pools as item}<option value={String(item)}
              >Pool {item}</option
            >{/each}</select
        ></label
      >
    </div>
    {#if !selected.length}<p class="empty">
        No publishable groups match this selection. Groups with fewer than {statistics.minimum_contributors}
        contributing accounts are hidden.
      </p>{/if}
    {#each selected as group}
      <article>
        <h3>{group.server} · Type {group.type_id} · Pool {group.pool_id}</h3>
        <p class="group-meta">
          {group.endpoint_host} · {number(group.contributors)} accounts · {number(group.total)} pulls
        </p>
        <div class="distributions">
          <div>
            <h4>Rarity distribution</h4>
            <table>
              <thead><tr><th>Rarity</th><th>Pulls</th><th>Share</th></tr></thead><tbody
                >{#each group.rarities as rarity}<tr
                    ><th scope="row">{rarity.rarity}</th><td>{number(rarity.count)}</td><td
                      >{rate(rarity.rate)}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
          <div>
            <h4>Observed pity</h4>
            <p>
              {group.average_observed_pity === null
                ? 'No certain intervals available.'
                : `${group.average_observed_pity.toFixed(2)} pulls on average across ${number(group.observed_pity_count)} certain intervals.`}
            </p>
            <p class="group-meta">
              Intervals crossing coverage gaps or unknown rewards are excluded.
            </p>
            {#if group.pity.length}<details>
                <summary>View pity distribution</summary>
                <table>
                  <thead><tr><th>Pulls to Elite</th><th>Intervals</th></tr></thead><tbody
                    >{#each group.pity as row}<tr
                        ><th scope="row">{row.pulls}</th><td>{number(row.count)}</td></tr
                      >{/each}</tbody
                  >
                </table>
              </details>{/if}
          </div>
        </div>
        <details>
          <summary>View item distribution ({group.items.length} items)</summary>
          <div class="item-table">
            <table>
              <thead><tr><th>Item ID</th><th>Pulls</th><th>Share</th></tr></thead><tbody
                >{#each group.items as item}<tr
                    ><th scope="row">{item.item_id}</th><td>{number(item.count)}</td><td
                      >{group.total ? rate(item.count / group.total) : '—'}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
        </details>
      </article>
    {/each}
  {/if}
</section>

<style>
  .community {
    border-top: 2px solid var(--ink);
    padding-top: 24px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 24px;
  }
  h2 {
    margin: 0;
  }
  p {
    max-width: 74ch;
    line-height: 1.6;
  }
  header p {
    margin: 8px 0 16px;
  }
  header button {
    flex-shrink: 0;
  }
  .context,
  .group-meta {
    color: var(--muted);
  }
  .context {
    margin-bottom: 28px;
  }
  .empty {
    background: var(--olive);
    padding: 24px;
  }
  .empty h3 {
    margin: 0;
  }
  .empty p {
    margin-bottom: 0;
  }
  .error {
    color: #842c20;
  }
  .totals {
    display: grid;
    grid-template-columns: 1fr 1fr 1.5fr;
    border-block: 1px solid var(--line);
    margin: 24px 0;
    padding: 20px 0;
    gap: 24px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 6px 0 0;
    font-weight: 600;
    font-size: 1.3rem;
    font-variant-numeric: tabular-nums;
  }
  .filters {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 16px;
    margin: 24px 0;
  }
  label {
    display: grid;
    gap: 7px;
    min-width: 0;
    font-weight: 500;
  }
  select {
    width: 100%;
    min-width: 0;
  }
  article {
    padding: 24px 0;
    border-top: 1px solid var(--line);
  }
  h3 {
    margin: 0 0 6px;
  }
  h4 {
    font-weight: 600;
    margin: 16px 0;
    font-size: 1rem;
  }
  .group-meta {
    overflow-wrap: anywhere;
    font-size: 0.9rem;
    margin: 8px 0 16px;
  }
  .distributions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 48px;
    margin-bottom: 20px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 10px 12px;
    text-align: right;
    border-bottom: 1px solid var(--line);
  }
  th:first-child {
    text-align: left;
  }
  thead {
    background: var(--olive);
  }
  tbody th {
    font-weight: 400;
  }
  summary {
    cursor: pointer;
    padding: 10px 0;
    min-height: 40px;
    font-weight: 500;
  }
  summary:focus-visible {
    outline: 3px solid var(--red);
    outline-offset: 3px;
  }
  .item-table {
    max-height: 360px;
    overflow: auto;
  }
  @media (max-width: 760px) {
    header {
      flex-direction: column;
      gap: 8px;
    }
    .totals {
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    .totals > div:last-child {
      grid-column: 1 / -1;
    }
    .filters {
      grid-template-columns: 1fr 1fr;
    }
    .filters label:first-child {
      grid-column: 1 / -1;
    }
    .distributions {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }
</style>
