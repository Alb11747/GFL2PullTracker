import { mount } from 'svelte';
import ErrorReportNotice from '../../src/lib/components/ErrorReportNotice.svelte';
import AboutPanel from '../../src/lib/components/AboutPanel.svelte';
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
  telemetryEnabled,
  restoreDiagnosticPrompts,
  sendPendingDiagnosticReport
} from '../../src/lib/telemetry/browser';

const config = {
  enabled: true,
  key: 'phc_synthetic_telemetry_fixture',
  host: 'https://us.i.posthog.com',
  release: 'synthetic-fixture'
};
initTelemetry(config);
mount(ErrorReportNotice, { target: document.body });
const about = document.createElement('main');
about.style.cssText = 'display:none;max-width:960px;margin:0 auto;padding:24px';
document.body.append(about);
mount(AboutPanel, {
  target: about,
  props: {
    config: {
      ...config,
      environment: 'production',
      surveyId: '00000000-0000-4000-8000-000000000001',
      categoryId: '00000000-0000-4000-8000-000000000002',
      messageId: '00000000-0000-4000-8000-000000000003',
      emailId: '00000000-0000-4000-8000-000000000004'
    }
  }
});
capturePageview(location.href);
Object.assign(window, {
  telemetryFixture: {
    capturePageview,
    trackOperation,
    reportBrowserError,
    setTelemetryEnabled,
    telemetryEnabled,
    restoreDiagnosticPrompts,
    sendPendingDiagnosticReport,
    showAbout(visible = true) {
      about.style.display = visible ? 'block' : 'none';
      document.getElementById('privacy-fixture')!.hidden = visible;
    },
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
