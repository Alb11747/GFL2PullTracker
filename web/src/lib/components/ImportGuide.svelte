<details class="guide">
  <summary>Get a fresh recruitment-history capture</summary>
  <p>
    On Windows, Fiddler Classic can read the request made when you open recruitment records in the
    game. The request contains a temporary credential. Paste it only into the import field.
  </p>
  <ol>
    <li>
      Install <a
        href="https://www.telerik.com/fiddler/fiddler-classic"
        target="_blank"
        rel="noreferrer">Fiddler Classic from Telerik</a
      >, then open it.
    </li>
    <li>
      Open <strong>Tools → Options → HTTPS</strong> and enable
      <strong>Decrypt HTTPS traffic</strong>. Follow Fiddler’s certificate prompts on your own
      computer. Close unrelated applications while capturing.
    </li>
    <li>
      With capture running, open <strong>Recruitment → Records</strong> in Girls’ Frontline 2. Refresh
      or change the recruitment category if no history request appears.
    </li>
    <li>
      Find the HTTPS request to an official <code>gf2-gacha-record</code> host with the path
      <code>/list</code>. Select it and open <strong>Inspectors → Request → Raw</strong>.
    </li>
    <li>
      Copy the complete request, including its first line and headers, into the capture field here.
      Choose where to save your history before importing. If the request has expired, open
      recruitment records again and copy a new one.
    </li>
    <li>
      After importing, stop Fiddler’s traffic capture, turn off HTTPS decryption, and close Fiddler.
      Clear the copied request from your clipboard. If you no longer need its certificate, remove it
      using Fiddler’s certificate controls.
    </li>
  </ol>
  <p>
    For capture setup, see <a
      href="https://www.telerik.com/fiddler/fiddler-classic/documentation/configure-fiddler/decrypthttps"
      target="_blank"
      rel="noreferrer">Telerik’s HTTPS instructions</a
    >. The independent
    <a href="https://exilium.xyz/import" target="_blank" rel="noreferrer">Exilium import guide</a> provides
    another reference.
  </p>
  <p class="note">
    Prefer a file? Import your collector export folder with records, manifest, and raw pages
    together. Records-only JSON and supported Exilium backups also work. Restore this tracker’s
    compressed archives in Backup &amp; Sync.
  </p>
</details>

<style>
  .guide {
    border-block: 1px solid var(--line);
    margin: 20px 0;
    padding: 16px 0;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    min-height: 28px;
  }
  summary:focus-visible {
    outline: 3px solid var(--red);
    outline-offset: 3px;
  }
  p,
  li {
    line-height: 1.6;
    max-width: 74ch;
  }
  p {
    margin: 14px 0 0;
  }
  ol {
    padding-left: 24px;
  }
  li {
    margin-bottom: 12px;
    padding-left: 4px;
  }
  code {
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--muted);
  }
</style>
