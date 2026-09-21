# Drive sync browser regressions

From `web`, run `npm run test:browser`, open http://127.0.0.1:14194 in the in-app browser, and press **Run tests**. The page retains a PASS/FAIL trace, rendered conflict-dialog evidence, and synthetic transport counters. A failing test includes its stack trace.

The harness refuses other origins and deletes only its isolated origin's synthetic archive. It imports the production settings component, controller, local workers, merge worker, and backup encoder. Only Drive transport and authorization are replaced. Its Content Security Policy blocks external network access. This is browser runtime coverage, not authenticated Google Drive coverage.

The suite verifies the intentional IndexedDB 1/2-to-3 prerelease reset (including malformed archives), rejection of obsolete database writers, retained unrelated display preferences, device exclusion aliases, two-worker mutation and stale replacement protection, successive conflict-dialog choices, preference choices, and metadata-only unchanged syncs. Add `?autorun=1` to start immediately. No test dependencies or browser downloads are required.

## Performance

For optimized browser fixtures, run `npx vite build --config tests/browser/vite.config.ts` followed by `npx vite preview --config tests/browser/vite.config.ts`. Build artifacts stay under `node_modules`. Open <http://127.0.0.1:14194/performance.html?autorun=1> with other fixture tabs closed. The ordinary development server also serves this page, but use the optimized build for reported timings.

The fixture imports synthetic 1,000-, 10,000-, and 30,000-record primary accounts, two smaller accounts, and overlapping snapshots. It verifies exact occurrence counts and bounded pages, reports import/cold/warm pagination/search/recruitment/profile timings, observes long tasks, and asserts unchanged archive-read/engine-build counters during warm browsing. Result size is reported as JSON characters, not exact structured-clone bytes. Results remain visible and available in `window.performanceResults`.

The controlled baseline reconstructs the current engine separately for history, statistics, filters and overview to simulate the previous query pattern. It is not an old-deployment measurement. These timings cover worker/IndexedDB round trips rather than complete DOM rendering; the production routing fixture separately exercises application navigation and stalled configuration. A timing target miss is recorded as `warmTargetMet: false`; structural invariants still fail the suite independently. Live Drive authorization and cloud latency require separate evidence.

## Reward history

Open http://127.0.0.1:14194/rewards.html and press **Run tests** for production reward-history component coverage using synthetic records, local artwork, production styles and fonts. The suite verifies all rarity combinations, selection persistence/corruption, two-row pagination, unchanged statistics, recorded ordering, detail facts/focus return, unavailable and failed artwork, and stale selections across profile/recruitment/data changes. It modifies only the reward-display preference on this isolated origin and retains an interactive fixture after completion.

For native keyboard behavior, focus a reward and use Enter/Space, Tab/Shift+Tab, and Escape; verify focus stays inside the dialog while open and returns to its trigger afterward. Check the retained fixture at desktop and narrow mobile widths. These require trusted browser input: dispatched keyboard events do not trigger native dialog defaults.
