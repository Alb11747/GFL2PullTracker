# Google Drive setup

The hosted site is `https://gfl2.alb11747.com`, with public support at
`gfl2@alb11747.com`. Its privacy policy is available at
`https://gfl2.alb11747.com/privacy` and discloses Canadian origin hosting.
Configure a separate OAuth client for each installation using the instructions below.
See [HOSTING.md](HOSTING.md) for deployment instructions.

## Live validation

On September 20, 2026, the hosted website passed real Google authorization,
compressed archive upload, automatic sync after a readable Exilium import, and
disconnect/reconnect read-back with integrity validation. The repeat import
added no duplicate pulls and preserved the existing archive count. Read-back
was tested in the same browser with its local history retained; it is not proof
of fresh-device recovery.

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

## Remaining live tests

Test using two browser profiles connected to the same Google account: import on
each while offline, reconnect, then check occurrence counts and conflict
resolution. Test a fresh profile restore, revoked consent, an expired token,
interrupted upload, and a full quota before declaring live Drive sync verified.
Google authorization never grants access to the application's server backups.

Revisions are immutable and retained, with a maximum of 2,000 revisions per cloud archive. Deleting a profile across devices changes the current archive; old Drive revisions may still contain its history. To erase historical copies, first download anything you want to keep, disconnect the app on all devices, and clear this app's data using Google Drive's app-management controls. Reconnecting devices that retain old histories can upload them again.
