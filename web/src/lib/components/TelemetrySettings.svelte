<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setTelemetryEnabled, subscribeTelemetry } from '$lib/telemetry/browser';
  let enabled = $state(false);
  onMount(() => subscribeTelemetry((value) => (enabled = value)));
</script>

<section aria-labelledby="analytics-heading">
  <h3 id="analytics-heading">Analytics &amp; diagnostics</h3>
  {#if page.data.telemetry?.enabled}
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        onchange={(event) => setTelemetryEnabled(event.currentTarget.checked)}
      />
      Allow analytics, error reports, and masked session replay
    </label>
    <p>
      On by default. Your choice stays on this device and is not included in backups or Drive sync.
      Turning this off stops new browser collection and excludes subsequent server requests and
      newly submitted jobs. Already submitted reports and running jobs are unaffected.
    </p>
  {:else}
    <p>Analytics and diagnostics are disabled for this deployment.</p>
  {/if}
</section>

<style>
  section {
    margin: 24px 0;
  }
  h3 {
    margin: 0 0 12px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 500;
  }
  input {
    accent-color: var(--ink);
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
  p {
    margin: 10px 0 0;
    max-width: 72ch;
    line-height: 1.6;
  }
</style>
