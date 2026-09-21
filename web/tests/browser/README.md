# Drive sync browser regressions

From `web`, run `npm run test:browser`, open http://127.0.0.1:14194 in the in-app browser, and press **Run tests**. The page retains a PASS/FAIL trace, rendered conflict-dialog evidence, and synthetic transport counters. A failing test includes its stack trace.

The harness refuses other origins and deletes only its isolated origin's synthetic archive. It imports the production settings component, controller, local workers, merge worker, and backup encoder. Only Drive transport and authorization are replaced. Its Content Security Policy blocks external network access. This is browser runtime coverage, not authenticated Google Drive coverage.

The suite verifies legacy IndexedDB migration and recovery/exclusions, failed migration atomicity, two-worker mutation and stale replacement protection, successive conflict-dialog choices, preference choices, and repeated converged syncs. No test dependencies or browser downloads are required.

## Reward history

Open http://127.0.0.1:14194/rewards.html and press **Run tests** for production reward-history component coverage using synthetic records, local artwork, production styles and fonts. The suite verifies all rarity combinations, selection persistence/corruption, two-row pagination, unchanged statistics, recorded ordering, detail facts/focus return, unavailable and failed artwork, and stale selections across profile/recruitment/data changes. It modifies only the reward-display preference on this isolated origin and retains an interactive fixture after completion.

For native keyboard behavior, focus a reward and use Enter/Space, Tab/Shift+Tab, and Escape; verify focus stays inside the dialog while open and returns to its trigger afterward. Check the retained fixture at desktop and narrow mobile widths. These require trusted browser input: dispatched keyboard events do not trigger native dialog defaults.
