import type { CaptureResult } from 'posthog-js';
import { telemetryEnvironment } from './deployment.ts';

export const OPERATIONS = ['import', 'backup', 'restore', 'drive_sync'] as const;
export const OUTCOMES = ['success', 'failed', 'cancelled', 'partial'] as const;
export type TelemetryOperation = (typeof OPERATIONS)[number];
export type TelemetryOutcome = (typeof OUTCOMES)[number];

const routes = new Set([
  '/',
  '/history',
  '/backup',
  '/profiles',
  '/statistics',
  '/privacy',
  '/about',
  '/privacy-policy',
  '/guides/exilium'
]);
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'DOMException'
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Route labels, never arbitrary paths (which can themselves contain identifiers). */
export function safePath(value: unknown): string {
  try {
    const path =
      new URL(String(value), 'https://tracker.invalid').pathname.replace(/\/$/, '') || '/';
    return routes.has(path) ? path : '/unknown';
  } catch {
    return '/unknown';
  }
}

export function safePageUrl(value: unknown, origin: string): string {
  return origin + safePath(value);
}

function safeFrameUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      !/^\/_app\/(?:[a-f0-9]{40}\/)?immutable\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)
    )
      return;
    return url.origin + url.pathname;
  } catch {
    return;
  }
}

/** Create a fresh Error: neither cause nor arbitrary properties reach the SDK. */
export function sanitizeError(error: unknown, origin: string): Error | null {
  const source = record(error);
  // HTTP failures are owned by the proxy/backend. Validation and cancellation are expected.
  if (
    [
      'AbortError',
      'PublicApiError',
      'CaptureError',
      'InvalidBackupError',
      'InvalidArchiveError',
      'UnsupportedArchiveVersionError'
    ].includes(String(source.name))
  )
    return null;
  const type =
    typeof source.name === 'string' && errorTypes.has(source.name) ? source.name : 'Error';
  const clean = new Error('Application error');
  clean.name = type;
  const frames: string[] = [];
  if (typeof source.stack === 'string') {
    for (const line of source.stack.split('\n').slice(1, 51)) {
      // Retain only deployed script locations. Function names and error text can be data-dependent.
      const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
      const filename = match && safeFrameUrl(match[1], origin);
      if (match && filename) frames.push(`    at ${filename}:${match[2]}:${match[3]}`);
    }
  }
  clean.stack = `${type}: Application error${frames.length ? '\n' + frames.join('\n') : ''}`;
  return clean;
}

function sanitizeExceptions(value: unknown, origin: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1).map((item) => {
    const exception = record(item);
    const stacktrace = record(exception.stacktrace);
    const frames = (Array.isArray(stacktrace.frames) ? stacktrace.frames : [])
      .flatMap((item) => {
        const frame = record(item);
        const filename = safeFrameUrl(frame.filename, origin);
        if (!filename) return [];
        return [
          {
            platform: 'web:javascript',
            filename,
            function: '?',
            in_app: true,
            ...(Number.isSafeInteger(frame.lineno) &&
            Number(frame.lineno) > 0 &&
            Number(frame.lineno) <= 4_294_967_295
              ? { lineno: frame.lineno }
              : {}),
            ...(Number.isSafeInteger(frame.colno) &&
            Number(frame.colno) >= 0 &&
            Number(frame.colno) <= 4_294_967_295
              ? { colno: frame.colno }
              : {}),
            ...(typeof frame.chunk_id === 'string' && uuid.test(frame.chunk_id)
              ? { chunk_id: frame.chunk_id }
              : {})
          }
        ];
      })
      .slice(0, 50);
    return {
      type:
        typeof exception.type === 'string' && errorTypes.has(exception.type)
          ? exception.type
          : 'Error',
      value: 'Application error',
      mechanism: { type: 'generic', handled: true },
      stacktrace: { type: 'raw', frames }
    };
  });
}

const replayTags = new Set(
  'html head body div span p a button input textarea select option label form fieldset legend main nav header footer section article aside h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption col colgroup br hr strong em b i small code pre progress details summary dialog svg path g circle rect line polyline polygon ellipse defs use title text tspan clipPath mask link style meta base'
    .toLowerCase()
    .split(' ')
);
const replayNumbers = new Set([
  'id',
  'type',
  'source',
  'rootId',
  'parentId',
  'nextId',
  'previousId',
  'x',
  'y',
  'width',
  'height',
  'top',
  'left',
  'timeOffset',
  'pointerType',
  'start',
  'end',
  'startOffset',
  'endOffset'
]);
const replayBooleans = new Set([
  'isSVG',
  'isShadow',
  'isShadowHost',
  'needBlock',
  'isChecked',
  'userTriggered',
  'isBlocked'
]);
const replayContainers = new Set([
  'node',
  'childNodes',
  'initialOffset',
  'adds',
  'removes',
  'texts',
  'positions',
  'ranges'
]);
const mask = (value: string) => value.replace(/\S/g, '*');

