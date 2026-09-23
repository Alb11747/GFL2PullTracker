import type { PostHog, PostHogConfig } from 'posthog-js';
import { createLocalDiagnostics, type LocalDiagnosticsState } from './local-diagnostics.ts';
import type { CaptureResult } from 'posthog-js';
import {
  OPERATIONS,
  OUTCOMES,
  safePageUrl,
  safePath,
  sanitizeCapture,
  sanitizeError,
  type TelemetryOperation,
  type TelemetryOutcome
} from './privacy.ts';

export type TelemetryConfig = {
  enabled: boolean;
  key: string;
  host: string;
  release: string;
  environment?: string;
};
export const TELEMETRY_STORAGE_KEY = 'gfl2.telemetry.enabled';
type Client = Pick<
  PostHog,
  | 'init'
  | 'capture'
  | 'captureException'
  | 'opt_in_capturing'
  | 'opt_out_capturing'
  | 'startSessionRecording'
  | 'stopSessionRecording'
  | 'shutdown'
>;
type Environment = {
  origin: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  readCookie(): string;
  writeCookie(value: string): void;
  listenStorage(callback: (key: string | null, value: string | null) => void): void;
  listenErrors(callback: (error: unknown) => void): void;
  privacySignal?(): boolean;
  broadcastPreference?(enabled: boolean): void;
  sendReport?(payload: CaptureResult): Promise<void>;
};

/** A manual report has no SDK, ambient credentials, retries, or recording side effects. */
export async function sendDiagnosticReport(payload: CaptureResult, fetcher: typeof fetch = fetch) {
  const response = await fetcher('https://us.i.posthog.com/i/v0/e/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      api_key: payload.properties.token,
      distinct_id: payload.properties.distinct_id
    }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('Report submission could not be confirmed.');
  const result = await response.json();
  if (result?.status !== 1) throw new Error('Report submission could not be confirmed.');
}

