# Importing a recruitment history

Use **Import history → Saved export** to select a collector export folder or
supported history files. **Choose files** accepts collector/Exilium JSON and
compressed tracker backups (`.json.gz`, `.gz`, `.gzip`).
An unidentified legacy import needs an explicit
profile assignment. Import into a separate profile when account identity differs.
The game can expose a limited retention window, so collect regularly and retain
older exports. A partial capture cannot prove the start of a pity interval.

## Restore a tracker backup

Select a compressed tracker backup by itself; it cannot be combined with JSON
exports or other backups. The picker recognizes gzip content rather than trusting
the filename, then checks the backup format, integrity, unversioned schema, and size
limits before opening **Backup & sync** with the file retained. Selecting it does
not restore automatically. **Restore a tracker backup** opens the same controls
without requiring a selection in the import panel.

Earlier versioned tracker backups are unsupported after the deliberate
[prerelease reset](GOOGLE_DRIVE.md#prerelease-archive-reset). Reimport original
collector or supported Exilium exports to rebuild history. Their independent
source format versions are unchanged by the tracker archive reset.

Backups restore their contained profiles into the browser archive, rather than
putting every profile's history into the currently selected profile. Each newly
selected backup defaults to **Merge archive**. Replacement requires a separate
confirmation and downloads a recovery copy before replacing the archive.
Compressed archive restoration is available in the hosted browser-local tracker;
Windows local-server mode explains this limitation instead of treating gzip as a
records export. JSON exports continue to merge into the selected destination.

## Move old history from Exilium

Use the same Chrome profile in which [Exilium](https://exilium.xyz/settings) shows
your old recruitment history. This procedure reads that browser's saved history;
it cannot recover records Exilium no longer has.

The importer accepts readable data-store v1 and the supported compressed v2
envelope with `compressed: true`. These are distinct from Exilium's encrypted
v2 export. The live **Export Backup** file checked on September 20, 2026 contained
`timestamp`, `version: 2`, and encrypted `data`, without `compressed: true`, and
was rejected. A version number alone does not establish a supported format.
Keep an unsupported file unchanged; adding a compression flag or renaming fields
cannot convert it. Use a readable export through the procedure below.

1. In Exilium, open **Settings → Backups → Export Backup** and keep the downloaded
   backup as a safety copy. The encrypted export envelope with `timestamp`,
   `version: 2`, and `data` is not supported by this tracker's history importer.
   Do not rename its fields to bypass validation.
2. While on `https://exilium.xyz/settings`, open Chrome DevTools (**F12** or
   **Ctrl+Shift+J**) and select **Console**. Review and run the snippet below.
   It reads the existing `data-store.json` file, decodes it locally, checks its
   format, and displays readable JSON in a text box at the top of the page. Click
   inside that box, press **Ctrl+A**, then **Ctrl+C**. Paste it into a new plain-text
   file and save it as `exilium-readable-history.json` (not `.json.txt`). It makes no network
   requests and does not change Exilium's saved data. If Chrome blocks pasting,
   enter the reviewed code manually; do not disable its paste safeguards.

```javascript
(async () => {
  if (location.origin !== 'https://exilium.xyz') {
    throw new Error('Run this only on https://exilium.xyz/settings.');
  }
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('data-store.json');
  const file = await handle.getFile();
  const encoded = JSON.parse(await file.text());
  if (typeof encoded !== 'string') {
    throw new Error('Unexpected Exilium storage format. Keep the backup unchanged.');
  }
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const store = JSON.parse(await new Response(stream).text());
  const profiles = store?.state?.profilesData;
  if (store?.version !== 1 || !profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('Unsupported Exilium data-store format. Keep the backup unchanged.');
  }
  const output = document.createElement('textarea');
  output.readOnly = true;
  output.setAttribute('aria-label', 'Readable Exilium history JSON');
  output.style.cssText = 'display:block;width:100%;height:200px;background:white;color:black;position:relative;z-index:9999';
  output.value = JSON.stringify(store, null, 2);
  document.body.prepend(output);
  output.focus();
  output.select();
})();
```

   Reload Exilium after saving the file to remove the temporary text box.

3. In GFL2 Pull Tracker, select the existing destination profile for the same
   game account. Choose **Import history → Saved export → Choose files** and
   select `exilium-readable-history.json`.
4. If prompted, select the matching Exilium source profile, then choose
   **Validate and import**. Review the resulting history in the destination
   profile. Import merges records into that profile rather than replacing it.
   **0 added** is a successful result when those records are already present;
   compare the records read and final profile total rather than expecting every
   reimport to increase the count.
5. If Drive is connected, open **Backup & sync** and check the updated
   **Last synced** time and successful cloud status. Otherwise, connect the
   intended Google account as described in [Google Drive setup](GOOGLE_DRIVE.md#connect-and-check-a-backup).

The September 20, 2026 live migration test used an earlier readable export,
not the freshly downloaded encrypted file. It confirmed duplicate-free merging
and automatic Drive sync; it did not validate encrypted-backup import.

Keep both backup files private: the readable file contains saved profiles
and recruitment records. If the snippet reports a missing file, check that this
Chrome profile actually displays your Exilium history. If it reports an
unsupported format, keep the original backup and stop; do not edit version
numbers or clear browser storage.

The importer accepts the recovered data-store format at version 1. Each stored
row represents one pull; missing original quantities are treated as `1`. Imported
history does not establish that all lifetime pulls were retained, or that the
first visible record starts a complete pity interval.

## Capture with Fiddler Classic on Windows

1. Install Fiddler Classic from the [official download page](https://www.telerik.com/download/fiddler).
2. Close unrelated applications that may send private traffic. In Fiddler,
   open **Tools → Options → HTTPS**, enable **Capture HTTPS CONNECTs** and
   **Decrypt HTTPS traffic**, and follow the certificate-trust prompts. Read
   Telerik's [HTTPS setup instructions](https://www.telerik.com/fiddler/fiddler-classic/documentation/configure-fiddler/decrypthttps).
3. Start capture, open Girls' Frontline 2, and open recruitment record history.
   Refresh a history page so that its request appears in Fiddler.
4. Select the request to the official game's recruitment record endpoint. Inspect
   its URL and query parameters rather than selecting unrelated login or payment
   traffic. Copy the full request URL or raw HTTP request that includes the
   history request's authentication parameters.
5. Paste it into the tracker's capture field. Review the two server-data choices
   before importing. The site explains when the capture will pass through its
   server. Do not save the request to an issue or share it with another person.
6. Stop Fiddler capture when finished. Disable HTTPS decryption and remove its
   interception certificate if you no longer need it, following Telerik's
   guidance. Close Fiddler to restore normal traffic routing.

If the browser cannot access the official service, choose the explicit server
fetch fallback or run the local Python collector and import its export. Do not
repeat an uncertain server submission automatically. An expired capture needs a
fresh history request. For unsupported ownership providers, file import and
browser-local storage remain usable while server recovery stays disabled.

New users start with browser-only collection. Unavailable server choices show
their reason beside the controls. Profile, capture, Server ID, and capability
validation happens before the capture field is cleared; collection clears the
credential from the form and never saves or automatically resubmits it.

**Stop collection** works for browser, local-server, and hosted server fetching.
Stopping is cooperative: allow the current request to finish or time out while
validated partial history is preserved. A stop accepted before final saving marks
the collection incomplete; an archive transaction already saving finishes
normally. If the stop response is uncertain, check the saved job instead of
submitting the capture again. Profile and archive changes remain locked until
collection and saving finish. Progress stays available when navigating away from
the import panel, and **View history** opens the resulting ledger.

The workflow was compared with the [Exilium import flow](https://exilium.xyz/import);
the instructions and interface here are maintained independently. Unsupported
Exilium export versions are rejected rather than guessed.
