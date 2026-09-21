import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createClient, queryString } from '../src/lib/api.ts';
import { createPublicClient, PublicApiError } from '../src/lib/public-api.ts';
import { readExport, MAX_IMPORT_BYTES, type ExportFile } from '../src/lib/import-files.ts';
import { backendUrl, forward } from '../src/lib/proxy.ts';

test('multi-select query values preserve OR selections and explicit none', () => {
  const query = new URLSearchParams(
    queryString({
      rarity: ['Elite', 'Standard'],
      kind: [],
      type_id: ['3', '6'],
      pool_id: ''
    })
  );
  assert.deepEqual(query.getAll('rarity'), ['Elite', 'Standard']);
  assert.deepEqual(query.getAll('kind'), ['__none__']);
  assert.deepEqual(query.getAll('type_id'), ['3', '6']);
  assert.equal(query.has('pool_id'), false);
});

test('overview uses the local read-only proxy and cannot expose hosted archives', async () => {
  const calls: string[] = [];
  const fetcher = fakeFetch(async (input) => {
    calls.push(String(input));
    return Response.json([]);
  });
  await createClient(fetcher).overview('profile one');
  assert.deepEqual(calls, ['/api/overview?profile_id=profile+one']);
  calls.length = 0;
  const local = new Request('http://127.0.0.1:3000/api/overview?profile_id=p', {
    headers: { host: '127.0.0.1:3000' }
  });
  assert.equal((await forward(local, 'http://127.0.0.1:8000', fetcher)).status, 200);
  const hosted = new Request('https://tracker.example/api/overview?profile_id=p', {
    headers: { host: 'tracker.example' }
  });
  assert.equal(
    (
      await forward(hosted, 'http://backend:8000', fetcher, {
        mode: 'public',
        publicOrigin: 'https://tracker.example',
        allowedBackends: ['http://backend:8000']
      })
    ).status,
    404
  );
  assert.deepEqual(calls, ['http://127.0.0.1:8000/api/overview?profile_id=p']);
});

function file(path: string, text = '{}', size = new TextEncoder().encode(text).length): ExportFile {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    size,
    async text() {
      return text;
    }
  };
}
function fakeFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return fn as typeof fetch;
}

