# Hosting and operations

The default Compose stack runs the public website with a private FastAPI service
and a persistent SQLite volume. It does not publish a repository or deploy to a
remote host. The Windows collector and launcher remain a separate local mode.

## Configure and start

1. Install Docker Engine with Compose v2. Copy `.env.example` to `.env`.
2. Set `PUBLIC_ORIGIN` to the exact HTTPS origin, such as
   `https://tracker.example.com`. Do not include a path or trailing slash.
3. Optionally set `PUBLIC_GOOGLE_CLIENT_ID` using [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md).
4. Review [PRIVACY.md](PRIVACY.md), set an operator contact on your site, and finish
   the release gates below before accepting public users.
5. Run `docker compose build` then `docker compose up -d --wait`.

The web service listens on `127.0.0.1:3000` by default. Put your existing HTTPS
reverse proxy in front of it, preserving the original Origin header. Do not
publish the API port. The ingress must overwrite `X-Real-IP` with a single trusted
client IP, never pass through a browser-supplied value. Compose fixes SvelteKit's
`ADDRESS_HEADER=x-real-ip`; missing or malformed identities fail closed. The web
service validates the adapter address and creates `X-GFL2-Client-IP` for the
private API, replacing any browser-supplied internal header. Only the frontend
and operational probes may access the backend network; this internal header is
not authentication for an exposed API. Keep Uvicorn proxy-header handling off.

If your reverse proxy sits behind a CDN, restrict real-IP processing to
the CDN's trusted CIDRs and keep them current. Never trust arbitrary
forwarding sources. The included Caddy example uses the direct peer IP
and requires direct DNS, without another CDN or proxy in front of Caddy.

To use the included Caddy configuration instead, point DNS
at this host, allow inbound ports 80 and 443, and run:

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

Caddy obtains and renews the site's certificate. The base frontend remains
loopback-only. Do not turn on access logging for capture requests or add request
bodies/query strings to proxy, tracing, or error-monitoring logs.

`GFL2_MODE=public` is fixed in Compose. `GFL2_FRONTEND_ORIGIN` and the SvelteKit
`ORIGIN` must match `PUBLIC_ORIGIN`; the web service's `GFL2_API_URL` must appear
exactly in `GFL2_API_ALLOWED_ORIGINS`. The internal API uses Docker DNS at
`http://api:8000`. The backend network needs outbound HTTPS to the allowlisted
game APIs; no inbound API port is mapped. Do not add wildcard origins.

The public history database starts fresh at `public-v2.sqlite3`. Legacy
`public.sqlite3` is preserved and is not migrated or read into the unified store.
`GFL2_PUBLIC_DATABASE_MAX_BYTES` must be a positive integer number of bytes; the
default is `8589934592` (8 GiB). Compose passes this limit to the API. Submission
requests are bounded to 16 MiB and 100 snapshots per request; there is no
cumulative snapshot-count limit. Monitor database size and preserve capacity
for operational recovery.

New sessions are limited to 120/hour and statistics to 30/minute per client IP.
Relay attempts are limited to 10/hour per session and 60/hour per trusted client
IP. A shared 10/hour account quota or active-account exclusion applies only after server
ownership verification; a relay capture's supplied account identifier cannot
reserve another visitor's quota. Ownership features remain disabled without a
provider verifier.
The relay also retains its separate global 600-requests/minute limit and bounded
job pool. Health probes consume the global request budget. Direct loopback web
probes must supply `X-Real-IP: 127.0.0.1`; direct private API probes must supply
`X-GFL2-Client-IP: 127.0.0.1`. Public probes use the ingress normally.

The API deliberately runs one process against SQLite with WAL. Do not scale API
replicas or point multiple hosts at this database. The bounded collection pool
is part of that single process: two workers and eight active jobs or retained
result payloads. Result-less terminal statuses expire after 15 minutes and have
a separate 64-entry cap; the oldest statuses may be evicted sooner. They do not
consume collection capacity. An interrupted capture job needs a new capture.

## Verify a running release

### About feedback form

