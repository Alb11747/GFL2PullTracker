<script lang="ts">
  import type { PageData } from './$types';
  import GitHubLink from '$lib/components/GitHubLink.svelte';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Privacy · GFL2 Pull Tracker</title>
  <meta
    name="description"
    content="How GFL2 Pull Tracker stores your history, uses Google Drive, and handles game captures."
  />
</svelte:head>

<main class="privacy-page">
  <a class="back-link" href="/history">Back to GFL2 Pull Tracker</a>
  <header>
    <h1>Privacy</h1>
    <p class="intro">
      Your pull history stays in your browser unless you choose to send it elsewhere. You do not
      need a website account or Google connection to use the tracker.
    </p>
    <p class="updated">Last updated September 21, 2026</p>
  </header>

  <section aria-labelledby="browser-data">
    <h2 id="browser-data">On this device</h2>
    <p>
      Profiles, game identities, pull histories, source snapshots, and portable settings are saved
      in this browser’s IndexedDB. Import preferences are also saved locally. Clearing site data can
      erase this copy. Download a compressed backup before relying on the browser as your only
      archive.
    </p>
    <p>
      Downloaded backups contain private game data. Compression is not encryption. Captures, game
      tokens, Google access tokens, and server session credentials are excluded from portable
      backups.
    </p>
  </section>

  <section aria-labelledby="google-drive">
    <h2 id="google-drive">Optional Google Drive sync</h2>
    <p>
      Connecting Google grants the <code>drive.appdata</code> permission. The tracker reads and writes
      compressed archive revisions in its own hidden application data folder in your Drive. This permission
      does not give the tracker access to your ordinary Drive files.
    </p>
    <p>
      The browser communicates directly with Google to back up, restore, and merge your profiles,
      histories, source snapshots, and portable settings across devices. Google access tokens stay
      in browser memory. When authorization expires, sync pauses until you reconnect. Closed
      browsers do not sync.
    </p>
    <p>
      Google data is used only for these backup and sync features. We do not sell it, use it for
      advertising, or use it to train AI models. We do not permit human access except with your
      explicit agreement for support, when necessary for security, or as required by law. Our use
      and transfer of information received from Google APIs follows the <a
        href="https://developers.google.com/terms/api-services-user-data-policy"
        >Google API Services User Data Policy</a
      >, including its Limited Use requirements.
    </p>
    <p>
      Google processes data under its <a href="https://policies.google.com/privacy"
        >privacy policy</a
      >. You can revoke the tracker’s permission through your
      <a href="https://myaccount.google.com/connections">Google Account connections</a>.
    </p>
  </section>

  <section aria-labelledby="remove-data">
    <h2 id="remove-data">Disconnecting and deleting data</h2>
    <p>
      Disconnecting Drive stops sync but does not delete archives. Removing a profile from one
      device does not delete the cloud copy. “Delete across synced devices” sends a deletion in the
      next sync; concurrent edits require a choice.
    </p>
    <p>
      Older Drive revisions can still contain deleted histories. To erase those copies, download
      anything you want to keep, disconnect every device, then delete this app’s hidden data in
      Google Drive’s app-management settings. Clear unwanted local copies before reconnecting,
      because a device that retains history can upload it again. Downloaded files must be deleted
      separately.
    </p>
  </section>

  <section aria-labelledby="capture-data">
    <h2 id="capture-data">Game captures and server features</h2>
    <p>
      With server backup and community contribution both off, capture import first requests records
      directly from the official game service. If that fails, you can explicitly choose a server
      relay. The relay receives your capture, including game authentication material, in server
      memory to fetch records and return them to your browser. Captures, game tokens, and
      credential-bearing URLs are not persisted in logs, archives, or backups. Never include a
      capture in a support message.
    </p>
    <p>
      Private server backups, game-account recovery, and community contributions are currently
      disabled until trustworthy game-account ownership verification is available. Google
      authorization does not grant access to server backups. The backup and contribution choices are
      independent, and Drive sync cannot enable either one.
    </p>
  </section>

  <section aria-labelledby="analytics-data">
    <h2 id="analytics-data">Analytics, diagnostics, and session replay</h2>
    <p>
      Configured public deployments use PostHog’s US service for page visits, import, backup,
      restore, and Drive-sync outcomes, sanitized error reports, and masked session replay.
      Collection is on by default during beta and will be off by default after beta. Turn off <a href="/privacy"
        >Analytics &amp; diagnostics in Privacy</a
      >
      to stop new collection on this device. Local-server mode does not collect this telemetry.
    </p>
    <p>
      Analytics use a random browser identifier, not your game or Google account. Operation reports
      contain a fixed operation name, outcome, and duration. Error reports retain error types and
      safe stack locations with fixed messages. Deployment revision and service identify where a
      problem occurred. Page URLs exclude query strings and fragments.
    </p>
    <p>
      Replay records the navigation shell with text and inputs masked. Private archive content,
      profile selectors, capture forms, histories, and file details are blocked from recording.
      Captures, credentials, account IDs, histories, filenames, request bodies, headers, console
      logs, and network payloads are not sent to PostHog.
    </p>
    <p>
      Your analytics preference stays on this device, applies across open tabs, and is excluded from
      backups and Drive sync. Opting out stops browser recording and excludes subsequent server
      requests and newly submitted background jobs. It does not erase previously submitted telemetry
      or change the permission of a job already running. Clearing site data resets this preference.
      PostHog processes connection metadata when receiving requests; see its
      <a href="https://posthog.com/privacy">privacy policy</a>.
    </p>
  </section>

  <section aria-labelledby="site-operation">
    <h2 id="site-operation">Site operation and contact</h2>
    <p>
      This tracker has no advertising. The hosting service can receive connection metadata,
      including IP addresses, as part of serving requests and protecting the service.
    </p>
    <p>
      <strong>Hosting:</strong>
      {data.hostingDetails || 'The operator has not yet published hosting details.'}
    </p>
    <p>
      <strong>Connection-log retention:</strong>
      {data.logRetention || 'The operator has not yet published its retention policy.'}
    </p>
    <p>
      <strong>Privacy and support:</strong>
      {#if data.supportEmail}<a href={`mailto:${data.supportEmail}`}>{data.supportEmail}</a
        >{:else}The operator has not yet configured a contact address.{/if}
    </p>
  </section>

  <footer>
    <span>GFL2 Pull Tracker</span>
    <GitHubLink />
    <a href="/history">Return to your archive</a>
  </footer>
</main>

<style>
  .privacy-page {
    max-width: 850px;
    padding: 36px 32px 0;
  }
  .back-link {
    display: inline-block;
    margin-bottom: 36px;
  }
  header {
    border-bottom: 2px solid var(--ink);
    padding-bottom: 24px;
  }
  h1 {
    margin-bottom: 18px;
  }
  .intro {
    font-size: 1.2rem;
    line-height: 1.6;
  }
  .updated {
    color: var(--muted);
    margin-top: 16px;
  }
  section {
    margin-top: 32px;
  }
  h2 {
    margin-bottom: 12px;
  }
  section p {
    line-height: 1.7;
    margin-top: 12px;
    overflow-wrap: anywhere;
  }
  code {
    font-size: 0.95em;
  }
  footer {
    margin-top: 40px;
    font-size: 0.9rem;
  }
  @media (max-width: 760px) {
    .privacy-page {
      padding: 24px 20px 0;
    }
    .back-link {
      margin-bottom: 28px;
    }
  }
</style>
