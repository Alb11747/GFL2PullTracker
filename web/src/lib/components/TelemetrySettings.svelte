<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setTelemetryEnabled, subscribeTelemetry } from '$lib/telemetry/browser';
  let enabled = $state(false);
  onMount(() => subscribeTelemetry((value) => (enabled = value)));
</script>

<section aria-labelledby="analytics-heading">
  <h2 id="analytics-heading">Analytics &amp; diagnostics</h2>
  {#if page.data.telemetry?.enabled}
    <label>
      <input
        type="checkbox"
        role="switch"
        aria-describedby="analytics-description"
        checked={enabled}
        onchange={(event) => setTelemetryEnabled(event.currentTarget.checked)}
      />
      <span>Allow analytics, error reports, and masked session replay</span>
    </label>
    <p id="analytics-description">
      On by default during beta. After beta, analytics and diagnostics will be off by default.
      Your choice stays on this device and is not included in backups or Drive sync.
    </p>
    <p>
      Turning this off stops new browser collection and excludes subsequent server requests and
      newly submitted jobs. Already submitted reports and running jobs are unaffected.
    </p>
  {:else}
    <p>Analytics and diagnostics are disabled for this deployment.</p>
  {/if}
</section>

<style>
  section {
    margin: 0 0 32px;
    max-width: 72ch;
  }
  h2 {
    margin: 0 0 20px;
  }
  label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    font-size: 1rem;
    font-weight: 600;
    color: var(--ink);
  }
  input {
    appearance: none;
    width: 44px;
    height: 24px;
    min-height: 0;
    padding: 3px;
    margin: 0;
    border: 1px solid var(--control-line);
    border-radius: 12px;
    background: var(--surface);
    flex-shrink: 0;
  }
  input::before {
    content: '';
    display: block;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--muted);
  }
  input:checked {
    background: var(--accent);
    border-color: var(--accent-text);
  }
  input:checked::before {
    transform: translateX(20px);
    background: var(--ink);
  }
  @media (forced-colors: active) {
    input { appearance: auto; }
    input::before { display: none; }
  }
  p {
    margin: 12px 0 0;
    line-height: 1.6;
    color: var(--muted);
  }
</style>
