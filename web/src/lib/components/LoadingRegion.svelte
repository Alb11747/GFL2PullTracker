<script lang="ts">
  import { beforeUpdate, onMount } from 'svelte';

  export let busy = false;
  export let message = 'Loading…';
  export let hideContent = true;
  let region: HTMLDivElement;
  let content: HTMLDivElement;
  let heldHeight = 0;
  let baselineHeight = 0;
  let wasBusy = false;

  // Runs before the slot changes: sampling in ResizeObserver alone can miss
  // a settled result followed by another request within the same frame.
  beforeUpdate(() => {
    if (busy && !wasBusy && region)
      heldHeight = baselineHeight = region.getBoundingClientRect().height;
    if (!busy) heldHeight = baselineHeight = 0;
    wasBusy = busy;
  });

  onMount(() => {
    let width = region.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = region.getBoundingClientRect().width;
      if (busy && Math.abs(width - nextWidth) > 0.5) {
        // The slot may now contain smaller placeholders instead of the previous
        // result. Reflow can grow the reservation, but cannot erase the height
        // captured when this loading sequence began.
        const naturalHeight = content.getBoundingClientRect().height;
        heldHeight = Math.max(baselineHeight, naturalHeight);
      }
      width = nextWidth;
    });
    observer.observe(region);
    return () => observer.disconnect();
  });
</script>

<div
  bind:this={region}
  class="loading-region"
  aria-busy={busy}
  style:min-height={busy && heldHeight ? `${heldHeight}px` : undefined}
>
  <div
    bind:this={content}
    class="region-content"
    class:concealed={busy && hideContent}
    inert={busy && hideContent}
    aria-hidden={busy && hideContent ? 'true' : undefined}
  >
    <slot />
  </div>
  {#if busy && message}
    <p class="region-message" role="status" aria-live="polite">{message}</p>
  {/if}
</div>

<style>
  .loading-region {
    display: grid;
    min-width: 0;
  }
  .region-content,
  .region-message {
    grid-area: 1 / 1;
    min-width: 0;
    align-self: start;
  }
  .region-content {
    display: flow-root;
  }
  .concealed {
    visibility: hidden;
  }
  .region-message {
    margin: 0;
    padding-block: 20px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
</style>
