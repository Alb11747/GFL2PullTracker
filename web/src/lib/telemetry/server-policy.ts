import { resolve } from 'node:path';
import type { EventMessage } from 'posthog-node';

/** Only normalized preferences cross the private API boundary. Any opt-out wins. */
export function requestTelemetryAllowed(headers: Headers): boolean {
  if (headers.get('dnt') === '1' || headers.get('sec-gpc') === '1') return false;
  const preference = headers.get('x-gfl2-telemetry');
  if (preference !== null && preference !== '1') return false;
  const cookies = (headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('gfl2_telemetry='));
  return cookies.length === 0 || (cookies.length === 1 && cookies[0] === 'gfl2_telemetry=1');
}

export type ServerOperation = 'request' | 'proxy';
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'AggregateError'
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Preserve the deployed filename until the SDK matches its injected chunk registry. */
export function safeServerError(error: unknown): Error {
  const clean = new Error('Unexpected tracker server failure');
  const frames: string[] = [];
  try {
    if (error instanceof Error) {
      clean.name = errorTypes.has(error.name) ? error.name : 'Error';
      for (const line of (error.stack ?? '').split('\n').slice(1, 31)) {
        const match = line.match(
          /((?:file:\/\/)?\/(?:app|web)\/build\/(server\/[A-Za-z0-9_./-]+\.js)):(\d+):(\d+)\)?$/
        );
        if (match && !match[2].includes('..'))
          frames.push(`    at ${match[1]}:${match[3]}:${match[4]}`);
      }
    }
  } catch {
    /* Untrusted thrown values may have throwing accessors. */
  }
  clean.stack = `${clean.name}: ${clean.message}${frames.length ? '\n' + frames.join('\n') : ''}`;
  return clean;
}

/** SDK context and source-line enrichment are untrusted at the final send boundary. */
export function sanitizeServerEvent(
  event: EventMessage | null,
  release: string
): EventMessage | null {
  if (!event || event.event !== '$exception') return null;
  const input = record(event.properties);
  const exceptions = Array.isArray(input.$exception_list) ? input.$exception_list.slice(0, 1) : [];
  const exceptionList = exceptions.map((value) => {
    const exception = record(value),
      stack = record(exception.stacktrace);
    const frames = (Array.isArray(stack.frames) ? stack.frames : [])
      .flatMap((value) => {
        const frame = record(value);
        if (typeof frame.filename !== 'string') return [];
        // Node's SDK makes paths relative to cwd after attaching chunk IDs.
        // Resolve those without reading files, then re-apply the deployment-root boundary.
        const resolved = resolve(frame.filename).replace(/\\/g, '/');
        const path =
          frame.filename.match(
            /^(?:(?:file:\/\/)?\/(?:app|web)\/build\/|app:\/\/\/build\/|(?:build\/)?)(server\/[A-Za-z0-9_./-]+\.js)$/
          )?.[1] ??
          resolved.match(
            /^(?:[A-Za-z]:)?\/(?:app|web)\/build\/(server\/[A-Za-z0-9_./-]+\.js)$/
          )?.[1];
        if (!path || path.includes('..')) return [];
        return [
          {
            filename: `app:///build/${path}`,
            platform: 'node:javascript',
            in_app: true,
            ...(Number.isSafeInteger(frame.lineno) && Number(frame.lineno) > 0
              ? { lineno: frame.lineno }
              : {}),
            ...(Number.isSafeInteger(frame.colno) && Number(frame.colno) >= 0
              ? { colno: frame.colno }
              : {}),
            ...(typeof frame.chunk_id === 'string' && uuid.test(frame.chunk_id)
              ? { chunk_id: frame.chunk_id }
              : {})
          }
        ];
      })
      .slice(0, 30);
    return {
      type:
        typeof exception.type === 'string' && errorTypes.has(exception.type)
          ? exception.type
          : 'Error',
      value: 'Unexpected tracker server failure',
      mechanism: { handled: true, type: 'generic' },
      stacktrace: { frames, type: 'raw' }
    };
  });
  return {
    event: '$exception',
    distinctId: 'gfl2-web-service',
    disableGeoip: true,
    ...(typeof event.uuid === 'string' && uuid.test(event.uuid) ? { uuid: event.uuid } : {}),
    properties: {
      $exception_list: exceptionList,
      $exception_level: 'error',
      $process_person_profile: false,
      service: 'web',
      environment: 'production',
      operation: input.operation === 'proxy' ? 'proxy' : 'request',
      release: /^[a-f0-9]{40}$/.test(release) ? release : 'unknown',
      ...(typeof input.$release_id === 'string' && uuid.test(input.$release_id)
        ? { $release_id: input.$release_id }
        : {})
    }
  };
}
