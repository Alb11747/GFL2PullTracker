const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 64 * 1024 * 1024;
export interface ProxyOptions {
  mode?: 'local' | 'public';
  publicOrigin?: string;
  allowedBackends?: string[];
}
export function backendUrl(configured: string, allowedBackends?: string[]): URL {
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !(allowedBackends ? allowedBackends.includes(url.origin) : LOOPBACK_HOSTS.has(url.hostname)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('GFL2_API_URL must be an explicitly allowed bare HTTP backend origin.');
  return url;
}
function failure(detail: string, status: number) {
  return Response.json({ detail }, { status });
}
export async function forward(
  request: Request,
  configured: string,
  fetcher: typeof fetch = fetch,
  options: ProxyOptions = {}
): Promise<Response> {
  const incoming = new URL(request.url);
  const hosted = options.mode === 'public';
  if (hosted && (!options.publicOrigin || incoming.origin !== options.publicOrigin))
    return failure('Use the configured tracker address.', 403);
  if (
    (!hosted && !LOOPBACK_HOSTS.has(incoming.hostname)) ||
    request.headers.get('host') !== incoming.host
  )
    return failure('Use the local tracker address.', 403);
  const method = request.method;
  const path = incoming.pathname;
  const bodyLimit = hosted
    ? /\/public\/(fetch|verify)$/.test(path)
      ? 300 * 1024
      : 16 * 1024 * 1024
    : MAX_BODY;
  const readable = hosted
    ? /^\/api\/(health|public\/(config|statistics|backup|jobs\/[a-zA-Z0-9-]+(?:\/result)?))$/.test(
        path
      )
    : /^\/api\/(health|profiles|history|statistics|filters|imports|jobs\/[a-zA-Z0-9-]+)$/.test(
        path
      );
  const writable = hosted
    ? /^\/api\/public\/(verify|fetch|backup|contribution)$/.test(path)
    : /^\/api\/(profiles|imports|fetch)$/.test(path);
  const writeMethod = hosted ? ['POST', 'PUT', 'DELETE'].includes(method) : method === 'POST';
  if ((method !== 'GET' || !readable) && (!writeMethod || !writable))
    return failure('API route not found.', 404);
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return failure('Cross-site requests are not allowed.', 403);
  const origin = request.headers.get('origin');
  if (hosted && writeMethod && origin !== options.publicOrigin)
    return failure('A same-origin request is required.', 403);
  if (origin && origin !== incoming.origin)
    return failure('Use the tracker from the same local origin.', 403);
  const headers = new Headers();
  if (hosted) {
    // Only the tracker session crosses this trust boundary; game and Google
    // credentials must never be forwarded from ambient browser headers.
    const cookie = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .filter((part) => /^gfl2_session=[A-Za-z0-9_-]+$/.test(part))
      .join('; ');
    if (cookie) headers.set('cookie', cookie);
    const csrf = request.headers.get('x-csrf-token');
    if (csrf && /^[A-Za-z0-9_-]{16,256}$/.test(csrf)) headers.set('x-csrf-token', csrf);
  }
  let body: string | undefined;
  if (writeMethod) {
    if (
      method !== 'DELETE' &&
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return failure('Use application/json.', 415);
    if (Number(request.headers.get('content-length') || 0) > bodyLimit)
      return failure('Import exceeds the 64 MiB limit.', 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > bodyLimit) {
          await reader.cancel();
          return failure('Import exceeds the 64 MiB limit.', 413);
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    body = new TextDecoder().decode(bytes);
    headers.set('content-type', 'application/json');
    if (origin) headers.set('origin', origin);
    const site = request.headers.get('sec-fetch-site');
    if (site) headers.set('sec-fetch-site', site);
  }
  try {
    const target = backendUrl(configured, hosted ? (options.allowedBackends ?? []) : undefined);
    target.pathname = path;
    target.search = incoming.search;
    const response = await fetcher(target, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    });
    const responseHeaders = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    if (hosted) {
      for (const cookie of response.headers.getSetCookie()) {
        if (cookie.startsWith('gfl2_session=')) responseHeaders.append('set-cookie', cookie);
      }
      if (response.headers.has('retry-after'))
        responseHeaders.set('retry-after', response.headers.get('retry-after')!);
    }
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });
  } catch {
    return failure(
      'The Python service is unavailable. Start both tracker services and check the archive before retrying an import.',
      503
    );
  }
}
