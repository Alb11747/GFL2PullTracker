<script lang="ts">
  import { onMount } from 'svelte';
  import {
    subscribeDiagnostics,
    sendPendingDiagnosticReport,
    dismissDiagnosticReport
  } from '$lib/telemetry/browser';
  import type { LocalDiagnosticsState } from '$lib/telemetry/local-diagnostics';

  let report = $state<LocalDiagnosticsState>({
    pending: false,
    muted: false,
    sending: false,
    status: 'idle'
  });
  onMount(() => subscribeDiagnostics((value) => (report = value)));
</script>

{#if report.pending || report.sending || report.status !== 'idle'}
  <aside class="error-report-notice ph-no-capture" aria-labelledby="error-report-heading">
    <div role="status" aria-live="polite" aria-atomic="true">
      <h2 id="error-report-heading">
        {#if report.sending}Sending error data…
        {:else if report.status === 'sent'}Error report sent
        {:else if report.status === 'uncertain'}Could not confirm delivery
        {:else}Help fix this error?{/if}
      </h2>
      <p>
        {#if report.status === 'sent'}Thank you. Automatic analytics are still off.
        {:else if report.status === 'uncertain'}The report may not have arrived. It won’t be sent
          again automatically. Analytics are still off.
        {:else}Analytics are off. Send this error’s technical details and recent page and operation
          labels to PostHog? No replay, form contents, or pull history is included.{/if}
      </p>
    </div>
    <div class="report-actions">
      {#if report.pending || report.sending}
        <button
          class="primary"
          disabled={report.sending}
          onclick={() => sendPendingDiagnosticReport()}>Send error data</button
        >
        <button disabled={report.sending} onclick={() => dismissDiagnosticReport()}
          >Dismiss this time</button
        >
        <button
          disabled={report.sending}
          onclick={() => dismissDiagnosticReport(true)}>Dismiss forever</button
        >
      {:else}
        <button onclick={() => dismissDiagnosticReport()}>Close</button>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .error-report-notice {
    position: fixed;
    z-index: 30;
    right: 20px;
    bottom: 20px;
    width: min(560px, calc(100% - 40px));
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    padding: 20px;
    border: 1px solid var(--control-line);
    background: var(--paper);
    color: var(--ink);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 1.5rem;
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  .report-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 16px;
  }
  button {
    min-height: 44px;
  }
  @media (max-width: 560px) {
    .report-actions {
      flex-direction: column;
      gap: 8px;
    }
    button {
      width: 100%;
    }
  }
</style>
