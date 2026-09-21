# Actual PostHog SDK privacy regression

From `web`, run `node tests/telemetry/run.mjs` with an existing Playwright
installation. If Playwright is not resolvable in this project, set
`PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. Optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chrome/Chromium executable.
The fixture uses a fresh isolated browser context and a random loopback port.

This imports the production telemetry controller and installed `posthog-js` SDK.
It serves the installed recorder extension, intercepts all external traffic,
and decodes real compressed event batches and replay payloads. No events reach
PostHog. Remote configuration enables recording with no flags. The browser
uses a normal user agent and disables its automation marker in this isolated
context because PostHog intentionally drops bot/automated browser traffic.

Assertions require real rrweb full and incremental snapshots, test synthetic
secrets in text, inputs, attributes, blocked content, URL query/hash, and errors,
and verify navigation/error deduplication. A second tab checks opt-out
propagation, reload/navigation persistence, and no subsequent event/replay
ingestion. Blocked network and runtime disable checks cover non-throwing
telemetry calls; production import/restore usability belongs to the separate
application routing regression suite.
