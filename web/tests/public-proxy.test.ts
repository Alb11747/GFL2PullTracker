import test from 'node:test';
import assert from 'node:assert/strict';
import { forward, backendUrl } from '../src/lib/proxy.ts';

const options = {
  mode: 'public' as const,
  publicOrigin: 'https://tracker.example',
  allowedBackends: ['http://api:8000'],
  clientAddress: '192.0.2.10'
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
      'x-gfl2-client-ip': '203.0.113.99',
      'x-forwarded-for': '203.0.113.99',
      'x-csrf-token': 'a'.repeat(32)
    }),
    'http://api:8000',
    async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('cookie'), 'gfl2_session=abc-123_DEF');
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.get('x-gfl2-client-ip'), '192.0.2.10');
      assert.equal(headers.has('x-forwarded-for'), false);
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
test('public proxy requires a strict adapter address without forwarding forged browser identity', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const clientAddress of [
    undefined,
    '',
    'unknown',
    '192.0.2.1,192.0.2.2',
    '192.0.2.1:80',
    '[::1]',
    'fe80::1%eth0'
  ]) {
    const result = await forward(
      request('public/config', 'GET', {
        'x-real-ip': '192.0.2.1',
        'x-gfl2-client-ip': '192.0.2.1'
      }),
      'http://api:8000',
      fetcher,
      { ...options, clientAddress }
    );
    assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
  assert.equal(
    (
      await forward(request('public/config'), 'http://api:8000', fetcher, {
        ...options,
        clientAddress: '2001:db8::1'
      })
    ).status,
    200
  );
});
test('public cancellation permits only POST and preserves session, CSRF and origin boundaries', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), 'http://api:8000/api/public/jobs/job-1/cancel');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('cookie'), 'gfl2_session=own-session');
    assert.equal(headers.get('x-csrf-token'), 'a'.repeat(32));
    assert.equal(headers.get('origin'), 'https://tracker.example');
    assert.equal(headers.has('authorization'), false);
    return Response.json({ status: 'cancelling' });
  };
  const headers = {
    cookie: 'foreign=secret; gfl2_session=own-session',
    authorization: 'secret',
    'x-csrf-token': 'a'.repeat(32)
  };
  assert.equal(
    (
      await forward(
        request('public/jobs/job-1/cancel', 'POST', headers),
        'http://api:8000',
        fetcher,
        options
      )
    ).status,
    200
  );
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'])
    assert.equal(
      (
        await forward(
          request('public/jobs/job-1/cancel', method),
          'http://api:8000',
          fetcher,
          options
        )
      ).status,
      404
    );
  for (const path of ['public/jobs/job-1/cancel/extra', 'jobs/job-1/cancel'])
    assert.equal(
      (await forward(request(path, 'POST'), 'http://api:8000', fetcher, options)).status,
      404
    );
  const rejectedHeadersCases: Record<string, string>[] = [
    { origin: 'https://evil.example' },
    { origin: '' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example' }
  ];
  for (const rejectedHeaders of rejectedHeadersCases)
    assert.equal(
      (
        await forward(
          request('public/jobs/job-1/cancel', 'POST', rejectedHeaders),
          'http://api:8000',
          fetcher,
          options
        )
      ).status,
      403
    );
  assert.equal(calls, 1);
});
