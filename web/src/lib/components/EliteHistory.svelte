<script lang="ts">
  import { onMount, tick } from 'svelte';
  import LoadingRegion from './LoadingRegion.svelte';
  import { recruitmentName } from '$lib/recruitment';
  import portraits from '$lib/portraits.json';
  import type { ProfileOverview } from '$lib/reward-query';
  import {
    readRewardRarities,
    rewardRarities,
    rewardRarity,
    REWARD_RARITIES_KEY,
    type RewardRarity
  } from '$lib/reward-history';

  export let query: (
    profileId: string,
    typeId: number | null,
    rarities: string[],
    offset: number,
    limit: number,
    options?: { consumer: string; preview: boolean }
  ) => Promise<ProfileOverview>;
  export let revision: string | number = 0;
  export let profileId = '';
  export let loading = false;
  export let error = '';

  let selectedType: number | null = null;
  let selectedId: number | null = null;
  const windowLimit = 200;
  let visibleBatches = 1;
  let showAll = false;
  let offset = 0;
  let mounted = false;
  let pending = false;
  let queryError = '';
  let retry = 0;
  let requestId = 0;
  let activeContext = '';
  let overview: ProfileOverview | null = null;
  let stale = false;
  let loadedProfile = '';
  let loadedTitle = '';
  let pagination: HTMLDivElement | undefined;
  let paginationHeight = 0;
  // Keep query controls mounted while loading another context.
  let types: number[] = [];
  let lastSelectedType: number | null = null;
  let availableRarityKeys: string[] = [];
  let historyHeading: HTMLHeadingElement;
  let focusWindow = false;
  let previewLimit = 8;
  let measured = false;
  let consumer = '';
  let selectedRarities: RewardRarity[] = ['Elite'];
  let dialog: HTMLDialogElement;
  let failedImages = new Set<number>();
  const imageMap = portraits as Record<string, string>;
  const uncertainty = 'History may be missing; pity is uncertain';
  const rarityLabels = [
    { key: 'Elite', label: '5★ Elite', color: '#bd7814' },
    { key: 'Standard', label: '4★ Standard', color: '#7b639a' },
    { key: 'Retired', label: '3★ Retired', color: '#597b96' },
    { key: 'Unknown', label: 'Unknown', color: '#7a8591' }
  ];
  const date = (value: string, full = false) =>
    new Date(value).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      ...(full ? { year: 'numeric' as const } : {})
    });

  // A context change invalidates details and pagination before dispatching a query.
  // Queries stay bounded, including when the user explicitly expands all rewards.
  $: context = JSON.stringify([profileId, revision, selectedType, selectedRarities]);
  $: resetContext(context);
  $: limit =
    showAll || offset > 0 ? windowLimit : Math.min(windowLimit, previewLimit * visibleBatches);
  $: void load(
    mounted && measured && !loading,
    query,
    context,
    profileId,
    selectedType,
    selectedRarities,
    offset,
    limit,
    showAll,
    retry
  );
  $: busy = loading || pending;
  // Rarity filters and pagination only affect reward cards, not recruitment statistics.
  $: summaryStale =
    stale &&
    (loadedProfile !== profileId ||
      (selectedType !== null && selectedType !== overview?.selectedType));
  $: failure = error || queryError;
  $: shown = overview?.items ?? [];
  $: selected = busy || failure ? undefined : shown.find((row) => row.id === selectedId);
  $: availableRarities = rewardRarities.filter(
    (rarity) =>
      rarity.key !== 'Unknown' ||
      selectedRarities.includes('Unknown') ||
      availableRarityKeys.includes('Unknown')
  );
  $: allRaritiesSelected = availableRarities.every((rarity) =>
    selectedRarities.includes(rarity.key)
  );
  $: historyTitle = selectedRarities.length
    ? `${rewardRarities
        .filter((rarity) => selectedRarities.includes(rarity.key))
        .map((rarity) => rarity.label)
        .join(' + ')} history`
    : 'Reward history';
  $: if (!selected && dialog?.open) dialog.close();
  $: breakdown = (overview?.breakdown ?? []).map((entry) => ({
    ...entry,
    ...rarityLabels.find((rarity) => rarity.key === entry.rarity)!
  }));
  $: totalPulls = breakdown.reduce((sum, rarity) => sum + rarity.count, 0);

  async function load(
    ready: boolean,
    fetchOverview: typeof query,
    _context: string,
    profile: string,
    type: number | null,
    rarities: string[],
    start: number,
    count: number,
    all: boolean,
    _retry: number
  ) {
    const id = ++requestId;
    if (!ready) {
      pending = false;
      return;
    }
    if (!profile) {
      overview = null;
      stale = false;
      types = [];
      pending = false;
      queryError = '';
      return;
    }
    pending = true;
    queryError = '';
    try {
      const result = await fetchOverview(profile, type, [...rarities], start, count, {
        consumer,
        preview: !all && start === 0 && count < windowLimit
      });
      if (!mounted || id !== requestId) return;
      if (all) {
        // Read sequential pages so Show all works in both browser and local-server mode.
        // Context changes or Show fewer cancel the remaining reads and discard stale results.
        while (result.items.length < result.total) {
          const page = await fetchOverview(
            profile,
            result.selectedType,
            [...rarities],
            result.items.length,
            windowLimit
          );
          if (!mounted || id !== requestId) return;
          if (!page.items.length || page.total !== result.total)
            throw new Error('Reward history changed while loading. Please try again.');
          result.items.push(...page.items);
        }
      }
      overview = result;
      loadedProfile = profile;
      stale = false;
      loadedTitle = historyTitle;
      types = result.types;
      lastSelectedType = result.selectedType;
      availableRarityKeys = result.availableRarities;
      if (focusWindow) {
        focusWindow = false;
        void tick().then(() => {
          if (mounted && id === requestId) historyHeading?.focus();
        });
      }
    } catch (cause) {
      if (!mounted || id !== requestId) return;
      if (stale) overview = null;
      stale = false;
      queryError = cause instanceof Error ? cause.message : 'Could not load recruitment history.';
    } finally {
      if (mounted && id === requestId) pending = false;
    }
  }

  function measureRows(node: HTMLElement) {
    let frame = 0;
    const measure = () => {
      const columns = getComputedStyle(node)
        .gridTemplateColumns.split(/\s+/)
        .filter(Boolean).length;
      previewLimit = Math.min(windowLimit, Math.max(1, columns) * 2);
      measured = true;
    };
    // Changing the preview count also changes this grid's height. Defer the
    // layout write until after ResizeObserver has delivered its notifications.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    measure();
    return {
      destroy: () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      }
    };
  }
  onMount(() => {
    consumer = crypto.randomUUID();
    try {
      selectedRarities = readRewardRarities(localStorage.getItem(REWARD_RARITIES_KEY));
    } catch {
      selectedRarities = ['Elite'];
    }
    mounted = true;
    return () => {
      mounted = false;
      requestId++;
    };
  });
  // IDs are scoped to a profile. Never retain a selection across query contexts.
  function resetContext(next: string) {
    if (activeContext === next) return;
    activeContext = next;
    // Keep the previous geometry during loading, but hide its data until the
    // new context succeeds. Clearing it here collapses the page between queries.
    if (!stale) paginationHeight = pagination?.getBoundingClientRect().height ?? 0;
    stale = overview !== null;
    focusWindow = false;
    selectedId = null;
    visibleBatches = 1;
    showAll = false;
    offset = 0;
  }
  function moveWindow(direction: -1 | 1) {
    focusWindow = true;
    offset = Math.max(0, offset + direction * windowLimit);
    visibleBatches = Math.ceil(windowLimit / previewLimit);
    selectedId = null;
  }
  function toggleRarity(key: RewardRarity) {
    selectedRarities = selectedRarities.includes(key)
      ? selectedRarities.filter((rarity) => rarity !== key)
      : rewardRarities
          .filter((rarity) => rarity.key === key || selectedRarities.includes(rarity.key))
          .map((rarity) => rarity.key);
    persistRarities();
  }
  function toggleAllRarities() {
    selectedRarities = allRaritiesSelected ? [] : availableRarities.map((rarity) => rarity.key);
    persistRarities();
  }
  function persistRarities() {
    try {
      localStorage.setItem(REWARD_RARITIES_KEY, JSON.stringify(selectedRarities));
    } catch {
      // The current selection still works when browser storage is unavailable.
    }
  }
  async function openReward(id: number) {
    selectedId = id;
    await tick();
    if (selected && !dialog.open) dialog.showModal();
  }
  function imageFailed(id: number) {
    failedImages = new Set([...failedImages, id]);
  }
