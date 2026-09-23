<script lang="ts">
  import '@fontsource/barlow/400.css';
  import '@fontsource/barlow/500.css';
  import '@fontsource/barlow/600.css';
  import '@fontsource/barlow/700.css';
  import '@fontsource/barlow-condensed/500.css';
  import '@fontsource/barlow-condensed/600.css';
  import '../app.css';
  import { browser } from '$app/environment';
  import { onMount, untrack } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { initTelemetry, capturePageview } from '$lib/telemetry/browser';
  import TelemetryNotice from '$lib/components/TelemetryNotice.svelte';
  import ErrorReportNotice from '$lib/components/ErrorReportNotice.svelte';
  let { children, data } = $props();
  const BETA_DISMISSED_KEY = 'gfl2.beta-banner-dismissed';
  let betaVisible = $state(true);
  onMount(() => {
    try {
      betaVisible = sessionStorage.getItem(BETA_DISMISSED_KEY) !== '1';
    } catch {
      // The banner remains dismissible when browser storage is unavailable.
    }
  });
  function dismissBeta() {
    betaVisible = false;
    try {
      sessionStorage.setItem(BETA_DISMISSED_KEY, '1');
    } catch {
      // Keep dismissal in memory for this visit if storage is restricted.
    }
  }
  // Initialize device preference before child mount callbacks make API requests.
  if (browser) untrack(() => initTelemetry(data.telemetry));
  afterNavigate(({ to }) => {
    if (to) capturePageview(to.url.pathname);
  });
</script>

{#if betaVisible}
<aside class="beta-banner" aria-label="Beta release">
  <strong>Beta</strong>
  <span>GFL2 Pull Tracker is in beta. Features may change.</span>
  <button class="beta-close" aria-label="Dismiss beta banner" onclick={dismissBeta}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
  </button>
</aside>
{/if}
{@render children()}
{#if data.telemetry.enabled}<TelemetryNotice />{/if}
{#if data.telemetry.enabled}<ErrorReportNotice />{/if}

<style>
  .beta-banner {
    position: relative;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 12px;
    padding: 12px 56px;
    background: color-mix(in srgb, var(--accent) 85%, transparent);
    color: var(--ink);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  strong {
    flex-shrink: 0;
  }
  .beta-close {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    padding: 12px;
    border: 0;
  }
  .beta-close:hover {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }
  .beta-close svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
</style>
