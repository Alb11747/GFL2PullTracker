# Tracker interface

The public deployment uses IndexedDB and workers for personal archives, and the protected `/api/public/*` API for optional server features. Set `GFL2_MODE=public`, the exact HTTPS `PUBLIC_ORIGIN`, `GFL2_API_URL`, and `GFL2_API_ALLOWED_ORIGINS` on the Node server. `PUBLIC_GOOGLE_CLIENT_ID` configures browser-only Google authorization at runtime. See [hosting](../docs/HOSTING.md) for Docker configuration and release gates.

The local archive and sync engines share synthetic parity fixtures with Python. Run `npm test`, `npm run check`, and `npm run build`. Browser tests must also check worker loading, IndexedDB persistence, and file serialization.

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

The client stores only the selected profile ID and per-profile collection job IDs in localStorage. Captured HTTP requests are kept in memory, cleared on submission, and never automatically resubmitted after a network failure. The proxy restricts the backend to a loopback origin, checks incoming hosts/origins, bounds upload bodies, and forwards no browser cookies or authorization headers.

Imports preserve raw page text and require one collector export folder; selecting records.json alone is supported and leaves collection completeness unknown without a manifest. Frontend tests cover these boundaries and the proxy's request restrictions. The backend remains responsible for record validation, profile identity isolation, and transactional merging.

## Dependency notes

SvelteKit 2.70.3 still requests cookie 0.6.x, affected by GHSA-pxg6-pf52-xh8x. A scoped override supplies cookie 0.7.2 to SvelteKit, preserving its parse/serialize APIs while rejecting invalid cookie names, paths, and domains. Remove the override when SvelteKit's dependency includes the fix. Public mode uses secure, HttpOnly session cookies with CSRF protection; local mode does not.

Barlow and Barlow Condensed are self-hosted through Fontsource; their original OFL notices are included at `/fonts-license.txt`. The synthetic design mock remains outside this repository and is not included in the shipped application.
