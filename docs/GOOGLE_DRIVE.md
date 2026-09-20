# Google Drive setup

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
is revoked. Sync runs while the page is open; it cannot run after the browser is
closed. Browser-local save status and cloud sync status are separate. Quota or
network failures must leave local histories intact.

Test using two browser profiles connected to the same Google account: import on
each while offline, reconnect, then check occurrence counts and conflict
resolution. Test a fresh profile restore, revoked consent, an expired token,
interrupted upload, and a full quota before declaring live Drive sync verified.
Google authorization never grants access to the application's server backups.

Revisions are immutable and retained, with a maximum of 2,000 revisions per cloud archive. Deleting a profile across devices changes the current archive; old Drive revisions may still contain its history. To erase historical copies, first download anything you want to keep, disconnect the app on all devices, and clear this app's data using Google Drive's app-management controls. Reconnecting devices that retain old histories can upload them again.
