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

Capture imports show two independent choices before submission: **Save server
backup** and **Contribute to community statistics**. Their initial value is on;
subsequent choices are remembered. When both are off, the browser attempts a
direct official game request. An explicit server fallback sends the capture
through the server's memory. When either server feature is selected, the server
fetches the history once and returns it to the browser.

Captures and credential-bearing URLs must not be stored in browser storage,
server files, logs, backups, or analytics. Avoid pasting captures into support
messages. Captures can contain reusable game authentication material.

Private server backups and community contributions are separate. Private access
requires a fresh authenticated capture with provider-supported ownership proof.
The server issues a short-lived HttpOnly session cookie; Google login alone
does not authorize a server backup. Providers lacking trustworthy account
binding remain unavailable for recovery.

Community statistics accept only pulls fetched by this server from the game
service, deduplicate repeated contributions, and exclude uploaded histories.
Public output contains aggregates, never personal histories or identifiers.
Small cohorts are suppressed. Disabling contribution withdraws that account's
records from future calculations. Deleting a private server backup is a separate
action and does not imply deleting browser or Drive copies.

Drive stores versioned compressed archives in this application's hidden data
folder. Archives contain histories, profile identities, source snapshots, and
portable settings; they exclude tokens, sessions, and server verification claims.
Compression is not encryption. Downloaded backups contain private game data.

Removing a local profile and deleting a profile across synced devices are
different actions. Drive changes do not automatically change server backup or
contribution consent. Device conflicts require explicit resolution where an
automatic merge would discard an edit.

Operators can receive ordinary connection metadata such as IP addresses. They
must publish their contact details, retention policy, hosting jurisdiction, and
any additional telemetry before offering a public service. The default project
does not add advertising or third-party analytics.
