import { mount } from 'svelte';
import ErrorReportNotice from '../../src/lib/components/ErrorReportNotice.svelte';
import '../../src/app.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import { createPublicClient } from '../../src/lib/public-api';
import {
  initTelemetry,
  capturePageview,
  trackOperation,
  reportBrowserError,
  setTelemetryEnabled,
  telemetryEnabled
} from '../../src/lib/telemetry/browser';

const config = {
  enabled: true,
  key: 'phc_synthetic_telemetry_fixture',
  host: 'https://us.i.posthog.com',
  release: 'synthetic-fixture'
};
initTelemetry(config);
mount(ErrorReportNotice, { target: document.body });
capturePageview(location.href);
Object.assign(window, {
  telemetryFixture: {
    capturePageview,
    trackOperation,
    reportBrowserError,
    setTelemetryEnabled,
    telemetryEnabled,
    async serviceFailure() {
      const client = createPublicClient(async () => new Response('{}', { status: 503 }));
      try {
        await client.config();
      } catch {
        /* Exercise a handled service failure. */
      }
    },
    navigate(path: string) {
      history.pushState({}, '', path);
      capturePageview(path);
    },
    disabledDeployment() {
      initTelemetry({ ...config, enabled: false });
    }
  }
});
