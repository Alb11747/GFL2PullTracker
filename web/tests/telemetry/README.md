# Actual PostHog SDK privacy regression

From `web`, run `node tests/telemetry/run.mjs` with an existing Playwright
installation. If Playwright is not resolvable in this project, set
`PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. Optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chrome/Chromium executable.
Set `RRWEB_REPLAYER` to an existing rrweb installation's `dist/rrweb.umd.cjs`
(verified with rrweb 2.1.6); the fixture also resolves that file from local
`node_modules` if available. This is required to verify actual visible playback,
and is never silently skipped. Install this optional validation tool outside the
repository when it is not already available.
The fixture uses a fresh isolated browser context and a random loopback port.

This imports the production telemetry controller and installed `posthog-js` SDK.
It serves the installed recorder extension, intercepts all external traffic,
and decodes real compressed event batches and replay payloads. No events reach
PostHog. Remote configuration enables recording with no flags. The browser
uses a normal user agent and disables its automation marker in this isolated
context because PostHog intentionally drops bot/automated browser traffic.

Assertions require real rrweb full and incremental snapshots, test synthetic
secrets in text, inputs, attributes, blocked content, URL query/hash, and errors,
and verify navigation/error deduplication. It reconstructs the transmitted
snapshots with the real rrweb replayer and requires visible iframe dimensions and
masked document nodes. A second tab checks opt-out
propagation, reload/navigation persistence, and no subsequent event/replay
ingestion, including pending event batches and retries from rejected ingestion.
Blocked network and runtime disable checks cover non-throwing
telemetry calls; production import/restore usability belongs to the separate
application routing regression suite.

The mounted error-report toast also verifies the analytics-off path: local errors
send nothing until explicit approval, then send exactly one sanitized report without
enabling analytics. Handled service failures, both dismissal choices, and persistent
prompt suppression are exercised. Set `GFL2_TELEMETRY_SCREENSHOTS` to a directory
outside the repository to capture the desktop and mobile toast for visual review.

The production About form is mounted with synthetic survey/question identifiers.
Feedback coverage checks automatic analytics/replay exclusion while typing, no
requests for drafts with analytics off, accessible keyboard order, validation,
draft retention when the panel is hidden for tab navigation, completed survey
mapping, optional email, fresh anonymous identity, unchanged analytics preferences,
and confirmed-success clearing. A held response verifies concurrent submit
prevention and that the toast cannot send a diagnostic claimed by the form. A
rejected response verifies the uncertain-delivery warning, retained draft, and no
automatic retry. The screenshot option also captures `about-desktop.png` and
`about-mobile.png`; mobile capture checks horizontal overflow. Full hosted routing
and archive/import lifecycle coverage belongs to the application routing suite.