/** Isolated controller allows lifecycle/privacy tests without starting a real SDK. */
export function createTelemetry(environment: Environment, loadSdk: () => Promise<Client>) {
  let config: TelemetryConfig = { enabled: false, key: '', host: '', release: '' };
  let permitted = true;
  let client: Client | undefined;
  let loading: Promise<void> | undefined;
  let consentEpoch = 0;
  let transport: AbortController | undefined;
  let listening = false;
  let lastPath: string | undefined;
  let pending: Array<() => void> = [];
  const listeners = new Set<(enabled: boolean) => void>();
  const seenErrors = new WeakSet<object>();
  const diagnostics = createLocalDiagnostics({
    origin: environment.origin,
    storage: environment.storage,
    send: environment.sendReport ?? sendDiagnosticReport
  });
  const eligible = () =>
    config.enabled &&
    !!config.key &&
    config.host === 'https://us.i.posthog.com' &&
    !environment.privacySignal?.();
  const cookieOptedOut = () => {
    try {
      return environment
        .readCookie()
        .split(';')
        .some((part) => part.trim() === 'gfl2_telemetry=0');
    } catch {
      return false;
    }
  };
  // Check the shared cookie at the transmission boundary, including queued replay flushes.
  const enabled = () => eligible() && permitted && !cookieOptedOut();
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      /* Analytics must never interrupt the tracker. */
    }
  };
  const refreshDiagnostics = () =>
    diagnostics.configure({
      available: eligible() && !enabled(),
      key: config.key,
      release: config.release,
      environment: config.environment
    });
  const notify = () => {
    refreshDiagnostics();
    listeners.forEach((listener) => safely(() => listener(enabled())));
  };
  const cookie = () =>
    safely(() =>
      environment.writeCookie(
        `gfl2_telemetry=${eligible() && permitted ? '1' : '0'}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
      )
    );
  const readPreference = () => {
    if (cookieOptedOut()) return false;
    try {
      const saved = environment.storage.getItem(TELEMETRY_STORAGE_KEY);
      if (saved === '0' || saved === '1') return saved === '1';
    } catch {
      /* Cookie fallback survives restricted storage. */
    }
    return true;
  };
  const stop = () => {
    pending = [];
    lastPath = undefined;
    consentEpoch++;
    loading = undefined;
    transport?.abort();
    const retired = client;
    client = undefined;
    // Opt out first: stopping a recorder can flush buffered events.
    safely(() => retired?.opt_out_capturing());
    safely(() => retired?.stopSessionRecording());
    // Shutdown flushes SDK queues. Their permanently aborted transport discards these sends.
    safely(() => {
      void retired?.shutdown().catch(() => {});
    });
  };
  const sdkConfig = (epochTransport: AbortController): Partial<PostHogConfig> => {
    // posthog-js 1.434.2 passes fetch_options through to native RequestInit, while its
    // public type lists only caching fields. This narrow extension is wire-tested.
    // Keep a distinct SDK instance per consent epoch: SDK retries otherwise read a
    // replacement config and could resurrect an old event after a later opt-in.
    const fetchOptions: NonNullable<PostHogConfig['fetch_options']> & Pick<RequestInit, 'signal'> =
      {
        get signal() {
          if (!enabled()) epochTransport.abort();
          return epochTransport.signal;
        }
      };
    return {
      api_host: config.host,
      ui_host: 'https://us.posthog.com',
      defaults: '2026-05-30',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      person_profiles: 'never',
      ip: false,
      save_referrer: false,
      save_campaign_params: false,
      disable_capture_url_hashes: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      advanced_disable_toolbar_metrics: true,
      opt_in_site_apps: false,
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false, beforeSend: () => null },
      metrics: { network: false, beforeSend: () => null },
      persistence: 'localStorage',
      persistence_name: 'gfl2_posthog',
      cross_subdomain_cookie: false,
      opt_out_capturing_by_default: true,
      request_batching: false,
      api_transport: 'fetch',
      disable_beacon: true,
      fetch_options: fetchOptions,
      get_current_url: (url) => safePageUrl(url, environment.origin),
      session_recording: {
        sampleRate: 1,
        maskAllInputs: true,
        maskTextSelector: '*',
        maskAllElementAttributes: true,
        blockClass: 'ph-no-capture',
        blockSelector:
          'input[type="hidden"], input[type="file"], canvas, iframe, img, video, audio, object, embed',
        recordHeaders: false,
        recordBody: false,
        recordCrossOriginIframes: false,
        captureJsonLd: false,
        collectFonts: false,
        inlineStylesheet: false,
        captureCanvas: { recordCanvas: false },
        compress_events: false,
        slimDOMOptions: 'all',
        maskCapturedNetworkRequestFn: (request) =>
          request.isInitial || Object.keys(request).every((key) => key === 'name')
            ? {
                name: safePageUrl(request.name, environment.origin),
                duration: 0,
                startTime: 0,
                entryType: 'navigation'
              }
            : null
      },
      before_send: (event) =>
        sanitizeCapture(event, {
          origin: environment.origin,
          release: config.release,
          environment: config.environment,
          key: config.key,
          enabled: enabled() && !epochTransport.signal.aborted
        })
    };
  };
  const start = () => {
    if (!enabled()) return;
    if (client) {
      safely(() => client?.opt_in_capturing({ captureEventName: false }));
      safely(() =>
        client?.startSessionRecording({
          sampling: true,
          linked_flag: true,
          url_trigger: true,
          event_trigger: true
        })
      );
      return;
    }
    if (loading) return;
    const epoch = consentEpoch;
    const task = loadSdk()
      .then((sdk) => {
        if (!enabled() || epoch !== consentEpoch) return;
        transport = new AbortController();
        sdk.init(config.key, sdkConfig(transport));
        client = sdk;
        start();
        for (const event of pending.splice(0)) if (enabled()) safely(event);
      })
      .catch(() => {
        if (epoch === consentEpoch) pending = [];
      })
      .finally(() => {
        if (loading === task) loading = undefined;
      });
    loading = task;
  };
  const send = (action: () => void) => {
    if (!enabled()) return;
    if (client) safely(action);
    else if (pending.length < 30) pending.push(action);
  };
  const reportError = (error: unknown, operation?: TelemetryOperation) => {
    refreshDiagnostics();
    if (!enabled()) {
      diagnostics.report(error, operation);
      return;
    }
    if (error && typeof error === 'object') {
      if (seenErrors.has(error)) return;
      seenErrors.add(error);
    }
    const clean = sanitizeError(error, environment.origin);
    if (!clean) return;
    send(() =>
      client?.captureException(
        clean,
        operation && OPERATIONS.includes(operation) ? { operation } : {}
      )
    );
  };
  return {
    init(next: TelemetryConfig) {
      config = next;
      if (!listening) {
        permitted = readPreference();
        listening = true;
        environment.listenStorage((key, value) => {
          diagnostics.storageChanged(key, value);
          if (key !== TELEMETRY_STORAGE_KEY && key !== null) return;
          permitted = value === '1'; // Clearing preferences must not silently opt an existing tab in.
          cookie();
          notify();
          if (enabled()) start();
          else stop();
        });
        environment.listenErrors((error) => reportError(error));
      }
      cookie();
      notify();
      if (enabled()) start();
      else stop();
    },
    setEnabled(value: boolean) {
      permitted = value;
      safely(() => environment.storage.setItem(TELEMETRY_STORAGE_KEY, value ? '1' : '0'));
      cookie();
      safely(() => environment.broadcastPreference?.(value));
      notify();
      if (enabled()) start();
      else stop();
    },
    enabled,
    diagnostics,
    subscribe(listener: (enabled: boolean) => void) {
      listeners.add(listener);
      listener(enabled());
      return () => {
        listeners.delete(listener);
      };
    },
    pageview(path: string) {
      refreshDiagnostics();
      if (!enabled()) {
        diagnostics.pageview(path);
        return;
      }
      const clean = safePath(path);
      if (clean === lastPath) return;
      lastPath = clean;
      send(() =>
        client?.capture('$pageview', {
          $pathname: clean,
          $current_url: safePageUrl(clean, environment.origin)
        })
      );
    },
    operation(operation: TelemetryOperation, outcome: TelemetryOutcome, durationMs: number) {
      if (!OPERATIONS.includes(operation) || !OUTCOMES.includes(outcome)) return;
      refreshDiagnostics();
      if (!enabled()) {
        diagnostics.operation(operation, outcome, durationMs);
        if (outcome === 'failed') diagnostics.report(new Error('Operation failed'), operation);
        return;
      }
      send(() =>
        client?.capture('tracker_operation', { operation, outcome, duration_ms: durationMs })
      );
    },
    reportError
  };
}

let singleton: ReturnType<typeof createTelemetry> | undefined;
function instance() {
  if (typeof window === 'undefined') return;
  if (singleton) return singleton;
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('gfl2.telemetry');
  } catch {
    /* Cookie polling remains available. */
  }
  return (singleton ??= createTelemetry(
    {
      origin: window.location.origin,
      privacySignal: () =>
        navigator.doNotTrack === '1' ||
        (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value)
      },
      readCookie: () => document.cookie,
      writeCookie: (value) => {
        document.cookie = value;
      },
      broadcastPreference: (enabled) => channel?.postMessage(enabled),
      listenStorage: (listener) => {
        window.addEventListener('storage', (event) => listener(event.key, event.newValue));
        if (channel)
          channel.onmessage = (event: MessageEvent<unknown>) => {
            if (typeof event.data === 'boolean')
              listener(TELEMETRY_STORAGE_KEY, event.data ? '1' : '0');
          };
        let last = document.cookie.match(/(?:^|;\s*)gfl2_telemetry=([01])(?:;|$)/)?.[1];
        const refresh = () => {
          const value = document.cookie.match(/(?:^|;\s*)gfl2_telemetry=([01])(?:;|$)/)?.[1];
          if (value === last) return;
          last = value;
          // Cookie sharing also works when storage and BroadcastChannel are unavailable.
          if (value) listener(TELEMETRY_STORAGE_KEY, value);
        };
        window.setInterval(refresh, 1000);
        document.addEventListener('visibilitychange', refresh);
      },
      listenErrors: (listener) => {
        window.addEventListener('error', (event) => {
          if (event.error) listener(event.error);
        });
        window.addEventListener('unhandledrejection', (event) => listener(event.reason));
      }
    },
    async () => new (await import('posthog-js')).PostHog()
  ));
}

export function initTelemetry(config: TelemetryConfig) {
  instance()?.init(config);
}
export function setTelemetryEnabled(enabled: boolean) {
  instance()?.setEnabled(enabled);
}
export function telemetryEnabled() {
  return instance()?.enabled() ?? false;
}
export function subscribeTelemetry(callback: (enabled: boolean) => void) {
  return instance()?.subscribe(callback) ?? (() => {});
}
export function capturePageview(path: string) {
  instance()?.pageview(path);
}
export function trackOperation(
  operation: TelemetryOperation,
  outcome: TelemetryOutcome,
  durationMs: number
) {
  instance()?.operation(operation, outcome, durationMs);
}
export function reportBrowserError(error: unknown, operation?: TelemetryOperation) {
  instance()?.reportError(error, operation);
}

/** Handled service failures are reported by the server when analytics are on. */
export function reportLocalServiceError() {
  const target = instance();
  if (target && !target.enabled()) target.reportError(new Error('Service request failed'));
}
export function subscribeDiagnostics(callback: (state: LocalDiagnosticsState) => void) {
  return instance()?.diagnostics.subscribe(callback) ?? (() => {});
}
export function sendPendingDiagnosticReport() {
  return instance()?.diagnostics.sendReport();
}
export function dismissDiagnosticReport(forever = false) {
  instance()?.diagnostics.dismiss(forever);
}
export function restoreDiagnosticPrompts() {
  instance()?.diagnostics.restorePrompts();
}
