# Data and privacy

Histories and game profiles are stored in this browser's IndexedDB. Clearing
site data or deleting a browser profile can remove them. Download a backup or
connect Drive before relying on the browser as your only copy.

There is no website account. A game profile identifies a game account, official
host, server, and channel; incompatible identities cannot be combined. Legacy
files without an identity need an explicit profile assignment.

This release has no enabled provider ownership verifiers. Server backup,
game-account recovery, and community contribution are therefore unavailable;
the following describes the access and consent rules enforced when a verified
provider is added. Local import, downloads, Drive, and explicit relay import can
be used independently of that gate.

Capture imports show one combined choice: **Contribute to community statistics /
Save server backup**. It defaults on when available; explicit opt-out is remembered
on this device and stops future submissions without deleting previously saved
server history. **Recover a private server backup** defaults off and runs separately from
submission: recovery never uploads or contributes history. With server features
off, the browser attempts a direct official game request. An explicit server
fallback sends the capture through the server's memory. When submission is
selected, the server fetches the history once and returns it to the browser.

Captures and credential-bearing URLs must not be stored in browser storage,
server files, logs, backups, or analytics. Avoid pasting captures into support
messages. Captures can contain reusable game authentication material.

Server-collected histories and uploaded histories explicitly submitted after
account verification enter one normalized SQLite store associated with the
verified actual UID, provider, server, and channel. Source and snapshot fingerprint
provenance are retained. The same data supports private recovery and community
statistics. Account ownership verification does not independently verify uploaded
records' authenticity.

Submission, recovery, and deletion require fresh authenticated capture proof with
provider-supported ownership verification. The server issues a short-lived
HttpOnly session cookie; Google login alone does not authorize these actions.
There is no recovery key. Providers lacking trustworthy account binding remain
unavailable.

Public output contains aggregates, never personal histories or identifiers.
Cohorts with fewer than five contributors are suppressed. **Delete server history**
removes the account's server backup and contribution to future statistics together;
it does not delete browser or Drive copies. Opting out only stops future
submissions. Drive sync cannot enable submission or recovery.

Drive stores immutable compressed archives in this application's hidden data
folder. Archives contain histories, profile identities, source snapshots, and
portable settings; they exclude tokens, sessions, and server verification claims.
Compression is not encryption. Downloaded backups contain private game data.

Stable archive version 1 uses a separate browser database and Drive ownership
namespace. Prerelease archives, recovery copies, and Drive files remain untouched;
original collector or Exilium exports can be reimported. Display preferences and
Windows SQLite history are preserved. Sync deletes only owned stable tracker files
proven invalid after the complete version audit; unsupported future formats stop
without cleanup or local mutation. Network and authorization failures do not
establish corruption. See the [format and cleanup rules](GOOGLE_DRIVE.md#stable-archive-version-1).

Removing a local profile and deleting a profile across synced devices are
different actions. Drive changes do not automatically change server backup or
contribution consent. Device conflicts require explicit resolution where an
automatic merge would discard an edit.

## Analytics and diagnostics

Configured public deployments use PostHog's US service for pageviews, fixed
import/backup/restore/Drive-sync outcome codes and durations, sanitized exceptions,
and masked session replay. Collection is on by default. Local mode and unconfigured
deployments do not collect telemetry. Browser identity is random and is not linked
to game or Google accounts. Events include the service and deployed revision.

The first-visit notice offers a disable action. **Analytics & diagnostics** in
Privacy controls the same device-local preference, synchronized across tabs and
excluded from backups and Drive. Disabling stops browser collection and recording
and excludes subsequent server requests and newly submitted jobs. Running jobs keep
the permission recorded at submission. Opt-out does not delete already submitted
telemetry; clearing site data resets the device preference.

Replay masks inputs and text and blocks private archive content and profile
controls. Navigation remains recordable. Console and network payload recording
are disabled. Never send captures, tokens, game account IDs, filenames, histories,
request bodies or headers, or Python local variables. Page URLs omit query strings
and fragments; errors use fixed messages and safe stack locations. General
interaction autocapture and account identification are disabled.

Operators and PostHog can receive ordinary connection metadata such as IP
addresses. Operators must publish contact details, retention policy, and hosting
jurisdiction before offering a public service. This project does not add
advertising. See [PostHog's privacy policy](https://posthog.com/privacy).

## Voluntary feedback and bug reports

The hosted tracker's About tab lets you explicitly send feedback or report a bug
through a dedicated PostHog survey. A submission includes your selected category,
message, and optional email address so the operator can contact you. Do not include
game captures, credentials, private account information, or pull history in your
message. Drafts stay in browser memory across tracker tabs and clear when you leave
or reload the page; they are not saved in browser storage, backups, or Drive.

Sending is available even when automatic analytics are off. It uses a fresh random
identifier for each submission, includes the deployed revision and environment,
and does not use the analytics identity, create a person profile, or change your
analytics preference. Feedback fields are excluded from automatic capture and
session replay. Only pressing Send uploads their contents.

For a bug report, you may separately choose to attach a pending sanitized technical
diagnostic snapshot. This unchecked option includes the existing in-memory report,
not session replay, form contents, or pull history. It shares the pending report
with the error prompt to prevent simultaneous duplicate sends. Submissions are not
retried automatically. If delivery cannot be confirmed, the draft is retained and
sending it again may create a duplicate.
