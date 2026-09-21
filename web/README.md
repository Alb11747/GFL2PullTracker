# Tracker interface

The public deployment uses IndexedDB and workers for personal archives, and the protected `/api/public/*` API for optional server features. Set `GFL2_MODE=public`, the exact HTTPS `PUBLIC_ORIGIN`, `GFL2_API_URL`, and `GFL2_API_ALLOWED_ORIGINS` on the Node server. `PUBLIC_GOOGLE_CLIENT_ID` configures browser-only Google authorization at runtime. See [hosting](../docs/HOSTING.md) for Docker configuration and release gates.

The local archive and sync engines share synthetic parity fixtures with Python. Run `npm test`, `npm run check`, and `npm run build`. Browser tests must also check worker loading, IndexedDB persistence, and file serialization.

Archives, compressed backups, and Drive metadata use explicit stable format version 1.
The stable IndexedDB database, archive references, broadcast channel, and Drive
ownership namespace are separate from prerelease data. Old browser and cloud
archives remain untouched; display preferences survive. Reimport original collector
or Exilium exports instead of migrating prerelease tracker archives. Unsupported
future formats reject without mutation. Subsequent schema changes require tested
migrations. See [the stable baseline](../docs/GOOGLE_DRIVE.md#stable-archive-version-1).

## Page URLs

The main pages use `/history`, `/backup`, `/profiles`, `/statistics`, and `/privacy`.
Navigation retains the current browser archive, filters, imports, and Drive session;
refreshing or opening a link in a new tab loads the requested page with the usual
saved profile preference. Filters and profile IDs are not written into URLs.
The root URL redirects to `/history`, and the full privacy policy lives at
`/privacy-policy`. Local-server mode redirects hosted-only pages to `/history`
and `/privacy` to `/privacy-policy`.

After building, run `npm run test:routes` for HTTP routing checks in both modes.
Run `npm run test:routes:browser` for the isolated application regression fixture;
see [routing tests](tests/routing/README.md) for browser instructions and coverage.

## Windows local mode

Run the two services with the repository's `Start-Tracker.ps1` launcher. The SvelteKit Node server forwards `/api/*` to the loopback Python service configured by `GFL2_API_URL` (default `http://127.0.0.1:8000`). Browsers use only the frontend origin. Development uses port 5173; the production launcher uses port 3000.

From this directory:

```powershell
npm ci
npm run check
npm test
npm run build
```

`npm run format` formats maintained frontend source. Native TypeScript tests use Node's strip-types flag for compatibility with the documented minimum Node 22.12.

The client stores the selected profile ID, per-profile collection job IDs, and optional server-feature preferences in localStorage. Captured HTTP requests are kept in memory, cleared when collection begins after prerequisite validation, and never automatically resubmitted after a network failure. The proxy restricts the backend to a loopback origin, checks incoming hosts/origins, bounds upload bodies, and forwards no browser cookies or authorization headers.

Imports preserve raw page text and require one collector export folder; selecting records.json alone is supported and leaves collection completeness unknown without a manifest. Frontend tests cover these boundaries and the proxy's request restrictions. The backend remains responsible for record validation, profile identity isolation, and transactional merging.

## Import and restore controls

**Choose files** routes collector/Exilium JSON through existing export validation and recognizes gzip tracker backups by their bytes. A backup must be selected alone and pass format, checksum, supported version 1 schema, and size validation. Prerelease tracker backups are unsupported. In hosted mode, it opens **Backup & sync** with the selected file retained; the separate **Restore a tracker backup** link opens the same restore controls. Restoration defaults to merging the contained profiles, with independent fingerprinted conflict choices. Both merge and replacement preserve recovery copies; replacement also requires confirmation. Decisions are rejected if the archive changes before commit. Windows local-server mode rejects compressed archives with an explanation; it does not interpret them as records JSON.

Browser-only collection is the default for new users; saved server choices apply only when supported. Every import retains its operation and destination profile while profile/archive mutations are locked. **Stop collection** aborts browser requests or requests cooperative server cancellation, preserving validated partial history before releasing the lock. The local and public APIs expose idempotent `POST /api/jobs/{id}/cancel` and `POST /api/public/jobs/{id}/cancel`; the public route retains session ownership and CSRF checks. Accepted cancellation moves through `cancelling` to `cancelled`; already-finalizing jobs complete normally. An uncertain cancellation response leaves the job checkable without resubmitting credentials.

Progress remains visible outside the import panel, distinguishes collection, stopping, and saving, and reports records read, added, and total on completion. **View history** focuses the ledger. See [importing](../docs/IMPORTING.md) for supported files and capture instructions.

## Analytics and diagnostics

Runtime configuration enables PostHog only with `GFL2_MODE=public` and
`PUBLIC_POSTHOG_KEY`. Set `PUBLIC_POSTHOG_HOST=https://us.i.posthog.com` and
`PUBLIC_APP_RELEASE` to the deployed revision. The project ingestion token is
public; administrative and source-map upload credentials must remain outside
browser bundles, images, and Git. See [hosting](../docs/HOSTING.md) for deployment
configuration and private source-map uploads.

The root layout initializes telemetry before child requests and tracks one
pageview per navigation. Explicit operation events contain only a fixed operation,
outcome, and duration. The Privacy switch and first-visit notice control a
device-local preference, excluded from portable settings and synchronized across
tabs. Public API calls send `X-GFL2-Telemetry: 0|1`; existing jobs retain submission
permission. Local mode and deployments without a token remain disabled.

Replay masks all text and inputs and blocks tracker content and header profile
controls with `ph-no-capture`. Keep new private surfaces inside those boundaries;
never interpolate identifiers, filenames, captures, or history data into telemetry.
Console and network payload recording and general interaction autocapture are
disabled. Only the navigation shell is recordable. Verify outgoing events and
decoded replay payloads with synthetic secrets when changing those boundaries.

## Dependency notes

SvelteKit 2.70.3 still requests cookie 0.6.x, affected by GHSA-pxg6-pf52-xh8x. A scoped override supplies cookie 0.7.2 to SvelteKit, preserving its parse/serialize APIs while rejecting invalid cookie names, paths, and domains. Remove the override when SvelteKit's dependency includes the fix. Public mode uses secure, HttpOnly session cookies with CSRF protection; local mode does not.

Barlow and Barlow Condensed are self-hosted through Fontsource; their original OFL notices are included at `/fonts-license.txt`. The synthetic design mock remains outside this repository and is not included in the shipped application.
