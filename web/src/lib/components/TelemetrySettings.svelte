<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    setTelemetryEnabled,
    subscribeTelemetry,
    subscribeDiagnostics,
    restoreDiagnosticPrompts
  } from '$lib/telemetry/browser';
  let enabled = $state(false);
  let promptsMuted = $state(false);
  onMount(() => {
    const unsubscribeTelemetry = subscribeTelemetry((value) => (enabled = value));
    const unsubscribeDiagnostics = subscribeDiagnostics((value) => (promptsMuted = value.muted));
    return () => {
      unsubscribeTelemetry();
      unsubscribeDiagnostics();
    };
  });
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
      On by default during beta. After beta, analytics and diagnostics will be off by default. Your
      choice stays on this device and is not included in backups or Drive sync.
    </p>
    <p>
      Turning this off stops automatic browser uploads and session replay, and excludes subsequent
      server requests and newly submitted jobs. Already submitted reports and running jobs are
      unaffected.
    </p>
    <p>
      While analytics are off, a small set of sanitized diagnostics stays in memory until you leave
      or reload this page. If an error occurs, you can choose to send that report, dismiss it this
      time, or dismiss all future prompts on this device. Sending a report does not enable
      analytics.
    </p>
    {#if promptsMuted}
      <p>Error-report prompts are dismissed on this device.</p>
      <button class="restore-prompts" onclick={restoreDiagnosticPrompts}
        >Allow error-report prompts again</button
      >
    {/if}
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
    input {
      appearance: auto;
    }
    input::before {
      display: none;
    }
  }
  p {
    margin: 12px 0 0;
    line-height: 1.6;
    color: var(--muted);
  }
  .restore-prompts {
    margin-top: 12px;
  }
</style>
