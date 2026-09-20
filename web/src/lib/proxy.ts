const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 64 * 1024 * 1024;
export function backendUrl(configured: string): URL {
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('GFL2_API_URL must be an HTTP loopback origin.');
  return url;
}
function failure(detail: string, status: number) {
  return Response.json({ detail }, { status });
}
export async function forward(
  request: Request,
  configured: string,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const incoming = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(incoming.hostname) || request.headers.get('host') !== incoming.host)
    return failure('Use the local tracker address.', 403);
  const method = request.method;
  const path = incoming.pathname;
  const readable =
    /^\/api\/(health|profiles|history|statistics|filters|imports|jobs\/[a-zA-Z0-9-]+)$/.test(path);
  const writable = /^\/api\/(profiles|imports|fetch)$/.test(path);
  if ((method !== 'GET' || !readable) && (method !== 'POST' || !writable))
    return failure('API route not found.', 404);
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return failure('Cross-site requests are not allowed.', 403);
  const origin = request.headers.get('origin');
  if (origin && origin !== incoming.origin)
    return failure('Use the tracker from the same local origin.', 403);
  const headers = new Headers();
  let body: string | undefined;
  if (method === 'POST') {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
      return failure('Use application/json.', 415);
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY)
      return failure('Import exceeds the 64 MiB limit.', 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY) {
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
    const target = backendUrl(configured);
    target.pathname = path;
    target.search = incoming.search;
    const response = await fetcher(target, { method, headers, body, redirect: 'error' });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch {
    return failure(
      'The Python service is unavailable. Start both tracker services and check the archive before retrying an import.',
      503
    );
  }
}