/** A second boundary protects replay even if a future recorder changes its masking defaults. */
function replayData(value: unknown, depth = 0): unknown {
  if (depth > 100) return null;
  if (Array.isArray(value)) return value.map((item) => replayData(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (replayNumbers.has(key) && typeof entry === 'number' && Number.isFinite(entry))
      result[key] = entry;
    else if (replayBooleans.has(key) && typeof entry === 'boolean') result[key] = entry;
    else if (replayContainers.has(key)) result[key] = replayData(entry, depth + 1);
    else if (key === 'attributes') {
      if (Array.isArray(entry)) result[key] = replayData(entry, depth + 1);
      else {
        // Only recorder-generated layout survives; arbitrary DOM attribute names can also contain data.
        result[key] = Object.fromEntries(
          Object.entries(record(entry)).filter(
            ([name, content]) =>
              (['rr_width', 'rr_height'].includes(name) &&
                typeof content === 'string' &&
                /^\d+(?:\.\d+)?px$/.test(content)) ||
              (['rr_scrollLeft', 'rr_scrollTop'].includes(name) &&
                typeof content === 'number' &&
                Number.isFinite(content))
          )
        );
      }
    } else if (['text', 'textContent', 'value'].includes(key) && typeof entry === 'string')
      result[key] = mask(entry);
    else if (key === 'tagName')
      result[key] =
        typeof entry === 'string' && replayTags.has(entry.toLowerCase()) ? entry : 'div';
    else if (key === 'name') result[key] = 'html';
    else if (key === 'publicId' || key === 'systemId') result[key] = '';
    else if (key === 'compatMode')
      result[key] = entry === 'BackCompat' ? 'BackCompat' : 'CSS1Compat';
  }
  return result;
}

/** CSS, canvas, fonts, logs and custom/plugin payloads have no replay permission. */
function sanitizeSnapshots(value: unknown, origin: string): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const snapshot = record(item);
    if (typeof snapshot.type !== 'number' || snapshot.type < 0 || snapshot.type > 4) return [];
    if (
      snapshot.type === 3 &&
      ![0, 1, 2, 3, 4, 5, 6, 12, 14].includes(Number(record(snapshot.data).source))
    )
      return [];
    if (snapshot.type === 4) {
      const data = record(snapshot.data);
      return [
        {
          type: 4,
          timestamp: snapshot.timestamp,
          data: { ...record(replayData(data)), href: safePageUrl(data.href, origin) }
        }
      ];
    }
    return [
      { type: snapshot.type, timestamp: snapshot.timestamp, data: replayData(snapshot.data) }
    ];
  });
}

/** Last boundary before transmission. Rebuild properties instead of deleting known secrets. */
export function sanitizeCapture(
  event: CaptureResult | null,
  context: { origin: string; release: string; key: string; enabled: boolean; environment?: string }
): CaptureResult | null {
  if (
    !event ||
    !context.enabled ||
    !['$pageview', 'tracker_operation', '$exception', '$snapshot'].includes(event.event)
  )
    return null;
  const input = record(event.properties);
  const properties: Record<string, unknown> = {
    token: context.key,
    service: 'browser',
    environment: telemetryEnvironment(context.environment),
    release: /^[a-f0-9]{40}$/.test(context.release) ? context.release : 'unknown',
    $lib: 'web',
    $process_person_profile: false,
    $geoip_disable: true
  };
  for (const key of [
    'distinct_id',
    '$device_id',
    '$session_id',
    '$window_id',
    '$pageview_id',
    '$exception_event_id'
  ]) {
    if (typeof input[key] === 'string' && uuid.test(input[key])) properties[key] = input[key];
  }
  if (typeof input.$lib_version === 'string' && /^\d+\.\d+\.\d+$/.test(input.$lib_version))
    properties.$lib_version = input.$lib_version;
  if (event.event !== '$snapshot') {
    properties.$pathname = safePath(input.$pathname ?? input.$current_url);
    properties.$current_url = safePageUrl(properties.$pathname, context.origin);
  }
  if (event.event === 'tracker_operation') {
    if (
      !OPERATIONS.includes(input.operation as TelemetryOperation) ||
      !OUTCOMES.includes(input.outcome as TelemetryOutcome)
    )
      return null;
    properties.operation = input.operation;
    properties.outcome = input.outcome;
    properties.duration_ms =
      typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms)
        ? Math.min(86_400_000, Math.max(0, Math.round(input.duration_ms)))
        : 0;
  }
  if (event.event === '$exception') {
    properties.$exception_list = sanitizeExceptions(input.$exception_list, context.origin);
    properties.$exception_level = 'error';
    if (OPERATIONS.includes(input.operation as TelemetryOperation))
      properties.operation = input.operation;
  }
  if (event.event === '$snapshot') {
    properties.$snapshot_data = sanitizeSnapshots(input.$snapshot_data, context.origin);
    if (!(properties.$snapshot_data as unknown[]).length) return null;
    if (typeof input.$snapshot_bytes === 'number')
      properties.$snapshot_bytes = input.$snapshot_bytes;
  }
  return {
    uuid: event.uuid,
    event: event.event,
    properties,
    ...(event.timestamp ? { timestamp: event.timestamp } : {})
  };
}
