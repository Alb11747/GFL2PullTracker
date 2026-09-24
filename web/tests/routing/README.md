# Actual application routing checks

From `web`, build the application, then run:

```powershell
npm run build
node tests/routing/serve.mjs --smoke
node tests/routing/serve.mjs
```

Open <http://127.0.0.1:14195/history> and click **Run tests**. The fixed loopback
origin is required. Close other tabs on this fixture origin before rerunning;
resetting a database with another tab open is deliberately blocked. Stop the
runner with Ctrl+C. No test dependency is required.
The runner transpiles the checked `suite.ts` with the project's existing
TypeScript installation when serving its browser script.

The runner launches the production Node build on a temporary loopback port and
proxies it through the isolated fixture origin. An external same-origin script
is injected before hydration without weakening the production CSP. The script
substitutes Google Identity, Drive HTTP responses, public config/statistics and
official capture responses. Real production SvelteKit routing, components,
archive workers, gzip encoding/decoding and IndexedDB are exercised. All fixture
credentials and game records are synthetic. Unknown external fetches fail closed.
The runner never uses the live API backend.

The visible results cover usable history while optional configuration is stalled,
absence of history/reward/summary/filter worker queries on unrelated routes,
ordinary navigation links, titles/current-page state,
Back/Forward, selected-profile/filter retention, a deferred settings operation,
Drive authorization retention, a deferred capture/import, profile operation
locks, history focus, and a production backup file handed across routes and
restored. The smoke command checks actual built public/local HTTP routes,
redirects, unknown slugs, and runtime privacy-policy disclosures.

Open <http://127.0.0.1:14195/about?archive-failure=1> for a separate direct-entry
check that forces archive worker initialization to fail and verifies About remains
visible. Reload that address to exercise refresh under the same failure.

Also inspect desktop/mobile appearance and keyboard navigation manually. Open a
navigation link in a new tab and refresh each panel to verify browser entry and
hydration. The scripted suite does not automate browser tabs or viewport sizing,
and synthetic Google transport does not prove live OAuth approval or Drive access.

## Production DOM performance

Open <http://127.0.0.1:14195/history?performance=1> or use **Run DOM performance**.
This separate run resets only the isolated fixture origin and leaves the ordinary
routing regression run unchanged. Keep this browser tab visible throughout the run;
animation-frame timing and background sync intentionally depend on visibility.

The suite creates 1,000-, 10,000-, and 30,000-record profiles using production file
inputs and **Validate and import**, then imports overlapping halves and verifies
that the occurrence counts remain exact. It connects the production Drive controller
to synthetic HTTP responses and holds a background metadata request while measuring
pagination, search, recruitment selection, profile switches, and route navigation.
All measured browsing goes through production controls and components.

Each action records event-to-render/next-paint-opportunity time, first worker-query
dispatch delay, query round-trip time, time after the reply, time after query dispatch,
DOM mutation count, and whether background
sync was pending. Completion uses actual worker replies, DOM readiness, and animation
frames; it does not include the ordinary regression suite's fixed polling delay.
Two frames approximate a paint opportunity, not an exact hardware presentation time.
Time after a reply includes UI updates and frame scheduling; it is not pure rendering CPU time.
Search reports include the intentional 100 ms debounce and are separated from the
other warm actions' maximum, p95, and 200 ms target. Long tasks and import times are
reported separately. Results remain visible and in `window.routingPerformanceResults`.
Synthetic sync overlap is evidence of usable browsing during an outstanding cloud
request; it does not measure authenticated Drive latency or full sync CPU contention.

The loading regression observer checks the previous-size/message floor to within
1 CSS pixel throughout route, ledger, summary, community, import and sync work.
The import fixture injects a held/failing durable write and verifies retained
sanitized downloads, retry without another capture, and cancellation ownership.

Reward diagnostics additionally report worker reception/dispatch delay, FIFO wait,
execution, response transfer, and post-response DOM/paint opportunity separately.
A real full-archive backup export runs ahead of rapid selection changes, separately
from stalled network responses. Cache-busted bundled portrait load/decode timings
are local HTTP evidence, not a measurement of production CDN latency.
