<script lang="ts">
  import importingGuide from '../../../../../docs/IMPORTING.md?raw';

  // Keep the recovery code identical to the maintained, browser-verified guide.
  const recoveryCode = importingGuide.match(/```javascript\r?\n([\s\S]*?)```/)?.[1]?.trim() ?? '';
</script>

<svelte:head>
  <title>Move history from Exilium · GFL2 Pull Tracker</title>
  <meta name="description" content="Export your saved Exilium history and merge it into your GFL2 Pull Tracker profile." />
</svelte:head>

<main class="migration-guide">
  <a href="/">Back to GFL2 Pull Tracker</a>
  <header>
    <h1>Move history from Exilium</h1>
    <p>Keep your older pulls alongside newly collected history. This import merges into the game profile you choose.</p>
  </header>
  <section>
    <h2>Save a backup first</h2>
    <p>Use the Chrome profile that shows your old history on <a href="https://exilium.xyz/settings" target="_blank" rel="noreferrer">Exilium’s settings page</a>. Open <strong>Settings → Backups → Export Backup</strong> and keep that file as a safety copy.</p>
    <p>Exilium’s encrypted export cannot be imported here directly. The steps below read the history already saved in that browser. They cannot recover records Exilium no longer has.</p>
    <p>In this tracker, use <strong>Backup &amp; sync → Export selected profile</strong> to save your current history before merging.</p>
  </section>
  <section>
    <h2>Get a readable history file</h2>
    <ol>
      <li>On <strong>exilium.xyz/settings</strong>, press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>J</kbd> to open Chrome’s DevTools Console.</li>
      <li>Review and run the code below. It reads the existing history, decodes it locally, and displays a text box at the top of the page. It makes no network requests and does not change saved Exilium data. If Chrome blocks pasting, enter the reviewed code manually; do not disable its paste safeguards.</li>
      <li>Click inside the new text box, press <kbd>Ctrl+A</kbd>, then <kbd>Ctrl+C</kbd>. Paste into a new plain-text file and save it as <code>exilium-readable-history.json</code>, not <code>.json.txt</code>.</li>
      <li>Reload Exilium to remove the temporary text box.</li>
    </ol>
    <details>
      <summary>Show the history export code</summary>
      <pre><code>{recoveryCode}</code></pre>
    </details>
    <p>If the code reports a missing file, check the Chrome profile. If it reports an unsupported format, keep your backup unchanged; do not edit version numbers or clear browser storage.</p>
  </section>
  <section>
    <h2>Merge into your tracker profile</h2>
    <ol>
      <li>Return to the tracker and select the profile for the same game account.</li>
      <li>Choose <strong>Import history → Saved export → Choose files</strong> and select the readable JSON file.</li>
      <li>If prompted, select the matching Exilium source profile. Choose <strong>Validate and import</strong>, then review the added records and date range.</li>
    </ol>
    <p>Existing history stays in place. Keep both backup files private. Each Exilium row counts as one pull; unavailable original quantities are treated as 1. An import does not prove lifetime completeness or a complete first pity interval.</p>
  </section>
</main>

<style>
  .migration-guide { max-width: 850px; padding: 36px 32px 48px; }
  header { margin-top: 32px; padding-bottom: 24px; border-bottom: 2px solid var(--ink); }
  h1 { margin-bottom: 18px; }
  section { margin-top: 32px; }
  h2 { margin-bottom: 12px; }
  p, li { line-height: 1.7; overflow-wrap: anywhere; }
  p { margin: 12px 0; }
  li { margin-bottom: 12px; }
  ol { padding-left: 24px; }
  summary { cursor: pointer; padding: 12px 0; font-weight: 600; }
  pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; background: var(--surface); font-size: 0.9rem; line-height: 1.6; }
  @media (max-width: 760px) { .migration-guide { padding: 24px 20px 40px; } }
</style>
