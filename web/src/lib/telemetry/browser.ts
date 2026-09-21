import type { PostHog, PostHogConfig } from 'posthog-js';
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

export type TelemetryConfig = { enabled: boolean; key: string; host: string; release: string };
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
};

/** Isolated controller allows lifecycle/privacy tests without starting a real SDK. */
export function createTelemetry(environment: Environment, loadSdk: () => Promise<Client>) {
  let config: TelemetryConfig = { enabled: false, key: '', host: '', release: '' };
  let permitted = true;
  let client: Client | undefined;
  let loading: Promise<void> | undefined;
  let listening = false;
  let lastPath: string | undefined;
  let pending: Array<() => void> = [];
  const listeners = new Set<(enabled: boolean) => void>();
  const seenErrors = new WeakSet<object>();
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
  const notify = () => listeners.forEach((listener) => safely(() => listener(enabled())));
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
    // Opt out first: stopping a recorder can flush buffered events.
    safely(() => client?.opt_out_capturing());
    safely(() => client?.stopSessionRecording());
  };
  const sdkConfig = (): Partial<PostHogConfig> => ({
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
        request.isInitial
          ? { ...request, name: safePageUrl(request.name, environment.origin) }
          : null
    },
    before_send: (event) =>
      sanitizeCapture(event, {
        origin: environment.origin,
        release: config.release,
        key: config.key,
        enabled: enabled()
      })
  });
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
    loading = loadSdk()
      .then((sdk) => {
        if (!enabled()) return;
        sdk.init(config.key, sdkConfig());
        client = sdk;
        start();
        for (const event of pending.splice(0)) if (enabled()) safely(event);
      })
      .catch(() => {
        pending = [];
      })
      .finally(() => {
        loading = undefined;
      });
  };
  const send = (action: () => void) => {
    if (!enabled()) return;
    if (client) safely(action);
    else if (pending.length < 30) pending.push(action);
  };
  const reportError = (error: unknown, operation?: TelemetryOperation) => {
    if (!enabled()) return;
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
    subscribe(listener: (enabled: boolean) => void) {
      listeners.add(listener);
      listener(enabled());
      return () => {
        listeners.delete(listener);
      };
    },
    pageview(path: string) {
      if (!enabled()) return;
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
    async () => (await import('posthog-js')).default
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
