import { PostHog, type PostHogOptions } from 'posthog-node';
import { telemetryEnvironment } from './deployment.ts';
import { safeServerError, sanitizeServerEvent, type ServerOperation } from './server-policy.ts';

type Client = Pick<PostHog, 'captureException' | 'on' | 'shutdown'>;

export function createServerTelemetry(
  environment: Record<string, string | undefined>,
  makeClient: (key: string, options: PostHogOptions) => Client = (key, options) =>
    new PostHog(key, options),
  onShutdown: (callback: () => void) => void = (callback) => {
    process.once('sveltekit:shutdown', callback);
  }
) {
  let client: Client | undefined;
  let configured = false;
  const reported = new WeakSet<object>();
  function getClient() {
    if (configured) return client;
    configured = true;
    const key = environment.PUBLIC_POSTHOG_KEY;
    if (environment.GFL2_MODE !== 'public' || !key || environment.NODE_ENV === 'test') return;
    if (environment.PUBLIC_POSTHOG_HOST !== 'https://us.i.posthog.com') return;
    client = makeClient(key, {
      host: 'https://us.i.posthog.com',
      flushAt: 10,
      flushInterval: 5000,
      maxQueueSize: 20,
      requestTimeout: 1000,
      fetchRetryCount: 0,
      enableExceptionAutocapture: false,
      disableGeoip: true,
      before_send: (event) =>
        sanitizeServerEvent(
          event,
          environment.PUBLIC_APP_RELEASE ?? '',
          telemetryEnvironment(
            environment.GFL2_TELEMETRY_ENVIRONMENT,
            environment.NODE_ENV === 'development'
          )
        )
    });
    client.on('error', () => {});
    // adapter-node emits this after draining HTTP requests on SIGTERM/SIGINT.
    // The bounded SDK shutdown flushes queued exceptions and removes its timers.
    onShutdown(() => {
      void client?.shutdown(1500).catch(() => {});
    });
    return client;
  }
  return {
    report(error: unknown, operation: ServerOperation, allowed: boolean) {
      if (!allowed) return;
      try {
        const target = getClient();
        if (!target) return;
        if (error !== null && typeof error === 'object') {
          if (reported.has(error)) return;
          reported.add(error);
        }
        // Only the fresh sanitized Error enters the SDK. Its parser attaches
        // chunk IDs before before_send removes source context and other metadata.
        target.captureException(safeServerError(error), 'gfl2-web-service', { operation });
      } catch {
        /* Telemetry must never alter an application response. */
      }
    }
  };
}

const telemetry = createServerTelemetry(process.env);
export const reportServerError = telemetry.report;
