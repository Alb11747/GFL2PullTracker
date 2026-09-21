<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Pull } from '$lib/api';
  import { recruitmentName } from '$lib/recruitment';
  import portraits from '$lib/portraits.json';
  import { eliteSummary } from '$lib/elite-summary';
  import {
    filterRewards,
    readRewardRarities,
    rewardRarities,
    rewardRarity,
    REWARD_RARITIES_KEY,
    type RewardRarity
  } from '$lib/reward-history';

  export let rows: Pull[] = [];
  export let profileId = '';
  export let loading = false;
  export let error = '';

  let selectedType: number | null = null;
  let selectedId: number | null = null;
  let visibleBatches = 1;
  let previewLimit = 8;
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

  $: types = [...new Set(rows.map((row) => row.type_id))].sort((a, b) => a - b);
  $: if (selectedType === null || !types.includes(selectedType)) {
    selectedType = types.includes(3) ? 3 : (types[0] ?? null);
    selectedId = null;
    visibleBatches = 1;
  }
  $: ({ scoped, elites, currentPity, currentUncertain, average } = eliteSummary(
    rows,
    selectedType
  ));
  $: filtered = filterRewards(scoped, selectedRarities);
  $: shown = filtered.slice(0, previewLimit * visibleBatches);
  $: selected = loading || error ? undefined : shown.find((row) => row.id === selectedId);
  $: availableRarities = rewardRarities.filter(
    (rarity) =>
      rarity.key !== 'Unknown' ||
      selectedRarities.includes('Unknown') ||
      scoped.some((row) => rewardRarity(row.rarity) === 'Unknown')
  );
  $: historyTitle = selectedRarities.length
    ? `${rewardRarities
        .filter((rarity) => selectedRarities.includes(rarity.key))
        .map((rarity) => rarity.label)
        .join(' + ')} history`
    : 'Reward history';
  $: resetContext(profileId, selectedType);
  $: if (!selected && dialog?.open) dialog.close();
  $: breakdown = rarityLabels
    .map((rarity) => {
      const count = scoped.filter((row) =>
        rarity.key === 'Unknown'
          ? !['Elite', 'Standard', 'Retired'].includes(row.rarity)
          : row.rarity === rarity.key
      ).length;
      return { ...rarity, count, percent: scoped.length ? (count / scoped.length) * 100 : 0 };
    })
    .filter((rarity) => rarity.key !== 'Unknown' || rarity.count > 0);

  function measureRows(node: HTMLElement) {
    let frame = 0;
    const measure = () => {
      const columns = getComputedStyle(node)
        .gridTemplateColumns.split(/\s+/)
        .filter(Boolean).length;
      previewLimit = Math.max(1, columns) * 2;
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
    try {
      selectedRarities = readRewardRarities(localStorage.getItem(REWARD_RARITIES_KEY));
    } catch {
      selectedRarities = ['Elite'];
    }
  });
  // IDs are scoped to a profile. Never retain a selection across profile changes.
  function resetContext(_profile: string, _type: number | null) {
    selectedId = null;
    visibleBatches = 1;
  }
  function toggleRarity(key: RewardRarity) {
    selectedRarities = selectedRarities.includes(key)
      ? selectedRarities.filter((rarity) => rarity !== key)
      : rewardRarities
          .filter((rarity) => rarity.key === key || selectedRarities.includes(rarity.key))
          .map((rarity) => rarity.key);
    resetContext(profileId, selectedType);
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

<section class="elite-overview" aria-label="Recruitment overview" aria-busy={loading}>
  {#if loading}
    <p class="state" role="status">Loading recruitment history…</p>
  {:else if error}
    <p class="state error" role="alert">{error}</p>
  {:else if !rows.length}
    <p class="state">Import pull history to see your rewards and rarity breakdown.</p>
  {:else}
    <div class="overview-toolbar">
      <label class="recruitment-select"
        >Recruitment
        <select bind:value={selectedType}>
          {#each types as type}<option value={type}>{recruitmentName(type)}</option>{/each}
        </select>
      </label>
      <div class="current-pity" role="status" aria-atomic="true">
        <dl>
          <dt>Current pity</dt>
          <dd>
            {currentPity.toLocaleString()}{#if currentUncertain}<sup
                title={uncertainty}
                aria-label=" uncertain">?</sup
              >{/if}{' '}<span
              >{currentUncertain
                ? 'saved pulls in this interval'
                : !elites.length
                  ? currentPity === 1
                    ? 'pull before your first 5★'
                    : 'pulls before your first 5★'
                  : currentPity === 1
                    ? 'pull since last 5★'
                    : 'pulls since last 5★'}</span
            >
          </dd>
        </dl>
        <p>
          {#if currentUncertain}Count uncertain · history may be incomplete.
          {:else if elites[0]}Last 5★: {elites[0].name} · {date(elites[0].timestamp, true)}
          {:else}No 5★ recorded in this recruitment yet.{/if}
        </p>
      </div>
    </div>
    <section class="elite-history" aria-label={historyTitle}>
      <div class="section-heading">
        <h2>{historyTitle} <span>{filtered.length.toLocaleString()} rewards</span></h2>
        <span>Newest first</span>
      </div>
      <fieldset class="rarity-controls">
        <legend>Show rarities</legend>
        {#each availableRarities as rarity}
          <label class:chosen={selectedRarities.includes(rarity.key)}>
            <input
              type="checkbox"
              checked={selectedRarities.includes(rarity.key)}
              on:change={() => toggleRarity(rarity.key)}
            />
            {rarity.label}
          </label>
        {/each}
      </fieldset>
      {#if filtered.length}
        <div class="portrait-grid" use:measureRows>
          {#each shown as row (row.id)}
            <button
              class="pull"
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
                    loading="lazy"
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
        <div class="history-pagination">
          {#if shown.length < filtered.length}
            <button on:click={() => (visibleBatches += 1)}>Show more</button>
          {/if}
          {#if visibleBatches > 1}
            <button
              on:click={() => {
                visibleBatches = 1;
                selectedId = null;
              }}>Show fewer</button
            >
          {/if}
          {#if filtered.length > previewLimit}<span role="status"
              >Showing {shown.length} of {filtered.length} rewards</span
            >{/if}
        </div>
      {:else}<p class="empty" role="status">
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
    <dl class="metrics">
      <div>
        <dt>Average 5★ pity</dt>
        <dd title="Only intervals with complete known history are included">{average}</dd>
      </div>
      <div>
        <dt>Total pulls</dt>
        <dd>{scoped.length.toLocaleString()}</dd>
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
    </section>
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
    margin-block: 24px;
    min-width: 0;
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
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
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
  .section-heading > span {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .portrait-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 16px;
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
    flex-wrap: wrap;
    gap: 8px;
    border: 0;
    padding: 0;
    margin: 0 0 20px;
  }
  .rarity-controls legend {
    margin-bottom: 8px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .rarity-controls label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--control-line);
    border-radius: 3px;
    cursor: pointer;
  }
  .rarity-controls label:hover {
    background: var(--surface-hover);
  }
  .rarity-controls label.chosen {
    border-color: var(--accent-text);
  }
  .rarity-controls input {
    margin: 0;
    width: 16px;
    height: 16px;
    accent-color: var(--accent-text);
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
    .portrait-grid {
      grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
      gap: 14px 9px;
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
