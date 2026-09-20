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

To open the automatic paste window, run:

```powershell
uv run python scripts/fetch_pull_history.py
```

Paste the copied block into the window, including the `POST` line and `Authorization` header. Fetching starts automatically once the request is detected; no submit button or terminator is needed. Blank lines and response headers are accepted. Close the window to cancel. The window requires Python with Tkinter (included in standard Windows Python installations). The capture stays in memory; exports go to timestamped folders under `data/exports/`. Import that folder in the viewer to see the results.

The CLI also accepts a saved capture:

```powershell
uv run python scripts/fetch_pull_history.py C:\path\to\capture.txt
```

Use `-` as the capture path to read stdin. Run the command with `--help` for discovery limits and other collector options.

Fetching is incremental by default in both the script and viewer. Each type starts at the newest page and looks for overlap with a completed export in the same `data/exports` directory (or CLI `--output-dir`). The account, host, server, and channel must all match. The collector crosses two complete saved timestamp groups and compares whole records with occurrence counts and exact source sequence, so repeated identical pulls and groups split across pages are preserved. It also checks the rest of the overlap already fetched. Missing, incomplete, inconsistent, or unordered saved data cannot shorten a fetch; an uncertain match falls back to full pagination. Known saved types are checked even beyond a gap of empty types.

Each new export includes both new pulls and reused saved history, so it can be imported on its own. Original export folders remain untouched. When overlap is removed from a fetched page for the merged archive, that page is explicitly marked as transformed and the original response is retained under `responses/`. Copied cached pages retain their original bytes; the manifest names their baseline export. Keep export folders together to retain earlier response provenance. The archived cursors describe their original responses, not a single replayable pagination chain after merging.

Incremental fetching assumes the API adds new pulls at the front; it cannot detect a server change in an older page it does not request. To audit all currently accessible pages, force a full fetch:

```powershell
uv run python scripts/fetch_pull_history.py --full
```

## Understand the numbers

Each saved API record counts as one pull. Item quantity is shown separately. Repeated identical records can represent legitimate pulls; merging retains the largest occurrence count seen in any snapshot for that profile and source type. Importing the same history again does not increase totals.

History assumes collector arrays are stably ordered newest first, including records with the same timestamp. Converted Exilium browser snapshots are reversed from their oldest-first storage order without changing their saved source documents. SQLite stores `timestamp_order` within each profile, source type, and timestamp (zero is newest). Upgrades recover that order from retained snapshots; later imports insert unseen occurrences around shared records while preserving existing relative order, so a partial snapshot cannot reset a full group's order. A new group covering every saved occurrence supplies its full order, including added identical pulls; partial groups retain established anchors. Identical occurrences remain indistinguishable. This is an assumed source sequence, not an independently verified game draw ID.

Search and filters apply to both the overview and the full history, independent of the visible page. Dates and date filters use UTC. Multi-pull groups are estimates based on matching source type, pool, and timestamp. They are not verified ten-pulls.

"Collection complete" means the collector finished its configured scan of accessible history. It does not establish lifetime coverage or prove that every possible API type exists within that scan. Unknown items and pools remain visible by ID. Rarity statistics include known dolls and weapons; unknown rewards are counted separately. Pity counts are available in the history API and Field mock; guarantees are not implemented. Counts use the stable source-order assumption and are separate for each API type, not verified shared banner families. `pity_uncertain` marks intervals crossing a gap or an unknown-rarity reward. Saved source adjacency establishes continuous history; a later bridging import can clear a gap. Each known Elite resets the count and uncertainty for subsequent pulls. Counts before the first Elite are uncertain unless the oldest record falls on the publisher’s UTC launch date (Darkwinter: 2024-12-03; Haoplay: 2024-12-05). The mock displays uncertainty as a superscript question mark and excludes uncertain intervals from average pity. Exilium aggregate imports are assumed continuous internally; gaps already lost before export cannot be recovered.

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

Launch-date references: [Sunborn launch announcement](https://www.biggamesmachine.com/client-news/girls-frontline-2-global/) and [Haoplay release announcement](https://gamebiz.jp/news/397022).
