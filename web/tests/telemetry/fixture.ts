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
capturePageview(location.href);
Object.assign(window, {
  telemetryFixture: {
    capturePageview,
    trackOperation,
    reportBrowserError,
    setTelemetryEnabled,
    telemetryEnabled,
    navigate(path: string) {
      history.pushState({}, '', path);
      capturePageview(path);
    },
    disabledDeployment() {
      initTelemetry({ ...config, enabled: false });
    }
  }
});
