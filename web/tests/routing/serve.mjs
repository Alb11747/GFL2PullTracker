import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const web = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:14195';
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function application(mode) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: web,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin,
      ADDRESS_HEADER: 'x-real-ip',
      GFL2_MODE: mode, PUBLIC_ORIGIN: 'https://routing.invalid',
      PUBLIC_GOOGLE_CLIENT_ID: 'synthetic-routing-client',
      PUBLIC_POSTHOG_KEY: 'phc_synthetic_routing_fixture', PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
      PUBLIC_FEEDBACK_SURVEY_ID: '11111111-1111-4111-8111-111111111111',
      PUBLIC_FEEDBACK_CATEGORY_ID: '22222222-2222-4222-8222-222222222222',
      PUBLIC_FEEDBACK_MESSAGE_ID: '33333333-3333-4333-8333-333333333333',
      PUBLIC_FEEDBACK_EMAIL_ID: '44444444-4444-4444-8444-444444444444',
      GFL2_API_URL: 'http://127.0.0.1:1', GFL2_API_ALLOWED_ORIGINS: 'http://127.0.0.1:1',
      PUBLIC_SUPPORT_EMAIL: 'routing@example.invalid',
      PUBLIC_HOSTING_DETAILS: 'Synthetic routing fixture', PUBLIC_LOG_RETENTION: 'No fixture logs retained'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempts = 0; attempts < 100; attempts++) {
    if (child.exitCode !== null) throw new Error(`Application exited: ${output}`);
    try {
      const response = await fetch(`${base}/history`, { headers: { 'x-real-ip': '127.0.0.1' } });
      if (response.status === 200) return { base, child };
    } catch {}
    await sleep(100);
  }
  throw new Error(`Application did not start: ${output}`);
}

async function smoke() {
  for (const mode of ['public', 'local']) {
    const { base, child } = await application(mode);
    try {
      for (const path of ['/history', '/privacy-policy', '/guides/exilium']) {
        assert.equal((await fetch(base + path, { headers: { 'x-real-ip': '127.0.0.1' } })).status, 200, `${mode} ${path}`);
      }
      for (const path of ['/not-a-section', '/History', '/backup/unknown']) {
        assert.equal((await fetch(base + path, { headers: { 'x-real-ip': '127.0.0.1' } })).status, 404, `${mode} ${path}`);
      }
      for (const path of ['/', '/backup', '/profiles', '/statistics', '/privacy', '/about']) {
        const response = await fetch(base + path, { redirect: 'manual', headers: { 'x-real-ip': '127.0.0.1' } });
        if (mode === 'public' && path !== '/') {
          assert.equal(response.status, 200, path);
          const html = await response.text();
          const anchor = html.match(new RegExp(`<a\\b[^>]*href="${path}"[^>]*>`))?.[0] ?? '';
          assert.match(anchor, /aria-current="page"/, `${path} current on first render`);
          assert.match(anchor, /class="[^"]*\bchosen\b[^"]*"/, `${path} chosen on first render`);
          if (path === '/about') assert.ok(html.includes('About'), 'About renders without waiting for the archive');
          assert.ok(!html.includes('id="history-title"'), `${path} does not flash history while initializing`);
        }
        else {
          assert.equal(response.status, path === '/' ? 308 : 307, `${mode} ${path} redirect status`);
          assert.equal(response.headers.get('location'), path === '/privacy' ? '/privacy-policy' : '/history');
        }
      }
      const policy = await (await fetch(base + '/privacy-policy', { headers: { 'x-real-ip': '127.0.0.1' } })).text();
      assert.ok(policy.includes('routing@example.invalid'));
      assert.ok(policy.includes('Synthetic routing fixture'));
      console.log(`PASS ${mode}: routes, redirects, unknown slugs, runtime policy disclosures`);
    } finally { child.kill(); children.delete(child); }
  }
}

process.on('exit', () => { for (const child of children) child.kill(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

if (process.argv.includes('--smoke')) {
  await smoke();
} else {
  const { base } = await application('public');
  const proxy = createServer(async (request, response) => {
    try {
      if (request.headers.host !== '127.0.0.1:14195') {
        response.writeHead(403).end('This fixture requires its isolated loopback origin.');
        return;
      }
      if (request.url === '/__routing/suite.js') {
        const source = (await Promise.all(['import-regressions.ts', 'suite.ts'].map((file) =>
          readFile(new URL(`./${file}`, import.meta.url), 'utf8')))).join('\n');
        const script = ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
        }).outputText;
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(script);
        return;
      }
      if (request.url === '/__routing/reset') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><title>Reset isolated routing fixture</title><script src="/__routing/suite.js"></script><p>Resetting synthetic test archive…</p>');
        return;
      }
      const headers = new Headers(request.headers);
      headers.delete('connection');
      headers.set('accept-encoding', 'identity');
      headers.set('x-real-ip', '127.0.0.1');
      const upstream = await fetch(base + request.url, { headers, redirect: 'manual' });
      const outputHeaders = Object.fromEntries(upstream.headers);
      delete outputHeaders['content-length'];
      delete outputHeaders['content-encoding'];
      let body = Buffer.from(await upstream.arrayBuffer());
      if (upstream.headers.get('content-type')?.includes('text/html')) {
        body = Buffer.from(body.toString().replace('<head>', '<head><script src="/__routing/suite.js"></script>'));
      }
      response.writeHead(upstream.status, outputHeaders).end(body);
    } catch (error) {
      console.error(error);
      response.writeHead(500).end('Routing fixture failed; inspect terminal output.');
    }
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(14195, '127.0.0.1', resolve); });
  console.log(`Routing fixture ready: ${origin}/history — click Run tests. Synthetic data only.`);
}
