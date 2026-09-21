import type { ImportInput } from './api.ts';
import { OFFICIAL_HOSTS } from './local/types.ts';

export type CaptureErrorCode = 'input' | 'network' | 'upstream' | 'limit' | 'cancelled';
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly canUseServerFallback: boolean;
  partial?: ImportInput;
  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.canUseServerFallback = code === 'network';
  }
}
export interface CaptureProgress {
  typeId: number;
  pages: number;
  records: number;
}
export interface CaptureOptions {
  server?: string;
  signal?: AbortSignal;
  onProgress?: (progress: CaptureProgress) => void;
  fetcher?: typeof fetch;
}
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 1000;
const MAX_RECORDS = 100_000;
const MAX_TYPE = 1000;
const MISS_THRESHOLD = 10;

/** Memory-only request data. Never store this object or use it in an error message. */
interface ParsedCapture {
  url: URL;
  authorization: string;
  server: string;
  account: string;
  channel: string;
  controlType: number;
  secrets: string[];
}
function input(message: string): never {
  throw new CaptureError('input', message);
}
function single(query: URLSearchParams, key: string): string {
  const values = query.getAll(key);
  if (values.length !== 1 || !values[0]) input(`The capture requires exactly one ${key} value.`);
  return values[0];
}
function parseCapture(text: string, serverOverride?: string): ParsedCapture {
  if (new TextEncoder().encode(text).length > MAX_CAPTURE_BYTES)
    input('The capture is too large. Copy only the matching HTTP request.');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^POST\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(line.trim()));
  if (start < 0) input('Copy the raw POST request, including its absolute HTTPS URL and headers.');
  const original = lines[start].trim().split(/\s+/)[1];
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return input('The request URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    !OFFICIAL_HOSTS.has(url.hostname) ||
    url.port ||
    url.pathname !== '/list' ||
    url.username ||
    url.password ||
    url.hash
  )
    input('Only the official HTTPS recruitment /list endpoint is accepted.');
  const headers = new Map<string, string>();
  let cursor = start + 1;
  for (; cursor < lines.length && lines[cursor].trim(); cursor++) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.*)$/.exec(lines[cursor]);
    if (!match || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(lines[cursor]))
      input('The capture contains a malformed HTTP header.');
    const key = match[1].toLowerCase();
    if (headers.has(key)) input('The capture contains a duplicate HTTP header.');
    headers.set(key, match[2].trim());
  }
  const host = headers.get('host')?.toLowerCase().replace(/:443$/, '');
  if (host && host !== url.hostname) input('The Host header does not match the official URL.');
  const authorization = headers.get('authorization');
  if (!authorization) input('The capture is missing its Authorization header.');
  const body = lines
    .slice(cursor + 1)
    .join('\n')
    .split(/^HTTP\/\d(?:\.\d)?\s+\d{3}/m)[0]
    .trim();
  const form = new URLSearchParams(body);
  const account = single(url.searchParams, 'u');
  const channel = single(url.searchParams, 'game_channel_id');
  if (!/^\d+$/.test(channel)) input('The captured game channel must be numeric.');
  const type = single(url.searchParams, 'type_id');
  if (!/^\d+$/.test(type) || Number(type) < 1 || Number(type) > MAX_TYPE)
    input('The captured type_id must be between 1 and 1000.');
  let metadata: Record<string, unknown> = {};
  try {
    const segment = authorization
      .replace(/^bearer\s+/i, '')
      .split('.')[0]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(segment), (ch) => ch.charCodeAt(0)))
    );
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) metadata = decoded;
  } catch {
    /* An explicit captured form body also supports opaque tokens. */
  }
  const capturedServer = form.has('server') ? single(form, 'server') : null;
  const tokenServer = metadata.tinx === undefined ? null : String(metadata.tinx);
  const server = serverOverride ?? capturedServer ?? tokenServer;
  if (server === null || !/^\d+$/.test(server))
    input('The captured request does not contain a valid server value. Include its form body.');
  if (
    serverOverride === undefined &&
    capturedServer !== null &&
    tokenServer !== null &&
    capturedServer !== tokenServer
  )
    input('The captured server does not match the token metadata.');
  const length = headers.get('content-length');
  if (
    serverOverride === undefined &&
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) !== `server=${server}`.length)
  )
    input(
      'The captured form body does not match Content-Length. Capture the complete request again.'
    );
  if (
    metadata.expires !== undefined &&
    Number.isFinite(Number(metadata.expires)) &&
    Number(metadata.expires) <= Date.now() / 1000
  )
    input('This capture has expired. Capture a fresh request.');
  return {
    url,
    authorization,
    server,
    account,
    channel,
    controlType: Number(type),
    secrets: [authorization, account, encodeURIComponent(account), original]
  };
}
/** Validate locally before a form discards its memory-only capture. */
export function validateCapture(text: string, server?: string): void {
  parseCapture(text, server);
}

