# Drive sync browser regressions

From `web`, run `npm run test:browser`, open http://127.0.0.1:14194 in the in-app browser, and press **Run tests**. The page retains a PASS/FAIL trace, rendered conflict-dialog evidence, and synthetic transport counters. A failing test includes its stack trace.

The harness refuses other origins and deletes only its isolated origin's synthetic archive. It imports the production settings component, controller, local workers, merge worker, and backup encoder. Only Drive transport and authorization are replaced. Its Content Security Policy blocks external network access. This is browser runtime coverage, not authenticated Google Drive coverage.

The suite verifies legacy IndexedDB migration and recovery/exclusions, failed migration atomicity, two-worker mutation and stale replacement protection, successive conflict-dialog choices, preference choices, and repeated converged syncs. No test dependencies or browser downloads are required.
