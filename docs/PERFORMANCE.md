# Performance reference

Recorded September 21, 2026 using optimized production builds on Windows,
AMD Ryzen 5 5600 (12 logical processors), Chrome 153, at 1024 × 576.
Fixtures use synthetic records, three profiles, and overlapping imports.

## Rendered application

The production routing fixture imports through the actual file controls and
measures pagination, search, recruitment changes, profile switches, and route
navigation while a synthetic Drive metadata request is pending. Each action is
repeated three times. Times end at DOM readiness and two animation frames: they
estimate a paint opportunity, not field INP or hardware presentation time.

| Primary records | Maximum warm action excluding search | Search range, including 100 ms debounce | Initial / overlapping import |
| ---: | ---: | ---: | ---: |
| 1,000 | 67.5 ms | 127.2–133.0 ms | 117.5 / 89.3 ms |
| 10,000 | 82.0 ms | 127.4–148.1 ms | 401.5 / 467.1 ms |
| 30,000 | 66.8 ms | 131.7–133.3 ms | 1167.7 / 1292.5 ms |

All warm interactions met the 200 ms reference target. No browsing long tasks
were recorded. Initial navigation to the empty history paint opportunity took
163 ms. Large imports and cold archive preparation remain longer operations.
Pending synthetic network work does not measure full sync CPU contention or
authenticated Google latency.

## Archive worker

The separately optimized worker fixture includes IndexedDB and worker round trips,
without application rendering. Cold means a fresh worker reading the seeded archive.

| Primary records | Cold history | Warm query range | Largest query response, JSON characters |
| ---: | ---: | ---: | ---: |
| 1,000 | 35.6 ms | 0.3–0.7 ms | 14,478 |
| 10,000 | 215.4 ms | 0.4–2.3 ms | 14,580 |
| 30,000 | 684.3 ms | 0.6–5.1 ms | 14,681 |

Each size retained exactly one archive read, one engine build, and three profile
row builds throughout warm browsing. These are asserted invariants. Response
sizes estimate JSON characters, not structured-clone bytes. No browsing long
tasks were recorded.

Reconstructing the current engine four times for the former history/statistics/
filters/overview query pattern took 82.3, 661.1, and 2212.7 ms respectively. This
is a controlled architecture comparison, not a historical deployment benchmark.

The main route JavaScript chunk decreased from 164,213 bytes at `690dfae` to
67,827 bytes (59%). This compares uncompressed route chunks, not total downloaded
assets. Optional panels and sync are loaded separately; hashed assets retain
immutable caching while HTML and APIs remain uncached.

## Reproduce and validate

- Follow [production DOM performance](../web/tests/routing/README.md#production-dom-performance)
  for full application measurements and [worker performance](../web/tests/browser/README.md#performance)
  for archive counters and bounded payloads. Run timings without other active fixtures.
- Run `npm run check`, `npm test`, `npm run build`, and `npm run test:routes` in
  `web`, plus `uv run --frozen pytest` in the repository root.
- Run the optimized browser storage/sync and reward fixtures, and the production
  routing fixture. Keep authenticated Google evidence separate from simulated transport.

This pass validated 149 frontend tests, 145 Python tests, zero Svelte diagnostics,
public/local HTTP routing smoke checks, nine browser storage/sync groups, ten
reward groups, and seven production routing groups. Synthetic coverage includes
invalid cloud data, partial cleanup, missing ancestors, duplicate identities,
concurrent workers, conflicts, unchanged sync, and stalled optional configuration.
The existing Starlette TestClient deprecation warning remains in Python tests.

The prerelease reset and future migration requirements are documented in
[Drive sync](GOOGLE_DRIVE.md#prerelease-archive-reset) and the
[first public release checklist](PUBLICATION.md#first-public-release-checklist).
