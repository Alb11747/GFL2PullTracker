<script lang="ts">
  import type { Profile } from '$lib/api';
  import type { PublicClient, VerifiedAccount } from '$lib/public-api';
  import type { PersonalStatisticsResponse } from '$lib/statistics/history-types';
  import CommunityStatistics from './CommunityStatistics.svelte';
  import PersonalStatistics from './PersonalStatistics.svelte';
  let props: {
    profiles: Profile[];
    activeProfileId: string;
    revision: number | string;
    query: (profileId: string, typeId: number | null) => Promise<PersonalStatisticsResponse>;
    publicApi: PublicClient;
    verifiedAccounts: VerifiedAccount[];
    onprofilechange?: (id: string) => void;
  } = $props();
  let view = $state<'personal' | 'community'>('personal');
</script>

<section class="statistics-panel" aria-label="Statistics">
  <h1>Statistics</h1>
  <div class="statistics-views" role="group" aria-label="Statistics view">
    <button aria-pressed={view === 'personal'} onclick={() => (view = 'personal')}
      >Your statistics</button
    >
    <button aria-pressed={view === 'community'} onclick={() => (view = 'community')}
      >Community statistics</button
    >
  </div>
  {#if view === 'personal'}<PersonalStatistics {...props} />{:else}<CommunityStatistics
      publicApi={props.publicApi}
    />{/if}
</section>

<style>
  .statistics-panel {
    min-width: 0;
  }
  h1 {
    margin: 0 0 20px;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: clamp(2.4rem, 4vw, 3.6rem);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .statistics-views {
    display: flex;
    gap: 24px;
    border-bottom: 1px solid var(--line, #c3c9d0);
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .statistics-views button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--ink, #20252b);
    min-height: 44px;
    padding: 8px 0 12px;
    font: inherit;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .statistics-views button[aria-pressed='true'] {
    color: var(--accent-text, #a64000);
    border-bottom-color: var(--accent-text, #a64000);
    font-weight: 600;
  }
  .statistics-views button:hover {
    background: var(--surface-hover, #dce2e8);
  }
  .statistics-views button:focus-visible {
    outline: 3px solid var(--accent-text, #a64000);
    outline-offset: 3px;
  }
</style>
