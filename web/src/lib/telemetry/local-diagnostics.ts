import type { CaptureResult } from 'posthog-js';
import {
  OPERATIONS,
  OUTCOMES,
  safePath,
  sanitizeCapture,
  sanitizeError,
  type TelemetryOperation,
  type TelemetryOutcome
} from './privacy.ts';

export const LOCAL_DIAGNOSTICS_MUTED_KEY = 'gfl2.diagnostics.muted';
export type LocalDiagnosticsState = {
  muted: boolean;
  pending: boolean;
  sending: boolean;
  status: 'idle' | 'sent' | 'uncertain';
};
type Configuration = {
  available: boolean;
  key: string;
  release: string;
  environment?: string;
};
type Environment = {
  origin: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  send(payload: CaptureResult): Promise<void>;
  now?(): number;
};
type Breadcrumb =
  | { type: 'pageview'; path: string }
  | {
      type: 'operation';
      operation: TelemetryOperation;
      outcome: TelemetryOutcome;
      duration_ms: number;
    };

/** In-memory diagnostics only. The injected sender is called exclusively by sendReport. */
export function createLocalDiagnostics(environment: Environment) {
  let config: Configuration = { available: false, key: '', release: '' };
  let muted = false;
  try {
    muted = environment.storage.getItem(LOCAL_DIAGNOSTICS_MUTED_KEY) === '1';
  } catch {
    // A session choice still works when persistent storage is unavailable.
  }
  let pending: CaptureResult | undefined;
  let sending = false;
  let status: LocalDiagnosticsState['status'] = 'idle';
  let generation = 0;
  let activity: Breadcrumb[] = [];
  const fingerprints = new Map<string, number>();
  const now = environment.now ?? Date.now;
  const listeners = new Set<(state: LocalDiagnosticsState) => void>();
  const state = (): LocalDiagnosticsState => ({ muted, pending: !!pending, sending, status });
  const available = () => config.available && !!config.key && !muted;
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state());
      } catch {
        // Optional diagnostics must never interfere with the tracker.
      }
    }
  };
  const clear = () => {
    generation++;
    pending = undefined;
    activity = [];
    sending = false;
    status = 'idle';
    notify();
  };
  const record = (item: Breadcrumb) => {
    if (!available()) return;
    activity.push(item);
    if (activity.length > 20) activity.shift();
  };
  const saveMuted = (value: boolean) => {
    muted = value;
    try {
      environment.storage.setItem(LOCAL_DIAGNOSTICS_MUTED_KEY, value ? '1' : '0');
    } catch {
      // Preserve the current session's choice even if saving it fails.
    }
    clear();
  };
  return {
    get state() {
      return state();
    },
    configure(next: Configuration) {
      config = { ...next };
      if (!available()) clear();
    },
    pageview(path: string) {
      const clean = safePath(path);
      const last = activity.at(-1);
      if (last?.type === 'pageview' && last.path === clean) return;
      record({ type: 'pageview', path: clean });
    },
    operation(operation: TelemetryOperation, outcome: TelemetryOutcome, durationMs: number) {
      if (!OPERATIONS.includes(operation) || !OUTCOMES.includes(outcome)) return;
      record({
        type: 'operation',
        operation,
        outcome,
        duration_ms: Number.isFinite(durationMs)
          ? Math.min(86_400_000, Math.max(0, Math.round(durationMs)))
          : 0
      });
    },
    report(error: unknown, operation?: TelemetryOperation) {
      if (!available() || pending || sending) return;
      try {
        const clean = sanitizeError(error, environment.origin);
        if (!clean) return;
        const cleanOperation = operation && OPERATIONS.includes(operation) ? operation : undefined;
        const fingerprint = `${clean.stack}:${cleanOperation ?? ''}`;
        const timestamp = now();
        const previous = fingerprints.get(fingerprint);
        if (previous !== undefined && timestamp - previous < 60_000) return;
        // A short cooldown stops error storms without making "this time" a session mute.
        // Refresh insertion order so the bounded map evicts the oldest accepted failure.
        fingerprints.delete(fingerprint);
        fingerprints.set(fingerprint, timestamp);
        if (fingerprints.size > 20) fingerprints.delete(fingerprints.keys().next().value!);
        const frames = (clean.stack ?? '')
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            const match = line.match(/at (https?:\/\/[^\s]+):(\d+):(\d+)$/);
            return match
              ? [{ filename: match[1], lineno: Number(match[2]), colno: Number(match[3]) }]
              : [];
          });
        // Each report has its own identity; no analytics identity is read or persisted.
        const id = crypto.randomUUID();
        const capture = sanitizeCapture(
          {
            uuid: id,
            event: '$exception',
            properties: {
              distinct_id: id,
              $pathname: [...activity].reverse().find((item) => item.type === 'pageview')?.path,
              operation: cleanOperation,
              $exception_list: [{ type: clean.name, stacktrace: { frames } }]
            }
          },
          { ...config, origin: environment.origin, enabled: true }
        );
        if (!capture) return;
        // This is the complete approved snapshot; later activity cannot change it.
        pending = {
          ...capture,
          properties: {
            ...capture.properties,
            $is_identified: false,
            report_mode: 'user_submitted',
            recent_activity: activity.map((item) => ({ ...item }))
          }
        };
        status = 'idle';
        notify();
      } catch {
        // Thrown values can contain hostile getters; do not let diagnostics throw again.
      }
    },
    subscribe(listener: (state: LocalDiagnosticsState) => void) {
      listeners.add(listener);
      listener(state());
      return () => {
        listeners.delete(listener);
      };
    },
    dismiss(forever = false) {
      if (forever) saveMuted(true);
      else clear();
    },
    restorePrompts() {
      fingerprints.clear();
      saveMuted(false);
    },
    takeForFeedback() {
      if (!available() || !pending || sending) return;
      const payload = pending;
      clear();
      return payload;
    },
    async sendReport() {
      if (!available() || !pending || sending) return;
      const payload = pending;
      const epoch = generation;
      // Consume before awaiting: a second click or an uncertain response cannot resend it.
      pending = undefined;
      sending = true;
      notify();
      let result: LocalDiagnosticsState['status'] = 'sent';
      try {
        await environment.send(payload);
      } catch {
        result = 'uncertain';
      }
      if (epoch !== generation) return;
      sending = false;
      activity = [];
      status = result;
      notify();
    },
    storageChanged(key: string | null, value: string | null) {
      if (key !== LOCAL_DIAGNOSTICS_MUTED_KEY && key !== null) return;
      // Clearing storage must not silently restore an existing session's prompts.
      if (value === '1') muted = true;
      else if (value === '0') muted = false;
      clear();
    },
    clear
  };
}
