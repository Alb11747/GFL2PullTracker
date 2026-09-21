# Tracker interface

The public deployment uses IndexedDB and workers for personal archives, and the protected `/api/public/*` API for optional server features. Set `GFL2_MODE=public`, the exact HTTPS `PUBLIC_ORIGIN`, `GFL2_API_URL`, and `GFL2_API_ALLOWED_ORIGINS` on the Node server. `PUBLIC_GOOGLE_CLIENT_ID` configures browser-only Google authorization at runtime. See [hosting](../docs/HOSTING.md) for Docker configuration and release gates.

The local archive and sync engines share synthetic parity fixtures with Python. Run `npm test`, `npm run check`, and `npm run build`. Browser tests must also check worker loading, IndexedDB persistence, and file serialization.

Archive, backup, and Drive data use one strict unversioned prerelease schema.
The cutover clears the former browser archive and recovery data, stale profile
and job references, and obsolete versioned cloud files. Display preferences remain.
IndexedDB still uses its required database revision to coordinate storage changes
and close older connections. Windows SQLite data and original exports remain
untouched. See [reset and cleanup rules](../docs/GOOGLE_DRIVE.md#prerelease-archive-reset).

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

**Choose files** routes collector/Exilium JSON through existing export validation and recognizes gzip tracker backups by their bytes. A backup must be selected alone and pass format, checksum, strict unversioned schema, and size validation. Earlier versioned tracker backups are unsupported. In hosted mode, it opens **Backup & sync** with the selected file retained; the separate **Restore a tracker backup** link opens the same restore controls. Restoration defaults to merging the contained profiles, while replacement requires confirmation and downloads a recovery copy first. Windows local-server mode rejects compressed archives with an explanation; it does not interpret them as records JSON.

Browser-only collection is the default for new users; saved server choices apply only when supported. Every import retains its operation and destination profile while profile/archive mutations are locked. **Stop collection** aborts browser requests or requests cooperative server cancellation, preserving validated partial history before releasing the lock. The local and public APIs expose idempotent `POST /api/jobs/{id}/cancel` and `POST /api/public/jobs/{id}/cancel`; the public route retains session ownership and CSRF checks. Accepted cancellation moves through `cancelling` to `cancelled`; already-finalizing jobs complete normally. An uncertain cancellation response leaves the job checkable without resubmitting credentials.

Progress remains visible outside the import panel, distinguishes collection, stopping, and saving, and reports records read, added, and total on completion. **View history** focuses the ledger. See [importing](../docs/IMPORTING.md) for supported files and capture instructions.

## Dependency notes

SvelteKit 2.70.3 still requests cookie 0.6.x, affected by GHSA-pxg6-pf52-xh8x. A scoped override supplies cookie 0.7.2 to SvelteKit, preserving its parse/serialize APIs while rejecting invalid cookie names, paths, and domains. Remove the override when SvelteKit's dependency includes the fix. Public mode uses secure, HttpOnly session cookies with CSRF protection; local mode does not.

Barlow and Barlow Condensed are self-hosted through Fontsource; their original OFL notices are included at `/fonts-license.txt`. The synthetic design mock remains outside this repository and is not included in the shipped application.
