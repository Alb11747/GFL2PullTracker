import test from 'node:test';
import assert from 'node:assert/strict';
import { forward, backendUrl } from '../src/lib/proxy.ts';

const options = {
  mode: 'public' as const,
  publicOrigin: 'https://tracker.example',
  allowedBackends: ['http://api:8000']
};
function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Request(`https://tracker.example/api/${path}`, {
    method,
    headers: {
      host: 'tracker.example',
      origin: 'https://tracker.example',
      'content-type': 'application/json',
      ...headers
    },
    ...(method === 'POST' ? { body: '{}' } : {})
  });
}
test('public proxy requires configured origins and never exposes local APIs', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const req of [
    request('profiles'),
    request('public/fetch', 'POST', { origin: 'https://evil.example' }),
    request('public/config', 'GET', { host: 'evil.example' })
  ]) {
    assert.ok((await forward(req, 'http://api:8000', fetcher, options)).status >= 400);
  }
  assert.equal(calls, 0);
  assert.throws(() => backendUrl('http://evil.example', options.allowedBackends));
  assert.equal(backendUrl('http://api:8000', options.allowedBackends).host, 'api:8000');
});
test('public proxy forwards only its own session, preserves CSRF and session renewal', async () => {
  const response = await forward(
    request('public/fetch', 'POST', {
      cookie: 'other=secret; gfl2_session=abc-123_DEF',
      authorization: 'private',
      'x-csrf-token': 'a'.repeat(32)
    }),
    'http://api:8000',
    async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('cookie'), 'gfl2_session=abc-123_DEF');
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.get('x-csrf-token'), 'a'.repeat(32));
      return new Response('{}', {
        headers: { 'set-cookie': 'gfl2_session=new; HttpOnly; Secure; SameSite=Strict' }
      });
    },
    options
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
