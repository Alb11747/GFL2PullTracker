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

## Reward loading follow-up

The production fixture was rerun against `731635c` on the same reference device,
adding separate query/reply timing and rarity-selection interactions. Across
1,000, 10,000, and 30,000 records, rarity queries took 4.7–7.5 ms and the next
paint-opportunity estimate was 33.2–33.9 ms. Recruitment queries took 9.3–15.4 ms
within 33.2–33.5 ms interactions. Each action was repeated three times per size.
Time after the reply includes UI updates and animation-frame scheduling, not
solely rendering CPU time.

The reward spinner tracked only the pending query and was removed before Svelte's
result update and paint. Its usual lifetime was shorter than one frame, making
the animation unhelpful despite passing an artificially held-query animation test.
It has been removed; pending queries retain `aria-busy`, stable layout space, and
the current recruitment statistics while rarity filters change.

## Stable loading and worker contention

The September 21 stable candidate was measured on the same device and 1024 × 576
CSS-pixel viewport, at browser zoom 125%. Each ordinary action ran three times
per selected profile. The complete archive contained 41,000 records across the
1k/10k/30k profiles, with overlapping imports retaining exact occurrence counts.

| Selected profile | Reward median / p95 | Maximum ordinary warm action | Rapid selection behind backup, before / after codec isolation |
| ---: | ---: | ---: | ---: |
| 1,000 | 33.2 / 33.4 ms | 63.0 ms | 669.3 / 166.7 ms |
| 10,000 | 33.3 / 33.5 ms | 66.7 ms | 700.3 / 100.1 ms |
| 30,000 | 33.3 / 33.4 ms | 62.9 ms | 684.6 / 112.6 ms |

Ordinary reward interactions remain approximately the 33 ms measured before this
pass; a long warm-query delay was not reproduced without contention. Their worker
round trips were 3.4–9.5 ms: reception delay 0–0.1 ms, FIFO wait 0–0.1 ms, execution
0.2–0.5 ms, and response delivery 3.1–9.1 ms. The following DOM update and two-frame
paint opportunity took 23.7–29.7 ms. These clocks estimate boundaries, not hardware
presentation or exact structured-clone CPU time.

The separate contention scenario starts a real full-archive export, then makes six
rapid rarity selections. Before isolation, synchronous validation, hashing and
compression setup blocked worker message reception for 598–631 ms, followed by
38–43 ms in its FIFO. The final preview took 669–700 ms even though its own query
executed in under 1 ms. The new codec worker preserves every validation check and
captures export state at its original FIFO position, but lets archive queries and
later mutations continue while that immutable snapshot is processed. The final
preview now takes 100–167 ms, including cold codec startup in the first case.
Four or five superseded previews were cancelled; required expansion pages and
mutation order are preserved. Backup completion still takes 672–717 ms.

Both ordinary and contended interactions met the unchanged 200 ms reference
target. A separate quiet repeat gave consistent results; measurements are small
fixture samples, not a production service-level guarantee. Warm archive-read,
engine-build and row-build counters did not increase. Three 55–106 ms main-thread
long tasks appeared during the first background-sync/codec scenario; later
scenarios had none. Full-state transfer in initial sync remains a possible source
of main-thread work and should not be confused with the now-isolated codec CPU.

Visible portraits are requested eagerly for the measured two-row preview; expanded
content remains lazy. All 16 visible images were already ready in warm samples,
with decode completion at 0.4–2.2 ms. Cache-busted local HTTP artwork completed
load/decode in 6.3–13.0 ms with no failures (before codec isolation: 6.8–7.6 ms).
Those local results do not establish production CDN latency. Historical artwork
readiness was not measured by the old fixture, so no older image-speedup claim is
made. The first preview now uses the measured grid width; a stable scrollbar gutter
prevents the first result from changing the column count and dispatching twice.

Loading regressions cover larger/smaller previous content, multiline messages,
overlap, error/empty settlement, resizing and label changes. All 14 optimized
reward/loading groups passed at 1024 and 390 CSS-pixel widths with browser zoom
125%; native Enter/Tab/Shift+Tab/Escape behavior retained modal focus and return.
The production route/import observer recorded 495 desktop/mobile observations
within the 1 CSS-pixel floor tolerance; the final codec build passed a further 231 and the final recovery regression run 251.
Nineteen optimized archive/restore groups cover offline conflict UI, revision
races, recovery, future formats, isolated prerelease databases, two workers,
coalescing and snapshot ordering. Three codec unit tests separately cover worker
failure and retry behavior. These are synthetic tests, separate from the
authenticated release gates.

## Archive worker

The separately optimized worker fixture includes IndexedDB and worker round trips,
without application rendering. Cold means a fresh worker reading the seeded archive.

| Primary records | Cold history | Warm query range | Largest query response, JSON characters |
| ---: | ---: | ---: | ---: |
| 1,000 | 27.7 ms | 0.3–0.7 ms | 14,478 |
| 10,000 | 189.9 ms | 0.3–1.5 ms | 14,580 |
| 30,000 | 433.8 ms | 0.4–3.2 ms | 14,681 |

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

This stable candidate validated 174 frontend tests, 156 Python tests plus four
subtests, zero Svelte diagnostics, public/local HTTP routing smoke checks,
19 browser storage/sync groups, 14 reward/loading groups, and the production
routing/import regression fixture. Synthetic coverage includes
invalid cloud data, partial cleanup, missing ancestors, duplicate identities,
concurrent workers, conflicts, unchanged sync, and stalled optional configuration.
The existing Starlette TestClient deprecation warning remains in Python tests.

The stable baseline and future migration requirements are documented in
[Drive sync](GOOGLE_DRIVE.md#stable-archive-version-1) and the
[first public release checklist](PUBLICATION.md#first-public-release-checklist).
