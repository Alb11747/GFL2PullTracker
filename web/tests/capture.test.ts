import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCapture, CaptureError, validateCapture } from '../src/lib/capture.ts';
import { createPublicClient, PublicApiError } from '../src/lib/public-api.ts';
import { validateDocument } from '../src/lib/local/engine.ts';

const host = 'gf2-gacha-record-us.sunborngame.com';
const account = 'synthetic-account-not-a-real-uid';
const capture = (extra = '', token = 'synthetic-opaque-credential') =>
  `POST https://${host}/list?u=${account}&game_channel_id=1&type_id=1&untrusted=not-forwarded HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${token}\r\nCookie: session=not-forwarded\r\nX-Injected: not-forwarded\r\nContent-Length: 8\r\n${extra}\r\nserver=1`;
const response = (rows: unknown[] = [], next = '') =>
  Response.json({ code: 0, data: { list: rows, next } });
const row = { item: 1001, time: 1767268800, pool_id: 1, item_num: 1 };

test('direct fetch restricts destination and forwarded fields and preserves duplicate occurrences', async () => {
  const requests: URL[] = [];
  const result = await collectCapture(capture(), 'profile', {
    fetcher: (async (url, init) => {
      const target = new URL(String(url));
      requests.push(target);
      assert.equal(target.origin, `https://${host}`);
      assert.equal(target.searchParams.has('untrusted'), false);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.referrerPolicy, 'no-referrer');
      assert.deepEqual(Object.keys(init?.headers ?? {}).sort(), ['Authorization', 'Content-Type']);
      return response(target.searchParams.get('type_id') === '1' ? [row, row] : []);
    }) as typeof fetch
  });
  assert.equal((result.records_document.records as unknown[]).length, 2);
  assert.equal(result.manifest?.complete, true);
  assert.equal(result.records_document.schema_version, 2);
  assert.match(String(result.records_document.account_fingerprint), /^sha256:[a-f0-9]{64}$/);
  assert.equal(requests.length, 11);
  assert.ok(!JSON.stringify(result).includes('synthetic-opaque-credential'));
  assert.ok(!JSON.stringify(result).includes(account));
  assert.doesNotThrow(() =>
    validateDocument(result.records_document, result.manifest, result.raw_pages)
  );
});

test('pagination retains source pages and raw evidence', async () => {
  const result = await collectCapture(capture(), 'profile', {
    fetcher: (async (url) => {
      const target = new URL(String(url));
      if (target.searchParams.get('type_id') !== '1') return response();
      return target.searchParams.has('next') ? response([row]) : response([row], 'cursor-two');
    }) as typeof fetch
  });
  const records = result.records_document.records as { source_page: number }[];
  assert.deepEqual(
    records.map((record) => record.source_page),
    [1, 2]
  );
  assert.ok(result.raw_pages?.['raw/type_0001/page_0002.json']);
});

test('invalid and spoofed captures cause no requests', async () => {
  const values = [
    capture().replace('https://', 'http://'),
    capture().replace(`${host}/list`, 'evil.example/list'),
    capture().replace('/list?', '/other?'),
    capture().replace(`Host: ${host}`, 'Host: evil.example'),
    capture('Authorization: second\r\n'),
    capture().replace('Content-Length: 8', 'Content-Length: 7')
  ];
  for (const value of values) {
    await assert.rejects(
      collectCapture(value, 'profile', {
        fetcher: (async () => assert.fail('must not fetch')) as typeof fetch
      }),
      (error: unknown) => error instanceof CaptureError && error.code === 'input'
    );
  }
});

test('expired token metadata fails locally, explicit server supports missing form body', async () => {
  const token = `${Buffer.from(JSON.stringify({ expires: 1, tinx: 1 })).toString('base64url')}.signature`;
  await assert.rejects(collectCapture(capture('', token), 'profile'), /expired/);
  const request = capture().replace('Content-Length: 8\r\n', '').replace('server=1', '');
  const result = await collectCapture(request, 'profile', {
    server: '2',
    fetcher: (async (_url, init) => {
      assert.equal(init?.body, 'server=2');
      return response();
    }) as typeof fetch
  });
  assert.equal(result.records_document.server, '2');
});