</script>

<section
  class="elite-overview"
  class:stale
  class:summary-stale={summaryStale}
  aria-label="Recruitment overview"
  aria-busy={busy}
>
  <!-- The empty probe shares the card grid's width and tracks. It exists before
       the first query, so the initial request already has the two-row limit. -->
  <div class="preview-measure" aria-hidden="true" use:measureRows></div>
  {#if failure}
    <p class="state error" role="alert">{failure}</p>
    <button on:click={() => retry++}>Retry recruitment history</button>
  {/if}
  {#if !types.length}
    {#if busy}<LoadingRegion busy message="Loading recruitment history…" />{/if}
    {#if !busy && !failure}<p class="state">
        Import pull history to see your rewards and rarity breakdown.
      </p>{/if}
  {:else}
    <div class="overview-toolbar">
      <label class="recruitment-select"
        >Recruitment
        <select
          value={selectedType !== null && types.includes(selectedType)
            ? selectedType
            : lastSelectedType}
          on:change={(event) => (selectedType = Number(event.currentTarget.value))}
        >
          {#each types as type}<option value={type}>{recruitmentName(type)}</option>{/each}
        </select>
      </label>
      {#if overview}<div class="current-pity" role="status" aria-atomic="true">
          <dl>
            <dt>Current pity</dt>
            <dd>
              {overview.currentPity.toLocaleString()}{#if overview.currentUncertain}<sup
                  title={uncertainty}
                  aria-label=" uncertain">?</sup
                >{/if}{' '}<span
                >{overview.currentUncertain
                  ? 'saved pulls in this interval'
                  : !overview.lastElite
                    ? overview.currentPity === 1
                      ? 'pull before your first 5★'
                      : 'pulls before your first 5★'
                    : overview.currentPity === 1
                      ? 'pull since last 5★'
                      : 'pulls since last 5★'}</span
              >
            </dd>
          </dl>
          <p>
            {#if overview.currentUncertain}Count uncertain · history may be incomplete.
            {:else if overview.lastElite}Last 5★: {overview.lastElite.name} · {date(
                overview.lastElite.timestamp,
                true
              )}
            {:else}No 5★ recorded in this recruitment yet.{/if}
          </p>
        </div>{/if}
    </div>
    <section class="elite-history" aria-label={historyTitle}>
      <div class="section-heading">
        <h2 bind:this={historyHeading} tabindex="-1">
          {overview ? loadedTitle : historyTitle}
          {#if overview}<span>{overview.total.toLocaleString()} rewards</span>{/if}
        </h2>
        <div class="history-tools">
          <span class="sort-order">Newest first</span>
          <fieldset class="rarity-controls">
            <legend>Show rarities</legend>
            {#each availableRarities as rarity}
              <label class:chosen={selectedRarities.includes(rarity.key)}>
                <input
                  type="checkbox"
                  checked={selectedRarities.includes(rarity.key)}
                  on:change={() => toggleRarity(rarity.key)}
                />
                <span>{rarity.label}</span>
              </label>
            {/each}
            <button
              class="all-rarities"
              aria-pressed={allRaritiesSelected}
              on:click={toggleAllRarities}>All</button
            >
          </fieldset>
        </div>
      </div>
      <LoadingRegion {busy} message="Loading rewards…">
        <div class="portrait-grid">
          {#each shown as row, index (row.id)}
            <button
              class="pull"
              disabled={busy || Boolean(failure)}
              class:selected={selectedId === row.id}
              aria-haspopup="dialog"
              aria-label={`Details for ${row.name}, ${rewardRarities.find((rarity) => rarity.key === rewardRarity(row.rarity))?.label}, 5★ pity ${row.pity}${row.pity_uncertain ? ', uncertain' : ''}, ${date(row.timestamp, true)}`}
              on:click={() => openReward(row.id)}
            >
              <span class="portrait">
                {#if imageMap[row.item_id] && !failedImages.has(row.item_id)}
                  <img
                    src={imageMap[row.item_id]}
                    alt=""
                    width="80"
                    height="80"
                    loading={index < previewLimit ? 'eager' : 'lazy'}
                    on:error={() => imageFailed(row.item_id)}
                  />
                {:else}<span class="missing">No image</span>{/if}
                <span class="pity"
                  >{row.pity}{#if row.pity_uncertain}<sup
                      title={uncertainty}
                      aria-label=" uncertain">?</sup
                    >{/if}</span
                >
              </span>
              <span class="pull-rarity"
                >{rewardRarities.find((rarity) => rarity.key === rewardRarity(row.rarity))
                  ?.label}</span
              >
              <span class="pull-name" title={row.name}>{row.name}</span><span class="pull-date"
                >{date(row.timestamp)}</span
              >
            </button>
          {/each}
        </div>
      </LoadingRegion>
      {#if overview?.total}
        <div
          class="history-pagination"
          bind:this={pagination}
          style:height={stale ? `${paginationHeight}px` : undefined}
        >
          {#if !showAll && offset === 0 && limit < windowLimit && shown.length < overview.total}
            <button disabled={busy} on:click={() => (visibleBatches += 1)}>Show more</button>
          {/if}
          {#if !showAll && (offset > 0 || shown.length < overview.total)}
            <button
              disabled={busy}
              on:click={() => {
                offset = 0;
                showAll = true;
              }}>Show all</button
            >
          {/if}
          {#if !showAll && offset > 0}
            <button disabled={busy} on:click={() => moveWindow(-1)}>Previous rewards</button>
          {/if}
          {#if !showAll && limit === windowLimit && offset + shown.length < overview.total}
            <button disabled={busy} on:click={() => moveWindow(1)}>Next rewards</button>
          {/if}
          {#if showAll || visibleBatches > 1 || offset > 0}
            <button
              disabled={loading || (pending && !showAll)}
              on:click={() => {
                visibleBatches = 1;
                showAll = false;
                offset = 0;
                selectedId = null;
              }}>Show fewer</button
            >
          {/if}
          {#if overview.total > previewLimit}<span role="status"
              >Showing {offset ? `${offset + 1}–${offset + shown.length}` : shown.length} of {overview.total}
              rewards</span
            >{/if}
        </div>
      {:else if overview}<p class="empty" role="status">
          {selectedRarities.length
            ? 'No rewards match the selected rarities in this recruitment.'
            : 'Select a rarity to show rewards.'}
        </p>{/if}
      <p class="scope-note">Pull log filters below do not change this recruitment overview.</p>
      <details class="pity-help">
        <summary>About pity and missing history</summary>
        <p>
          Pity counts saved pulls in this recruitment, using their recorded order. A superscript
          question mark means the count may be incomplete because earlier history is missing. The
          first count stays uncertain unless history starts on the game's launch day. A known 5★
          starts a new interval; later imports can fill gaps. Averages exclude uncertain intervals.
        </p>
      </details>
    </section>
    {#if overview}<dl class="metrics">
        <div>
          <dt>Average 5★ pity</dt>
          <dd title="Only intervals with complete known history are included">
            {overview.average === null ? '—' : overview.average.toFixed(1)}
          </dd>
        </div>
        <div>
          <dt>Total pulls</dt>
          <dd>{totalPulls.toLocaleString()}</dd>
        </div>
      </dl>
      <section class="rarity-breakdown" aria-label="Rarity breakdown">
        <h2>Rarity breakdown</h2>
        <div class="rarity-content">
          <div class="stack" aria-hidden="true">
            {#each breakdown as rarity}<span
                style:width={`${rarity.percent}%`}
                style:background={rarity.color}
              ></span>{/each}
          </div>
          <dl class="rarities">
            {#each breakdown as rarity}<div>
                <dt><span class="swatch" style:background={rarity.color}></span>{rarity.label}</dt>
                <dd>{rarity.count.toLocaleString()} <small>{rarity.percent.toFixed(1)}%</small></dd>
              </div>{/each}
          </dl>
        </div>
      </section>{/if}
  {/if}
</section>

<dialog
  bind:this={dialog}
  class="reward-dialog"
  aria-labelledby="reward-detail-title"
  on:close={() => (selectedId = null)}
  on:keydown={(event) => {
    // Close is the dialog's only interactive control; keep Tab inside it.
    if (event.key === 'Tab') {
      event.preventDefault();
      event.currentTarget.querySelector('button')?.focus();
    }
  }}
>
  {#if selected}
    <div class="dialog-heading">
      <h2 id="reward-detail-title">{selected.name}</h2>
      <button type="button" on:click={() => dialog.close()}>Close</button>
    </div>
    <div class="reward-detail">
      <div class="large-portrait">
        {#if imageMap[selected.item_id] && !failedImages.has(selected.item_id)}
          <img
            src={imageMap[selected.item_id]}
            alt={selected.name}
            width="256"
            height="256"
            on:error={() => imageFailed(selected.item_id)}
          />
        {:else}<span class="missing">No image available</span>{/if}
      </div>
      <dl class="reward-facts">
        <div>
          <dt>Rarity</dt>
          <dd>
            {rarityLabels.find((rarity) => rarity.key === rewardRarity(selected.rarity))?.label}
          </dd>
        </div>
        <div>
          <dt>Item kind</dt>
          <dd>
            {selected.kind === 'doll' ? 'Doll' : selected.kind === 'weapon' ? 'Weapon' : 'Unknown'}
          </dd>
        </div>
        <div class="wide">
          <dt>Recruited</dt>
          <dd>
            {date(selected.timestamp, true)} · {new Date(selected.timestamp).toLocaleTimeString()}
          </dd>
        </div>
        <div class="wide">
          <dt>5★ pity at this pull</dt>
          <dd>
            {selected.pity}{#if selected.pity_uncertain}<sup
                title={uncertainty}
                aria-label=" uncertain">?</sup
              >{/if}
          </dd>
        </div>
        <div class="wide">
          <dt>Recruitment</dt>
          <dd>{recruitmentName(selected.type_id)}</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>{selected.quantity}</dd>
        </div>
        <div>
          <dt>Pool ID</dt>
          <dd>{selected.pool_id}</dd>
        </div>
        <div>
          <dt>Item ID</dt>
          <dd>{selected.item_id}</dd>
        </div>
      </dl>
    </div>
    {#if selected.pity_uncertain}<p class="detail-note">
        History may be incomplete; the pity count is uncertain.
      </p>{/if}
    {#if selected.gap_before}<p class="detail-note">History is missing before this pull.</p>{/if}
  {/if}
</dialog>

<style>
  .elite-overview {
    position: relative;
    margin-block: 24px;
    min-width: 0;
  }
  /* Hidden content keeps its dimensions and is excluded from focus and the
     accessibility tree, so old account data is never relabeled as new data. */
  .stale :is(.section-heading h2, .portrait-grid, .history-pagination, .empty) {
    visibility: hidden;
  }
  .summary-stale :is(.current-pity, .metrics, .rarity-breakdown) {
    visibility: hidden;
  }
  .overview-toolbar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 20px;
  }
  .current-pity {
    max-width: 34rem;
  }
  .current-pity dl {
    margin: 0;
  }
  .current-pity dd {
    color: var(--accent-text);
    font-size: 2.5rem;
    font-weight: 600;
    line-height: 1.2;
  }
  .current-pity dd span {
    display: inline-block;
    margin-left: 10px;
    color: var(--ink);
    font-size: 1rem;
    font-weight: 400;
  }
  .current-pity p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .recruitment-select {
    display: grid;
    gap: 6px;
    min-width: 240px;
    color: var(--muted);
  }
  select {
    width: 100%;
  }
  .metrics {
    padding: 20px 0;
    display: flex;
    gap: 36px;
    margin: 0;
  }
  .metrics div {
    display: grid;
    gap: 4px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .metrics dd {
    font-size: 1.75rem;
    font-weight: 600;
    line-height: 1.1;
  }
  .elite-history {
    padding: 20px;
    border-top: 2px solid var(--ink);
    background: #e7ebee;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px 24px;
    margin-bottom: 18px;
  }
  h2 {
    margin: 0;
    font-size: 1.5rem;
  }
  .section-heading h2 span {
    display: inline-block;
    font-family: 'Barlow', sans-serif;
    font-size: 0.95rem;
    font-weight: 400;
    margin-left: 10px;
    color: var(--muted);
  }
  .history-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 20px;
    margin-left: auto;
  }
  .sort-order {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .portrait-grid,
  .preview-measure {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 16px;
  }
  .preview-measure {
    position: absolute;
    inset-inline: 20px;
    height: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .pull {
    display: flex;
    flex-direction: column;
    align-items: start;
    justify-content: start;
    gap: 4px;
    border: 0;
    border-radius: 0;
    padding: 0;
    min-width: 0;
    text-align: left;
    font-weight: 400;
  }
  .pull:hover {
    background: transparent;
  }
  .portrait {
    position: relative;
    display: block;
    width: 80px;
    height: 80px;
    border: 1px solid var(--line);
    background: var(--surface);
  }
  .selected .portrait,
  .pull:hover .portrait {
    border-color: var(--accent-text);
    outline: 1px solid var(--accent-text);
  }
  .portrait img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .pity {
    position: absolute;
    right: -1px;
    bottom: -1px;
    background: #edc77d;
    color: #292419;
    padding: 2px 4px;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 1.15rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  sup {
    font-size: 0.65em;
    vertical-align: super;
  }
  .missing {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .pull-name {
    display: block;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
    line-height: 1.25;
  }
  .pull-date {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .history-pagination {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 18px;
    color: var(--muted);
  }
  .history-pagination:empty {
    display: none;
  }
  .pull-rarity {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .rarity-controls {
    display: flex;
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .rarity-controls legend,
  .rarity-controls input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .rarity-controls label {
    position: relative;
    display: flex;
    cursor: pointer;
  }
  .rarity-controls label span,
  .all-rarities {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 64px;
    min-height: 44px;
    padding: 8px 14px;
    border: 1px solid var(--control-line);
    border-radius: 0;
    color: var(--muted);
    font-size: 0.95rem;
    font-weight: 600;
  }
  .rarity-controls label:not(:first-of-type) span,
  .all-rarities {
    border-left: 0;
  }
  .rarity-controls label:first-of-type span {
    border-radius: 3px 0 0 3px;
  }
  .all-rarities {
    border-radius: 0 3px 3px 0;
    font-weight: 400;
  }
  .rarity-controls label:hover span,
  .all-rarities:hover {
    background: var(--surface-hover);
  }
  .rarity-controls label.chosen span,
  .all-rarities[aria-pressed='true'] {
    background: var(--ink);
    color: var(--white);
    border-color: var(--ink);
  }
  .rarity-controls input:focus-visible + span,
  .all-rarities:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--accent-text);
    outline-offset: 3px;
  }
  @media (max-width: 600px) {
    .history-tools {
      width: 100%;
      justify-content: space-between;
    }
    .rarity-controls {
      flex: 1 0 100%;
    }
    .rarity-controls label,
    .all-rarities {
      flex: 1;
    }
    .rarity-controls label span {
      width: 100%;
    }
    .rarity-controls label span,
    .all-rarities {
      min-width: 44px;
      padding-inline: 6px;
      font-size: 0.875rem;
    }
  }
  .reward-dialog {
    width: min(700px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    padding: 24px;
    border: 1px solid var(--control-line);
    background: var(--paper);
    color: var(--ink);
    overflow-y: auto;
  }
  .reward-dialog::backdrop {
    background: rgb(20 25 31 / 65%);
  }
  .dialog-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  .dialog-heading h2 {
    font-size: 2rem;
    overflow-wrap: anywhere;
  }
  .reward-detail {
    display: grid;
    grid-template-columns: minmax(0, 256px) minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }
  .large-portrait {
    aspect-ratio: 1;
    background: var(--surface);
  }
  .large-portrait img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .reward-facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 16px;
    margin: 0;
  }
  .reward-facts .wide {
    grid-column: 1 / -1;
  }
  .reward-facts dt {
    margin-bottom: 3px;
    font-size: 0.85rem;
  }
  .reward-facts dd {
    overflow-wrap: anywhere;
  }
  .detail-note {
    margin: 20px 0 0;
    color: var(--muted);
  }
  @media (max-width: 520px) {
    .reward-dialog {
      padding: 20px;
    }
    .reward-detail {
      grid-template-columns: minmax(0, 1fr);
      gap: 20px;
    }
    .large-portrait {
      width: min(100%, 224px);
      margin-inline: auto;
    }
  }
  .scope-note {
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .pity-help {
    margin-top: 16px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .pity-help summary {
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .pity-help p {
    max-width: 75ch;
    line-height: 1.5;
    margin-bottom: 0;
  }
  .rarity-breakdown {
    display: flex;
    align-items: center;
    gap: 32px;
    padding: 20px 0;
    border-bottom: 1px solid var(--line);
  }
  .rarity-breakdown h2 {
    font-size: 1.25rem;
    white-space: nowrap;
  }
  .rarity-content {
    flex: 1;
    min-width: 0;
  }
  .stack {
    display: flex;
    height: 8px;
    background: var(--track);
    overflow: hidden;
  }
  .rarities {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin: 12px 0 0;
  }
  .rarities div {
    display: grid;
    gap: 4px;
  }
  .rarities dt {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rarities dd {
    font-weight: 600;
  }
  .rarities small {
    margin-left: 6px;
    font-weight: 400;
    color: var(--muted);
  }
  .swatch {
    width: 8px;
    height: 8px;
    flex: 0 0 8px;
  }
  .state,
  .empty {
    padding: 20px 0;
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
  @media (max-width: 700px) {
    .overview-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 18px;
    }
    .recruitment-select {
      min-width: 0;
    }
    .metrics {
      padding: 20px 0;
      justify-content: space-between;
      gap: 12px;
    }
    .metrics dt {
      font-size: 0.85rem;
    }
    .metrics dd {
      font-size: 1.5rem;
    }
    .elite-history {
      padding: 16px 12px;
    }
    .portrait-grid,
    .preview-measure {
      grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
      gap: 14px 9px;
    }
    .preview-measure {
      inset-inline: 12px;
    }
    .portrait {
      width: 64px;
      height: 64px;
    }
    .rarity-breakdown {
      align-items: stretch;
      flex-direction: column;
      gap: 14px;
    }
    .rarities {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
