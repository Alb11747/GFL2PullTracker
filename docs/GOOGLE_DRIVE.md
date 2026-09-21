# Google Drive setup

The hosted site is `https://gfl2.alb11747.com`, with public support at
`gfl2@alb11747.com`. Its privacy policy is available at
`https://gfl2.alb11747.com/privacy-policy` and discloses Canadian origin hosting.
Configure a separate OAuth client for each installation using the instructions below.
See [HOSTING.md](HOSTING.md) for deployment instructions.

## Live validation

On September 20, 2026, the hosted website passed real Google authorization,
compressed archive upload, automatic sync after a readable Exilium import, and
disconnect/reconnect read-back with integrity validation. The repeat import
added no duplicate pulls and preserved the existing archive count. Read-back
was tested in the same browser with its local history retained; it is not proof
of fresh-device recovery.

Those results belong to the earlier versioned implementation. They do not
validate the stable version 1 baseline, invalid-file cleanup, or current sync
performance. Record new live evidence against the deployed commit separately
from synthetic transport and browser test results.

Fresh-device restoration, two-device conflicts, revoked or expired authorization,
interrupted uploads, and quota failures still need live testing. Existing
automated coverage does not establish those Google runtime outcomes.

## Configure another installation

Create a Google Cloud project, enable the Google Drive API, configure its OAuth
consent screen, and create an OAuth client of type **Web application**. Register
the site's exact HTTPS origin as an authorized JavaScript origin. Register a
separate localhost origin for development if required. Add test users while the
consent screen remains in testing.

Set `PUBLIC_GOOGLE_CLIENT_ID` to the web client ID. This identifier is public and
is delivered to the browser. Never provide a client secret: this integration
uses the Google Identity Services browser token client. Restart the web service
after changing its runtime environment.

Request only `https://www.googleapis.com/auth/drive.appdata`. Google documents
this as a non-sensitive scope for an app-specific hidden data folder. Files in
that folder are accessible through this application and cannot be shared like
ordinary Drive files. See Google's [application data guide](https://developers.google.com/workspace/drive/api/guides/appdata)
and [browser token model guide](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

Access tokens stay in browser memory. Reconnect when authorization expires or
is revoked, or after reloading the page. Sync runs while the page is open; it
cannot run after the browser is closed. Browser-local save status and cloud sync
status are separate. Quota or network failures must leave local histories intact.

## Connect and check a backup

Open **Backup & sync → Connect Google Drive**, select the intended Google account,
and approve access to this app's private Drive data. This grants no access to
Gmail messages or ordinary Drive files. Connection immediately merges the cloud
archive with local history and uploads changes; resolve any reported conflicts
before continuing. Wait for **Saved on this device and synced to Google Drive**
and check **Last synced** after an import. **Sync now** performs an explicit check.

If the page remains at **Waiting for Google authorization**, look for Google's
separate account chooser window. During browser automation that window can be
unresponsive even though the initial upload succeeded. Close the stalled chooser
and, once local saving has completed, reload the tracker and reconnect. A popup
failure alone does not mean the local archive or an earlier cloud backup was lost.

## Stable archive version 1

The first supported archive baseline uses `version: 1` in portable archives,
gzip backup envelopes, and Drive revision descriptions. The gzip envelope's
SHA-256 digest covers the validated portable state, including its version.
Google's own file `version` remains an unrelated observed content generation.

Stable browser storage uses the separate IndexedDB database
`gfl2-pull-tracker-stable`, database revision 1. The prerelease
`gfl2-pull-tracker` database, its recovery copy, and device exclusions are left
untouched. Stable profile/job references and cross-tab messages use a separate
namespace; display preferences remain. An old tab can continue using its old
archive, but cannot overwrite the stable archive.

Stable Drive files use the ownership marker `tracker=gfl2-stable`. Stable clients
list only that marker. Earlier clients' `gfl2`/`gfl2-v1` cleanup queries cannot
find stable files, and stable clients never clean up prerelease files. Keep
prerelease archives separately if they matter; do not erase them to upgrade.
There is no prerelease tracker-backup reader or migration. Reimport original
collector or supported Exilium exports into the fresh stable archive. Their
independent source schema versions are unchanged.

A future or missing archive version is unsupported, not corrupt. The tracker
stops that sync or restore before applying local data or removing any cloud
files. Update the tracker before reading a future backup. Supported-version
files proven corrupt by metadata, size, decompression, checksum, or schema checks
can be cleaned up only after a complete listing and payload audit rules out
unsupported versions. Network errors, revoked authorization, quota failures,
cancellation, and incomplete listings never establish corruption. An uncertain
deletion is checked by listing again; local history remains intact on failure.

Healthy snapshots remain usable when a parent revision is missing or removed.
Their merge base is unknown, so conflicting changes still need a decision.
Profiles and deletion markers retain aliases for earlier profile IDs, preventing
an offline device from silently restoring deleted history after account profiles
merge. Device exclusions stay local and survive stable archive replacements.

Version 1 has no previous supported version to migrate. Any later schema change
must add explicit, tested migrations with integrity validation before conversion,
atomic failure, recovery copies, concurrent-tab and offline-device coverage, and
a documented rollback boundary. Never delete a stable store during upgrade.
Downgrading to a prerelease client exposes only that client's separate archive;
it cannot read stable backups. A version 1 client refuses a later IndexedDB
revision or unsupported archive instead of resetting it.

## Conflict resolution and verification

Conflict choices apply to the archive and alternatives shown in the dialog.
Accepted choices are retained if resolving one conflict reveals another. New
local edits or changed cloud heads invalidate those choices, and a concurrent
edit during the final save causes the replacement to fail safely. Identity
choices may require a separate decision about a conflicting deletion.

Theme, language, and page-size preferences sync independently. Changes on one
device propagate; simultaneous different values require an explicit choice.
Consent and server-feature preferences remain device-local. Once devices agree,
unchanged syncs do not publish more revisions.

Run `npm test` for deterministic conflict, format, integrity, cleanup, and convergence
regressions. From `web`, `npm run test:browser` starts the isolated synthetic
browser harness described in [browser tests](../web/tests/browser/README.md).
Verify the actual conflict dialog, workers, IndexedDB isolation, and concurrent local
writes with its simulated Drive transport. These checks do not establish
authenticated Google runtime behavior.

## Remaining live tests

Test using two browser profiles connected to the same Google account: import on
each while offline, reconnect, then check occurrence counts and conflict
resolution. Test a fresh profile restore, revoked consent, an expired token,
interrupted upload, and a full quota before declaring live Drive sync verified.
Check invalid-file cleanup with disposable app-data files, including a healthy
snapshot whose parent is absent. Confirm that failed downloads never delete files
and that unchanged sync lists metadata without rewriting the archive.
Google authorization never grants access to the application's server backups.

Revisions are immutable and retained, with a maximum of 2,000 revisions per cloud archive. Deleting a profile across devices changes the current archive; old Drive revisions may still contain its history. To erase historical copies, first download anything you want to keep, disconnect the app on all devices, and clear this app's data using Google Drive's app-management controls. Reconnecting devices that retain old histories can upload them again.