async function boundedText(response: Response, budget: number): Promise<string> {
  const limit = Math.min(MAX_PAGE_BYTES, budget);
  if (Number(response.headers.get('content-length')) > limit)
    throw new CaptureError('limit', 'An official response exceeds the import size limit.');
  if (!response.body)
    throw new CaptureError('upstream', 'The official service returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new CaptureError('limit', 'The import exceeds the response size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Fetch a fresh full snapshot. Existing snapshots are merged by the local worker. */
export async function collectCapture(
  text: string,
  profileId: string,
  options: CaptureOptions = {}
): Promise<ImportInput> {
  const capture = parseCapture(text, options.server);
  // Decoded token metadata selects the request server only; it is never ownership proof.
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capture.account))
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const started = new Date().toISOString();
  const identity = {
    endpoint_host: capture.url.hostname,
    account_fingerprint: `sha256:${fingerprint}`,
    server: capture.server,
    game_channel_id: capture.channel
  };
  const records: { source_type_id: number; source_page: number; record: unknown }[] = [];
  const types: Record<string, { status: string; pages: number; records: number }> = {};
  const rawPages: Record<string, string> = {};
  const manifest: Record<string, unknown> = {
    schema_version: 2,
    started_at: started,
    completed_at: null,
    complete: false,
    ...identity,
    scan: {
      captured_type_id: capture.controlType,
      start_type: 1,
      consecutive_misses: MISS_THRESHOLD,
      max_type: MAX_TYPE,
      timeout_seconds: 20,
      retries: 0
    },
    probe: { last_type_id: null, consecutive_misses: 0 },
    types,
    errors: []
  };
  const result: ImportInput = {
    profile_id: profileId,
    records_document: { schema_version: 2, exported_at: started, ...identity, records },
    manifest,
    raw_pages: rawPages
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 180_000);
  let totalBytes = 0;
  let pages = 0;
  async function request(
    typeId: number,
    next = ''
  ): Promise<{ unavailable: boolean; raw: string; rows: unknown[]; next: string }> {
    if (controller.signal.aborted)
      throw new CaptureError(
        options.signal?.aborted ? 'cancelled' : 'limit',
        'Collection stopped. Use a fresh capture before fetching again.'
      );
    if (++pages > MAX_PAGES)
      throw new CaptureError('limit', 'The collection reached its page limit.');
    const target = new URL(`https://${capture.url.hostname}/list`);
    // Only documented request fields leave the browser, even if the capture has extras.
    target.search = new URLSearchParams({
      u: capture.account,
      game_channel_id: capture.channel,
      type_id: String(typeId)
    }).toString();
    if (next) target.searchParams.set('next', next);
    const requestController = new AbortController();
    const stopRequest = () => requestController.abort();
    controller.signal.addEventListener('abort', stopRequest, { once: true });
    const requestTimer = setTimeout(stopRequest, 20_000);
    try {
      const response = await (options.fetcher ?? fetch)(target, {
        method: 'POST',
        headers: {
          Authorization: capture.authorization,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ server: capture.server }).toString(),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: requestController.signal
      });
      if (!response.ok) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          ![401, 403, 408, 429].includes(response.status)
        )
          return { unavailable: true, raw: '', rows: [], next: '' };
        throw new CaptureError(
          'upstream',
          'The official service rejected the request. Use a fresh capture or try again later.'
        );
      }
      const raw = await boundedText(response, MAX_TOTAL_BYTES - totalBytes);
      totalBytes += new TextEncoder().encode(raw).length;
      if (capture.secrets.some((secret) => raw.includes(secret)))
        throw new CaptureError(
          'upstream',
          'The response contains a sensitive request value and cannot be saved.'
        );
      let envelope: { code?: unknown; data?: { list?: unknown; next?: unknown } };
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new CaptureError('upstream', 'The official service returned malformed JSON.');
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
        throw new CaptureError('upstream', 'The official service returned an invalid response.');
      if (envelope.code !== 0 && envelope.code !== '0')
        return { unavailable: true, raw: '', rows: [], next: '' };
      if (!Array.isArray(envelope.data?.list))
        throw new CaptureError(
          'upstream',
          'The official service response is missing its record list.'
        );
      const cursor = envelope.data?.next;
      if (cursor != null && typeof cursor !== 'string' && typeof cursor !== 'number')
        throw new CaptureError(
          'upstream',
          'The official service returned an invalid pagination cursor.'
        );
      return {
        unavailable: false,
        raw,
        rows: envelope.data.list,
        next: cursor == null ? '' : String(cursor)
      };
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      if (options.signal?.aborted) throw new CaptureError('cancelled', 'Collection cancelled.');
      if (controller.signal.aborted || requestController.signal.aborted)
        throw new CaptureError(
          'limit',
          'The collection timed out. Use a fresh capture before fetching again.'
        );
      throw new CaptureError(
        'network',
        'The browser could not access the game service. Choose server fetch explicitly or import a local collector export.'
      );
    } finally {
      clearTimeout(requestTimer);
      controller.signal.removeEventListener('abort', stopRequest);
    }
  }
  async function collectType(typeId: number, control: boolean): Promise<number> {
    const entry = (types[String(typeId)] = { status: 'in_progress', pages: 0, records: 0 });
    const seen = new Set<string>();
    let next = '';
    for (;;) {
      const page = await request(typeId, next);
      if (page.unavailable) {
        if (control || entry.pages)
          throw new CaptureError(
            'upstream',
            'The capture no longer validates with the official service. Capture a fresh request.'
          );
        if ((await request(capture.controlType)).unavailable)
          throw new CaptureError(
            'upstream',
            'The capture expired during collection. Capture a fresh request.'
          );
        entry.status = 'unavailable';
        return 0;
      }
      if (records.length + page.rows.length > MAX_RECORDS)
        throw new CaptureError('limit', 'The import exceeds the record limit.');
      entry.pages++;
      entry.records += page.rows.length;
      rawPages[
        `raw/type_${String(typeId).padStart(4, '0')}/page_${String(entry.pages).padStart(4, '0')}.json`
      ] = page.raw;
      records.push(
        ...page.rows.map((record) => ({ source_type_id: typeId, source_page: entry.pages, record }))
      );
      options.onProgress?.({ typeId, pages, records: records.length });
      if (!page.next) {
        entry.status = entry.records ? 'complete' : 'empty';
        return entry.records;
      }
      if (seen.has(page.next))
        throw new CaptureError('upstream', 'The official service repeated a pagination cursor.');
      seen.add(page.next);
      next = page.next;
    }
  }
  try {
    const controlRecords = await collectType(capture.controlType, true);
    let misses = 0;
    for (let typeId = 1; misses < MISS_THRESHOLD; typeId++) {
      if (typeId > MAX_TYPE)
        throw new CaptureError(
          'limit',
          'Collection reached the source type limit before completion.'
        );
      const count =
        typeId === capture.controlType ? controlRecords : await collectType(typeId, false);
      misses = count ? 0 : misses + 1;
      manifest.probe = { last_type_id: typeId, consecutive_misses: misses };
    }
    manifest.complete = true;
    manifest.completed_at = new Date().toISOString();
    if (capture.secrets.some((secret) => JSON.stringify(result).includes(secret)))
      throw new CaptureError(
        'upstream',
        'The import contains a sensitive request value and cannot be saved.'
      );
    return result;
  } catch (error) {
    const failure =
      error instanceof CaptureError
        ? error
        : new CaptureError('upstream', 'Collection could not complete.');
    manifest.complete = false;
    for (const entry of Object.values(types))
      if (entry.status === 'in_progress') entry.status = 'error';
    manifest.errors = [{ kind: failure.code, message: failure.message }];
    manifest.completed_at = new Date().toISOString();
    if (
      records.length &&
      !capture.secrets.some((secret) => JSON.stringify(result).includes(secret))
    )
      failure.partial = result;
    throw failure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    // The collector never persists request data; erase references retained by its closure.
    capture.authorization = '';
    capture.account = '';
    capture.secrets = [];
    capture.url.search = '';
    text = '';
  }
}
