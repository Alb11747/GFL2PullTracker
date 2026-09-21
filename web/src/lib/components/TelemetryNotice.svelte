<script lang="ts">
  import { onMount } from 'svelte';
  import { setTelemetryEnabled, subscribeTelemetry } from '$lib/telemetry/browser';
  const NOTICE_KEY = 'gfl2.telemetry-notice';
  let visible = $state(false);
  onMount(() => {
    const refresh = () => {
      try {
        visible = localStorage.getItem(NOTICE_KEY) !== 'seen';
      } catch {
        visible = true;
      }
    };
    refresh();
    const unsubscribe = subscribeTelemetry((enabled) => {
      if (!enabled) visible = false;
    });
    const storage = (event: StorageEvent) => {
      if (event.key === NOTICE_KEY) refresh();
    };
    window.addEventListener('storage', storage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', storage);
    };
  });
  function dismiss(disable = false) {
    if (disable) setTelemetryEnabled(false);
    try {
      localStorage.setItem(NOTICE_KEY, 'seen');
    } catch {
      // A storage restriction must not prevent dismissing this visit's notice.
    }
    visible = false;
  }
</script>

{#if visible}
  <aside class="telemetry-notice" aria-labelledby="telemetry-notice-title">
    <div>
      <h2 id="telemetry-notice-title">Analytics &amp; diagnostics</h2>
      <p>
        Analytics, error reports, and masked session replay are on. Private archive content is
        blocked from replay. You can turn collection off on this device in <a href="/privacy"
          >Privacy</a
        >.
        <a href="/privacy-policy">Read the policy</a>.
      </p>
    </div>
    <div class="notice-actions">
      <button onclick={() => dismiss(true)}>Turn off</button>
      <button onclick={() => dismiss()}>Dismiss</button>
    </div>
  </aside>
{/if}

<style>
  .telemetry-notice {
    position: fixed;
    inset: auto 0 0;
    z-index: 30;
    display: flex;
    gap: 24px;
    align-items: center;
    justify-content: space-between;
    padding: 16px max(20px, calc((100vw - 1328px) / 2));
    border-top: 2px solid var(--ink);
    background: var(--paper);
    color: var(--ink);
  }
  h2 {
    margin: 0 0 6px;
    font-size: 1.35rem;
  }
  p {
    margin: 0;
    max-width: 75ch;
    line-height: 1.5;
  }
  .notice-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  @media (max-width: 760px) {
    .telemetry-notice {
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
    }
  }
</style>