Create an API survey in the same PostHog project as the ingestion token, named
`Tracker feedback`, with these questions in order: single choice `Category`
(`Give feedback`, `Report a bug`), required open-text `Message`, and optional
open-text `Email (optional)`. Disable partial responses. Launch the API survey;
the tracker renders it itself and never enables automatic survey display.

Set these public runtime identifiers in the deployment `.env`:
`PUBLIC_FEEDBACK_SURVEY_ID`, `PUBLIC_FEEDBACK_CATEGORY_ID`,
`PUBLIC_FEEDBACK_MESSAGE_ID`, and `PUBLIC_FEEDBACK_EMAIL_ID`. Use the stable
survey/question UUIDs returned by PostHog, not question indexes. Compose passes
them to the web service. An incomplete configuration leaves About available
with a GitHub fallback. No personal API key belongs in browser configuration.

The form submits one completed `survey sent` event directly through the existing
US ingestion endpoint, even when automatic analytics are off. It uses a fresh
anonymous identity per submission and preserves analytics preferences. Text and
email are intentionally included only on explicit submission; the normal event
sanitizer continues to reject survey events. Optional diagnostics consume the
already-sanitized local error once, preventing a duplicate toast submission.
Network uncertainty never triggers an automatic retry. Validate with isolated
network fixtures, then confirm a clearly marked test response in Surveys after
deployment; ingestion acknowledgement alone does not prove survey rendering.

### Optional PostHog diagnostics

Set `PUBLIC_POSTHOG_KEY` to the project's public ingestion token and
`PUBLIC_POSTHOG_HOST=https://us.i.posthog.com`. Leave the token blank to disable
browser and server telemetry. Local-server mode never enables telemetry. Set
`POSTHOG_PROJECT_ID` for source-map uploads and set `GFL2_RELEASE` to the
exact Git revision for both services.

Compose labels telemetry `environment=production` by default. For a dev, staging,
or QA deployment with telemetry explicitly configured, set
`GFL2_TELEMETRY_ENVIRONMENT=development`, `staging`, or `test` in its runtime
environment. This applies to browser events/replays and both backend services.
The Vite dev server always labels its browser and web-service events
`development`; standalone services without a valid setting also default to
`development`. Local mode and ordinary automated tests still send no telemetry.

In PostHog project settings, **Filter out internal and test users** should keep
only events where `environment` is not `development`, `staging`, or `test`,
alongside any existing internal-user exclusions. Enable the default checkbox
for new insights and enable it on existing dashboard insights. This filters
reports without deleting dev diagnostics; turn the filter off to inspect them.
Use event properties because the tracker does not create person profiles.

Authenticate `web/node_modules/.bin/posthog-cli login` separately. Keep a private
dotenv file at `/absolute/private/posthog-cli.env`, readable only by
the deploying account, containing `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`,
and `POSTHOG_CLI_HOST=https://us.posthog.com`. The personal API key requires only
the source-map upload scopes (error tracking write and organization read).
Never commit this file, include it in the Docker context, or place its values in
public environment variables. Set `POSTHOG_CLI_ENV_FILE` to its path so
`compose.posthog.yaml` supplies it as a BuildKit secret. Failed authentication/upload stops the
build before services change. Source maps are injected into the actual shipped
build, uploaded with the revision, and removed from the runtime image.
Telemetry builds use a revision-specific asset URL and regenerate compressed
JavaScript after injection so browsers and CDNs receive matching symbol IDs.

Use both Compose files and set
`POSTHOG_CLI_ENV_FILE` to the private dotenv path. Ordinary `npm run build` does
not generate browser source maps. The opt-out cookie is device-local; requests
carry only a normalized boolean through the proxy. Background jobs retain the
preference from submission, so disabling collection affects subsequent jobs.

In PostHog, disable interaction autocapture, automatic exception capture,
console/network recording, heatmaps and surveys. Enable replay at 100% with IP
anonymization. The application applies text/input masking and blocks private
content independently of remote settings. Verify ingestion, safe error frames,
replay masking and opt-out with synthetic data after rollout. SDK or collector
failure must not interfere with imports, archives or sync.

