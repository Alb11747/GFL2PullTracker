# GFL2 Pull Tracker

A local Girls' Frontline 2 pull-history viewer. Import saved collector exports or paste a captured HTTP request, then review totals and detailed history on the same page.

## Start on Windows

Install Python 3.11 or newer, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Node.js 22.12 or newer. From this directory, run:

```powershell
.\Start-Tracker.ps1
```

The launcher installs the locked dependencies, builds the web app, and opens `http://127.0.0.1:3000`. Python listens on port 8000. Both services bind to loopback. Press Ctrl+C in the launcher to stop them.

Use `-Development` for Vite development mode, `-NoBrowser` to skip opening a tab, or `-Port 3010 -ApiPort 8010` when the default ports are occupied. The launcher does not stop existing processes.

## Import history

Create or select a profile before importing. Each profile has its own history. An import with a different known account, server, or channel is rejected.

For a saved export, select the collector's timestamped export folder so the viewer can retain `records.json`, `manifest.json`, and raw pages together. Records without a manifest can still be imported, but collection completeness is unknown. Older exports lack server/channel metadata; assigning them to a profile is an explicit choice, not proof of their server identity.

For new history, paste the full copied HTTP POST request in the fetch panel. The request must target a supported official HTTPS history host. The collector derives the server from the request, or accepts the verified numeric server override. Expired or invalid captures need to be copied again. The app does not capture game traffic automatically.

Credentials remain in memory during fetching. They are not saved to the database, browser storage, or export files. Closing the page does not stop an active backend job. Restarting the backend marks an unfinished job interrupted; submit a fresh capture to retry.

The original CLI remains available:

```powershell
uv run python scripts/fetch_pull_history.py C:\path\to\capture.txt
```

Use `-` as the capture path to read stdin. Run the command with `--help` for discovery limits and other collector options.

## Understand the numbers

Each saved API record counts as one pull. Item quantity is shown separately. Repeated identical records can represent legitimate pulls; merging retains the largest occurrence count seen in any snapshot for that profile and source type. Importing the same history again does not increase totals.

Search and filters apply to both the overview and the full history, independent of the visible page. Dates and date filters use UTC. Multi-pull groups are estimates based on matching source type, pool, and timestamp. They are not verified ten-pulls.

"Collection complete" means the collector finished its configured scan of accessible history. It does not establish lifetime coverage or prove that every possible API type exists within that scan. Unknown items and pools remain visible by ID. Rarity statistics include known dolls and weapons; unknown rewards are counted separately. Pity and guarantee calculations are not implemented.

## Data and development

Personal data defaults to `data/`, excluded from Git. Set `GFL2_DATA_DIR` to an absolute directory to keep it elsewhere. Back up that entire directory while the services are stopped. Original CLI exports are preserved. Imported snapshot documents and provenance are also retained in SQLite.

The independent lookup catalog and its reproducible update command are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

```powershell
uv sync --frozen
uv run pytest
cd web
npm ci
npm run check
npm run build
```

SvelteKit forwards same-origin `/api` requests to FastAPI. `GFL2_API_URL` selects the backend URL; `GFL2_FRONTEND_ORIGIN` configures the permitted browser origin. The launcher supplies both. FastAPI owns collection and storage; the browser never contacts the game's history API directly. API documentation is available at `http://127.0.0.1:8000/docs` while running.

The current service has a local owner and profile-scoped storage. Public hosting needs authentication, owner authorization, deployment configuration, and a review of credential handling before exposure. Login, sharing, and hosted deployment are outside this version.
