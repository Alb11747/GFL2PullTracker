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

The visible results cover ordinary navigation links, titles/current-page state,
Back/Forward, selected-profile/filter retention, a deferred settings operation,
Drive authorization retention, a deferred capture/import, profile operation
locks, history focus, and a production backup file handed across routes and
restored. The smoke command checks actual built public/local HTTP routes,
redirects, unknown slugs, and runtime privacy-policy disclosures.

Also inspect desktop/mobile appearance and keyboard navigation manually. Open a
navigation link in a new tab and refresh each panel to verify browser entry and
hydration. The scripted suite does not automate browser tabs or viewport sizing,
and synthetic Google transport does not prove live OAuth approval or Drive access.
