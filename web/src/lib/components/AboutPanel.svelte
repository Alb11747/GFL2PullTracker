<script lang="ts">
  import { onMount } from 'svelte';
  import GitHubLink from './GitHubLink.svelte';
  import {
    createFeedbackSender,
    feedbackAvailable,
    type FeedbackConfig,
    type FeedbackDraft
  } from '$lib/telemetry/feedback';
  import {
    sendDiagnosticReport,
    subscribeDiagnostics,
    takeFeedbackDiagnostics
  } from '$lib/telemetry/browser';

  let { config }: { config: FeedbackConfig } = $props();
  let category = $state<FeedbackDraft['category']>('feedback');
  let message = $state('');
  let email = $state('');
  let includeDiagnostics = $state(false);
  let diagnosticAvailable = $state(false);
  let sending = $state(false);
  let status = $state<'idle' | 'sent' | 'uncertain'>('idle');
  let validation = $state('');
  const available = $derived(feedbackAvailable(config));
  const send = createFeedbackSender(sendDiagnosticReport, takeFeedbackDiagnostics);

  onMount(() =>
    subscribeDiagnostics((state) => {
      diagnosticAvailable = state.pending && !state.sending;
      if (!diagnosticAvailable) includeDiagnostics = false;
    })
  );
  $effect(() => {
    if (category !== 'bug') includeDiagnostics = false;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (sending) return;
    validation = '';
    sending = true;
    try {
      const result = await send(config, { category, message, email, includeDiagnostics });
      if (result === 'busy') return;
      status = result;
      if (result === 'sent') {
        message = '';
        email = '';
        includeDiagnostics = false;
        category = 'feedback';
      }
    } catch (error) {
      validation = error instanceof Error ? error.message : 'Check your message and try again.';
    } finally {
      sending = false;
    }
  }
</script>

<section class="about-panel" aria-labelledby="about-heading">
  <header class="about-intro">
    <h1 id="about-heading">About</h1>
    <p class="intro">Your recruitment history, kept together.</p>
    <p>
      GFL2 Pull Tracker helps you save, browse, and understand your Girls’ Frontline 2 recruitment
      history. Your archive stays in your browser unless you choose a backup or sync option.
    </p>
    <p>
      <strong>Currently in beta.</strong> Features may change. Your feedback helps improve the tracker.
    </p>
    <div class="about-links"><GitHubLink /><a href="/privacy-policy">Privacy policy</a></div>
  </header>

  <section class="feedback-section" aria-labelledby="feedback-heading">
    <h2 id="feedback-heading">Help improve the tracker</h2>
    <p>Share an idea or tell us what went wrong.</p>
    {#if !available}
      <p role="status">
        The feedback form is unavailable right now. You can find the project on <GitHubLink />.
      </p>
    {:else}
      <form class="ph-no-capture ph-sensitive" onsubmit={submit} oninput={() => { validation = ''; if (status === 'sent') status = 'idle'; }} aria-busy={sending}>
        <fieldset disabled={sending}>
          <legend class="visually-hidden">Feedback details</legend>
          <label for="feedback-category">I’d like to</label>
          <select id="feedback-category" bind:value={category}>
            <option value="feedback">Give feedback</option>
            <option value="bug">Report a bug</option>
          </select>

          <label for="feedback-message">Message <span>(required)</span></label>
          <p id="feedback-hint" class="hint">
            {category === 'bug'
              ? 'What happened, what did you expect, and how can we reproduce it?'
              : 'What could work better, or what would you like to see?'}
          </p>
          <textarea
            id="feedback-message"
            class="ph-sensitive"
            bind:value={message}
            required
            maxlength="5000"
            rows="6"
            aria-describedby="feedback-hint feedback-limit"
            spellcheck="true"></textarea>
          <p id="feedback-limit" class="hint count">
            {message.length.toLocaleString()} / 5,000 characters
          </p>

          <label for="feedback-email">Email <span>(optional)</span></label>
          <input
            id="feedback-email"
            class="ph-sensitive"
            type="email"
            maxlength="254"
            bind:value={email}
            autocomplete="email"
            aria-describedby="email-hint"
          />
          <p id="email-hint" class="hint">Only if you’d like us to be able to follow up.</p>

          {#if category === 'bug' && diagnosticAvailable}
            <div class="diagnostics-option">
              <label class="check-control"
                ><input
                  type="checkbox"
                  bind:checked={includeDiagnostics}
                  aria-describedby="diagnostics-hint"
                />Include technical diagnostics</label
              >
              <p id="diagnostics-hint" class="hint">
                Attach the buffered error’s technical details and recent page and operation labels.
                No replay, form contents, or pull history is included.
              </p>
            </div>
          {/if}

          <p class="submission-note">
            Send shares your message, optional email, and any selected diagnostics with PostHog. It
            does not change your analytics setting. Please leave out game captures, tokens, and
            private account details.
          </p>
          {#if validation}<p role="alert" class="validation">{validation}</p>{/if}
          <button class="primary" type="submit" disabled={sending}
            >{sending ? 'Sending…' : status === 'uncertain' ? 'Send again' : 'Send'}</button
          >
        </fieldset>
        <div role="status" aria-live="polite" aria-atomic="true">
          {#if status === 'sent'}<p class="success">
              Thank you. Your feedback was sent. Your analytics setting is unchanged.
            </p>
          {:else if status === 'uncertain'}<p class="validation">
              Could not confirm delivery. Your draft is still here. Nothing will be retried
              automatically; sending again could create a duplicate.
            </p>{/if}
        </div>
      </form>
    {/if}
  </section>
</section>

<style>
  .about-panel {
    max-width: 720px;
  }
  h1 {
    margin: 0 0 16px;
    font-size: clamp(2.4rem, 4vw, 3.6rem);
  }
  p {
    line-height: 1.6;
    max-width: 70ch;
  }
  .intro {
    font-size: 1.3rem;
    margin: 0 0 12px;
  }
  .about-links {
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    margin-top: 20px;
  }
  .feedback-section {
    border-top: 2px solid var(--ink);
    margin-top: 36px;
    padding-top: 24px;
  }
  h2 {
    margin: 0 0 8px;
  }
  .feedback-section > p {
    margin: 0 0 24px;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  label {
    display: block;
    font-weight: 600;
    margin-top: 24px;
    margin-bottom: 7px;
  }
  label:first-of-type {
    margin-top: 0;
  }
  label span {
    margin-inline-start: 0.25em;
    color: var(--muted);
    font-weight: 400;
  }
  select,
  textarea,
  input[type='email'] {
    display: block;
    width: 100%;
  }
  textarea {
    min-height: 160px;
    resize: vertical;
    line-height: 1.6;
  }
  .hint {
    color: var(--muted);
    font-size: 0.9rem;
    margin: 6px 0 8px;
  }
  .count {
    max-width: none;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .diagnostics-option {
    margin-top: 24px;
  }
  .check-control {
    display: flex;
  }
  .submission-note {
    color: var(--muted);
    font-size: 0.9rem;
    margin: 24px 0 16px;
  }
  .validation {
    color: var(--danger);
  }
  .success {
    color: var(--success);
  }
  button {
    min-width: 112px;
    min-height: 44px;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 760px) {
    button {
      width: 100%;
    }
  }
</style>