test('export preserves exact raw response text and identifies optional source documents', async () => {
  const raw = '{ "preserve": [1, 2] }\r\n';
  const input = await readExport(
    [
      file('run/records.json', '\uFEFF{"schema_version":1}'),
      file('run/manifest.json', '{"complete":false}'),
      file('run/raw/type_0006/page_0001.json', raw)
    ],
    'profile'
  );
  assert.deepEqual(input.records_document, { schema_version: 1 });
  assert.deepEqual(input.manifest, { complete: false });
  assert.equal(input.raw_pages?.['raw/type_0006/page_0001.json'], raw);
});
test('records-only selection omits unknown manifest and absent raw pages', async () => {
  const input = await readExport([file('records.json')], 'profile');
  assert.equal('manifest' in input, false);
  assert.equal('raw_pages' in input, false);
});
test('mixed export runs, duplicate records, and flattened raw pages are rejected', async () => {
  await assert.rejects(
    readExport([file('one/records.json'), file('two/manifest.json')], 'p'),
    /different export/
  );
  await assert.rejects(
    readExport([file('one/records.json'), file('two/records.json')], 'p'),
    /exactly one/
  );
  await assert.rejects(
    readExport([file('records.json'), file('page_0001.json')], 'p'),
    /original raw/
  );
  await assert.rejects(
    readExport([file('records.json'), file('manifest.json'), file('manifest.json')], 'p'),
    /duplicate/
  );
});
test('invalid input fails before any network mutation', async () => {
  await assert.rejects(readExport([file('records.json', '{broken')], 'p'), /valid JSON/);
  await assert.rejects(readExport([file('records.json', '[]')], 'p'), /JSON object/);
  await assert.rejects(readExport([file('records.json')], ''), /profile/);
  await assert.rejects(
    readExport([file('records.json', '{}', MAX_IMPORT_BYTES + 1)], 'p'),
    /64 MiB/
  );
});
test('query filters omit empty values and preserve zero and escaped search', () => {
  const query = new URLSearchParams(
    queryString({ profile_id: 'p', q: 'a & b', rarity: '', type_id: '', page: 1, page_size: 20 })
  );
  assert.equal(query.get('q'), 'a & b');
  assert.equal(query.has('rarity'), false);
  assert.equal(query.has('type_id'), false);
});
test('statistics use the same selection without pagination', async () => {
  let url = '';
  const client = createClient(
    fakeFetch(async (input) => {
      url = String(input);
      return Response.json({});
    })
  );
  await client.statistics({
    profile_id: 'p',
    q: 'name',
    rarity: 'Elite',
    kind: 'doll',
    type_id: '6',
    pool_id: '10',
    date_from: '2026-01-01',
    date_to: '',
    page: 3,
    page_size: 20
  });
  assert.ok(url.includes('rarity=Elite'));
  assert.ok(url.includes('type_id=6'));
  assert.ok(!url.includes('page'));
  assert.ok(!url.includes('date_to'));
});
test('failed mutations are sent once and uncertain network errors do not expose captures', async () => {
  let calls = 0;
  const client = createClient(
    fakeFetch(async () => {
      calls++;
      throw new Error('secret-capture');
    })
  );
  await assert.rejects(
    client.fetchHistory('p', 'secret-capture'),
    (error) =>
      error instanceof Error &&
      /result was confirmed/.test(error.message) &&
      !error.message.includes('secret-capture')
  );
  assert.equal(calls, 1);
});
test('API errors retain the actionable server detail', async () => {
  const client = createClient(
    fakeFetch(async () =>
      Response.json({ detail: 'Profile belongs to another account' }, { status: 409 })
    )
  );
  await assert.rejects(
    client.createProfile('name'),
    (error) =>
      error instanceof ApiError && error.status === 409 && /another account/.test(error.message)
  );
});
test('local job errors distinguish a definitive missing job from uncertain network failures', async () => {
  const missing = createClient(fakeFetch(async () => new Response('unreadable', { status: 404 })));
  await assert.rejects(
    missing.job('expired'),
    (error) =>
      error instanceof ApiError &&
      error.status === 404 &&
      error.message === 'The local tracker could not complete this request.'
  );
  const unavailable = createClient(
    fakeFetch(async () => {
      throw new Error('transport');
    })
  );
  await assert.rejects(
    unavailable.job('unknown'),
    (error) => error instanceof Error && !(error instanceof ApiError)
  );
});
test('local cancellation sends no capture and leaves uncertain jobs available to poll', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createClient(
    fakeFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/cancel')) throw new Error('private transport detail');
      return Response.json({ id: 'job-1', status: 'cancelled' });
    })
  );
  await assert.rejects(client.cancelJob('job-1'), /Keep checking this job/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/jobs/job-1/cancel');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, '{}');
  assert.equal((await client.job('job-1')).status, 'cancelled');
  assert.equal(calls.length, 2);
});
test('public cancellation requires CSRF and sends once when its response is lost or unreadable', async () => {
  for (const unreadable of [false, true]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createPublicClient(
      fakeFetch(async (input, init) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith('/config')) return Response.json({ csrf_token: 'a'.repeat(32) });
        if (String(input).endsWith('/cancel')) {
          if (unreadable) return new Response('not json');
          throw new Error('private transport detail');
        }
        return Response.json({ id: 'job-1', status: 'cancelling' });
      })
    );
    await assert.rejects(client.cancelJob('job-1'), /Initialize the public session/);
    assert.equal(calls.length, 0);
    await client.config();
    await assert.rejects(
      client.cancelJob('job-1'),
      (error) =>
        error instanceof PublicApiError &&
        error.uncertain &&
        /Keep checking this job/.test(error.message)
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, '/api/public/jobs/job-1/cancel');
    assert.equal(calls[1].init?.method, 'POST');
    assert.equal(calls[1].init?.body, '{}');
    assert.equal(new Headers(calls[1].init?.headers).get('x-csrf-token'), 'a'.repeat(32));
    assert.equal((await client.job('job-1')).status, 'cancelling');
    assert.equal(calls.length, 3);
  }
});
test('backend configuration accepts only a bare loopback HTTP origin', () => {
  assert.equal(backendUrl('http://127.0.0.1:8000').port, '8000');
  for (const value of [
    'https://example.com',
    'http://example.com',
    'http://127.0.0.1:8000/api',
    'http://user:pass@localhost:8000',
    'http://localhost:8000?url=x'
  ])
    assert.throws(() => backendUrl(value));
});
function request(path = '/api/profiles', headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`http://127.0.0.1:5173${path}`, {
    method,
    headers: {
      host: '127.0.0.1:5173',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:5173',
      ...headers
    },
    ...(method === 'POST' ? { body: '{"name":"test"}' } : {})
  });
}
test('proxy denies foreign origins, forged hosts and unapproved routes before forwarding', async () => {
  let calls = 0;
  const fetcher = fakeFetch(async () => {
    calls++;
    return Response.json({});
  });
  for (const input of [
    request('/api/profiles', { origin: 'https://foreign.example' }),
    request('/api/profiles', { 'sec-fetch-site': 'cross-site' }),
    request('/api/profiles', { host: 'foreign.example' }),
    request('/api/anything')
  ])
    assert.ok((await forward(input, 'http://127.0.0.1:8000', fetcher)).status >= 400);
  assert.equal(calls, 0);
});
test('proxy strips credentials and forwards only bounded JSON to the local API', async () => {
  let target = '',
    sent: RequestInit | undefined;
  const result = await forward(
    request('/api/profiles', { authorization: 'private', cookie: 'private' }),
    'http://127.0.0.1:8000',
    fakeFetch(async (input, init) => {
      target = String(input);
      sent = init;
      return Response.json({ id: 'p' }, { status: 201 });
    })
  );
  assert.equal(target, 'http://127.0.0.1:8000/api/profiles');
  assert.equal(result.status, 201);
  const headers = new Headers(sent?.headers);
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.get('origin'), 'http://127.0.0.1:5173');
  assert.equal(sent?.redirect, 'error');
});
test('local proxy allows cancellation only through the exact POST route', async () => {
  const calls: string[] = [];
  const fetcher = fakeFetch(async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, 'POST');
    return Response.json({ status: 'cancelling' });
  });
  assert.equal(
    (await forward(request('/api/jobs/job-1/cancel'), 'http://127.0.0.1:8000', fetcher)).status,
    200
  );
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'])
    assert.equal(
      (
        await forward(
          request('/api/jobs/job-1/cancel', {}, method),
          'http://127.0.0.1:8000',
          fetcher
        )
      ).status,
      404
    );
  for (const path of [
    '/api/jobs/job-1/cancel/extra',
    '/api/jobs/job-1/result',
    '/api/public/jobs/job-1/cancel'
  ])
    assert.equal((await forward(request(path), 'http://127.0.0.1:8000', fetcher)).status, 404);
  assert.deepEqual(calls, ['http://127.0.0.1:8000/api/jobs/job-1/cancel']);
});
test('proxy bounds upload size and turns unavailable backend into a safe error', async () => {
  let called = false;
  const oversized = await forward(
    request('/api/imports', { 'content-length': String(MAX_IMPORT_BYTES + 1) }),
    'http://127.0.0.1:8000',
    fakeFetch(async () => {
      called = true;
      return Response.json({});
    })
  );
  assert.equal(oversized.status, 413);
  assert.equal(called, false);
  const unavailable = await forward(
    request(),
    'http://127.0.0.1:8000',
    fakeFetch(async () => {
      throw new Error('private');
    })
  );
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes('private'));
});
