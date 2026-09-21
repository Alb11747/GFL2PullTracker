<script lang="ts">
  import { afterUpdate } from 'svelte';
  export let busy = false;
  export let label: string;
  export let loadingLabel = 'Loading…';
  let settledLabel = label;
  let settledLoadingLabel = loadingLabel;
  afterUpdate(() => {
    if (!busy) {
      settledLabel = label;
      settledLoadingLabel = loadingLabel;
    }
  });
</script>

<span class="loading-label">
  <!-- Retained text gives intrinsic controls their previous size without a
       percentage min-width cycle, and naturally rewraps on narrow viewports. -->
  {#if busy}
    <span aria-hidden="true" class="reserved">{settledLabel}</span>
    <span aria-hidden="true" class="reserved">{settledLoadingLabel}</span>
  {/if}
  <span aria-hidden="true" class="reserved">{label}</span>
  <span aria-hidden="true" class="reserved">{loadingLabel}</span>
  <span>{busy ? loadingLabel : label}</span>
</span>

<style>
  .loading-label {
    display: inline-grid;
    max-width: 100%;
  }
  .loading-label > span {
    grid-area: 1 / 1;
  }
  .reserved {
    visibility: hidden;
    pointer-events: none;
  }
</style>
