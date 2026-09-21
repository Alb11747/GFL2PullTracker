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

New sessions are limited to 120/hour and statistics to 30/minute per client IP.
The relay also retains its separate global 600-requests/minute limit and bounded
job pool. Health probes consume the global request budget. Direct loopback web
probes must supply `X-Real-IP: 127.0.0.1`; direct private API probes must supply
`X-GFL2-Client-IP: 127.0.0.1`. Public probes use the ingress normally.

The API deliberately runs one process against SQLite with WAL. Do not scale API
replicas or point multiple hosts at this database. The bounded collection pool
is part of that single process. An interrupted capture job needs a new capture.

## Verify a running release

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
docker compose exec api python scripts/backup_database.py backup /app/data/public.sqlite3 /app/data/backup-20260920.sqlite3
docker compose cp api:/app/data/backup-20260920.sqlite3 ./backup-20260920.sqlite3
```

Public mode uses `public.sqlite3`; the separate Windows/local mode uses
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
docker compose run --rm --no-deps api python scripts/backup_database.py restore /app/data/restore-source.sqlite3 /app/data/public.sqlite3 --service-stopped
docker compose up -d --wait api
```

`docker compose cp` creates a root-owned destination. The one-off ownership step
keeps the backup at mode `0600` and grants the normal service UID 10001 access.
The maintenance override adds only the `CHOWN` capability and root UID for that
fixed permission command. Never use it with `up`; restore and normal service
startup use the base Compose configuration as the unprivileged service user.

Restoring an old database can restore withdrawn contributions or deleted backups.
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
