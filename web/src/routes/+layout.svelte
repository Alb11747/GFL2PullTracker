<script lang="ts">
  import '@fontsource/barlow/400.css';
  import '@fontsource/barlow/500.css';
  import '@fontsource/barlow/600.css';
  import '@fontsource/barlow/700.css';
  import '@fontsource/barlow-condensed/500.css';
  import '@fontsource/barlow-condensed/600.css';
  import '../app.css';
  import { browser } from '$app/environment';
  import { untrack } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { initTelemetry, capturePageview } from '$lib/telemetry/browser';
  import TelemetryNotice from '$lib/components/TelemetryNotice.svelte';
  let { children, data } = $props();
  // Initialize device preference before child mount callbacks make API requests.
  if (browser) untrack(() => initTelemetry(data.telemetry));
  afterNavigate(({ to }) => {
    if (to) capturePageview(to.url.pathname);
  });
</script>

{@render children()}
{#if data.telemetry.enabled}<TelemetryNotice />{/if}