Replay deliberately removes arbitrary attributes, styles, and private content;
playback shows a simplified masked page rather than the full visual design.
For release verification, check that synthetic exceptions become error-tracking
issues with resolved source locations, not just accepted `$exception` events.
Decode replay payloads and play them back: a successful ingestion response alone
does not establish privacy or playback correctness.

### Health and functional checks

```sh
docker compose ps
docker compose logs --since 5m api web
curl --fail https://tracker.example.com/api/health
```

Verify profile creation, synthetic file import, backup download and restore in a
fresh browser profile. Check browser storage persists after reload and server
storage persists after `docker compose restart api`. Check the public aggregate
endpoint never reveals identifiers. Use synthetic data for operational tests.
Authenticated upstream and real Google OAuth behavior require explicit live
tests; passing synthetic tests alone does not establish them.

## Database backups and restore

Use the SQLite backup API; copying a live `.sqlite3` file can omit WAL changes.
The helper checks database integrity and refuses to overwrite an existing backup.
Keep backups private, restrict access, and establish a retention schedule. Copy
them off this host; a copy inside the application volume is not disaster recovery.

```sh
docker compose exec api python scripts/backup_database.py backup /app/data/public-v2.sqlite3 /app/data/backup-20260920.sqlite3
docker compose cp api:/app/data/backup-20260920.sqlite3 ./backup-20260920.sqlite3
```

Public mode uses `public-v2.sqlite3`; the separate Windows/local mode uses
`tracker.sqlite3`. Back up each database you actually operate. Backups contain
private histories and session data; never commit them.

For restore, first stop every writer. Copy the chosen backup into the stopped
container's data volume before restoring. The helper saves the replaced database
as `.pre-restore` and refuses another replacement until that recovery file has
been moved to private storage. Sidecar files cause a fail-closed refusal; do not
delete them while a database writer may still be running.

```sh
docker compose stop api
docker compose cp ./backup-20260920.sqlite3 api:/app/data/restore-source.sqlite3
docker compose -f compose.yaml -f compose.restore-permissions.yaml run --rm --no-deps api
docker compose run --rm --no-deps api python scripts/backup_database.py restore /app/data/restore-source.sqlite3 /app/data/public-v2.sqlite3 --service-stopped
docker compose up -d --wait api
```

`docker compose cp` creates a root-owned destination. The one-off ownership step
keeps the backup at mode `0600` and grants the normal service UID 10001 access.
The maintenance override adds only the `CHOWN` capability and root UID for that
fixed permission command. Never use it with `up`; restore and normal service
startup use the base Compose configuration as the unprivileged service user.

Restore only a compatible `public-v2.sqlite3` backup; renaming a legacy
`public.sqlite3` backup does not migrate it. Keep legacy backups separately.
Restoring an old database can restore deleted server histories and their
contributions to statistics.
Reconcile deletion requests before making a restored service public. Verify
health and synthetic recovery after every restore drill.

## Upgrades and rollback

Record the current commit and image IDs, make a verified off-host database
backup, and review release migration notes. Build the new release, then use
`docker compose up -d --wait`; review health and logs. Keep the previous image
tags available. If validation fails, stop the API, restore the pre-upgrade
database using the procedure above if schema compatibility requires it, and
start the previous images. Do not use `down -v` as an upgrade or rollback step.

## Release gates

- Validate the stable version 1 archive baseline using the
  [publication checklist](PUBLICATION.md#first-public-release-checklist). Stable
  storage is separate from prerelease archives, which remain untouched. Later
  format changes require tested migrations; unsupported formats must fail closed.
- Provide a real HTTPS origin and Google OAuth client before testing Drive.
- This release intentionally ships without enabled provider verifiers, so
  server backup, game-account recovery, and community contribution remain
  unavailable. Credential-to-account binding must be proved using each provider's actual
  authenticated response before server recovery is enabled for that provider.
  Unsupported providers fail closed; supplied UIDs and decoded tokens do not
  prove ownership. Do not remove this gate to make the UI appear functional.
- Verify real authenticated browser requests, because a CORS preflight alone
  does not establish usable direct imports.
- Run the full tests, container health/persistence checks, dependency audits,
  source-history scan, and a restore drill against the final release.
- Supply your site's privacy/contact information and enable private GitHub
  vulnerability reporting before publication.