test('network failure offers explicit fallback and never retries or includes a URL', async () => {
  let calls = 0;
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      fetcher: (async () => {
        calls++;
        throw new Error(`private https://${host}/list?u=${account}`);
      }) as typeof fetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CaptureError);
      assert.equal(error.canUseServerFallback, true);
      assert.ok(!error.message.includes(account));
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('repeated cursor produces an explicit partial import and never marks it complete', async () => {
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      fetcher: (async () => response([row], 'same')) as typeof fetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CaptureError);
      assert.match(error.message, /repeated/);
      assert.equal(error.partial?.manifest?.complete, false);
      assert.equal((error.partial?.records_document.records as unknown[]).length, 2);
      return true;
    }
  );
});

test('sensitive reflected responses are rejected before saving', async () => {
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      fetcher: (async () => response([{ account }])) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof CaptureError &&
      error.partial === undefined &&
      /sensitive/.test(error.message)
  );
});

test('oversized response and pre-cancelled collection fail safely', async () => {
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      fetcher: (async () =>
        new Response('{}', { headers: { 'content-length': '3000000' } })) as typeof fetch
    }),
    (error: unknown) => error instanceof CaptureError && error.code === 'limit'
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      signal: controller.signal,
      fetcher: (async () => assert.fail('must not fetch')) as typeof fetch
    }),
    (error: unknown) => error instanceof CaptureError && error.code === 'cancelled'
  );
});

test('a disappearing control cannot silently turn failed source types into a completed import', async () => {
  let calls = 0;
  await assert.rejects(
    collectCapture(capture(), 'profile', {
      fetcher: (async () =>
        ++calls === 1
          ? response([row])
          : Response.json({ code: 401, message: 'expired' })) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof CaptureError &&
      !!error.partial &&
      !JSON.stringify(error.partial).includes(account)
  );
  assert.equal(calls, 3);
});

test('public client initializes CSRF and sends a single explicit mutation', async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createPublicClient((async (path, init) => {
    calls.push({ path: String(path), init });
    if (String(path).endsWith('config')) return Response.json({ csrf_token: 'csrf-test' });
    return Response.json({ id: 'job', status: 'queued' });
  }) as typeof fetch);
  await assert.rejects(
    client.fetchCapture({ capture: 'secret', save_backup: false, contribute: false }),
    /Initialize/
  );
  assert.equal(calls.length, 0);
  await client.config();
  await client.fetchCapture({ capture: 'secret', save_backup: false, contribute: false });
  assert.equal(calls.length, 2);
  assert.equal((calls[1].init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf-test');
  assert.equal(calls[1].init?.credentials, 'same-origin');
});

test('public mutation disconnect is uncertain and never automatically retried', async () => {
  let calls = 0;
  const client = createPublicClient((async (path) => {
    if (String(path).endsWith('config')) return Response.json({ csrf_token: 'csrf-test' });
    calls++;
    throw new Error('secret diagnostic');
  }) as typeof fetch);
  await client.config();
  await assert.rejects(
    client.deleteBackup('account'),
    (error: unknown) =>
      error instanceof PublicApiError &&
      error.uncertain &&
      !error.message.includes('secret diagnostic')
  );
  assert.equal(calls, 1);
});

test('local capture validation does not fetch or retain a parsed credential', () => {
  assert.equal(validateCapture(capture()), undefined);
  assert.throws(() => validateCapture(capture(), 'bad'), /server/);
  assert.throws(() => validateCapture('invalid'), /raw POST/);
});

test('stopping after a validated page preserves only partial history without offering relay fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectCapture(capture(), 'original-profile', {
      signal: controller.signal,
      fetcher: (async (_url, init) => {
        calls++;
        if (calls === 1) return response([row], 'next-page');
        controller.abort();
        throw new DOMException('Stopped', 'AbortError');
      }) as typeof fetch
    }),
    (cause: unknown) => {
      assert.ok(cause instanceof CaptureError);
      assert.equal(cause.code, 'cancelled');
      assert.equal(cause.canUseServerFallback, false);
      assert.equal(cause.partial?.profile_id, 'original-profile');
      assert.equal(cause.partial?.manifest?.complete, false);
      assert.equal((cause.partial?.records_document.records as unknown[]).length, 1);
      assert.ok(!JSON.stringify(cause.partial).includes(account));
      return true;
    }
  );
  assert.equal(calls, 2);
});
