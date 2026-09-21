import type { Filters, History, ImportInput, Profile } from '../../src/lib/api.ts';

const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const output = document.querySelector<HTMLElement>('#results')!;
const log = (value: unknown) => { output.textContent += `${typeof value === 'string' ? value : JSON.stringify(value)}\n`; };
const longTasks: { start: number; duration: number }[] = [];
let running = false;
const runtimeErrors: string[] = [];
window.addEventListener('error', (event) => { if (running) runtimeErrors.push(event.message); });
window.addEventListener('unhandledrejection', (event) => { if (running) runtimeErrors.push(String(event.reason)); });
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: 'longtask', buffered: true });
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function client() {
  const worker = new Worker(new URL('../../src/lib/local/worker.ts', import.meta.url), { type: 'module' });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const payloads: number[] = [];
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else {
      // This approximates result size, rather than claiming exact structured-clone bytes.
      payloads.push(JSON.stringify(data.result)?.length ?? 0);
      request.resolve(data.result);
    }
  };
  worker.onerror = () => { for (const request of pending.values()) request.reject(new Error('Archive worker failed')); pending.clear(); };
  return {
    payloads,
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        worker.postMessage({ id, method, args });
      });
    },
    close() { worker.terminate(); }
  };
}
function filters(profile_id: string, values: Partial<Filters> = {}): Filters {
  return { profile_id, q: '', rarity: '', kind: '', type_id: '', pool_id: '', date_from: '', date_to: '', page: 1, page_size: 50, ...values };
}
function recordsDocument(count: number, profile: number, from = 0): ImportInput['records_document'] {
  return {
    schema_version: 1, exported_at: '2026-09-20T12:00:00Z',
    account_fingerprint: `sha256:${String(profile + 1).repeat(64)}`,
    endpoint_host: 'gf2-gacha-record-us.sunborngame.com',
    records: Array.from({ length: count }, (_, offset) => {
      const index = offset + from;
      return { source_type_id: index % 2 ? 3 : 6, source_page: Math.floor(offset / 20) + 1,
        record: { item: index % 10 === 0 ? 1013 : index % 2 ? 11007 : 11008,
          pool_id: index % 2 ? 224001 : 224002, item_num: 1, time: 1784800558 + index } };
    })
  };
}
async function reset() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('gfl2-pull-tracker-stable');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other tabs on the isolated fixture origin.'));
  });
}
async function measure<T>(action: () => Promise<T>) {
  const start = performance.now();
  const value = await action();
  return { value, ms: Math.round((performance.now() - start) * 100) / 100 };
}
type Diagnostics = { archiveReads: number; engineBuilds: number; rowBuilds?: number };

runButton.onclick = async () => {
  runButton.disabled = true; running = true; runtimeErrors.length = 0;
  output.textContent = ''; summary.textContent = 'Running';
  let active: ReturnType<typeof client> | undefined;
  const reports: unknown[] = [];
  try {
    assert(location.origin === 'http://127.0.0.1:14194', 'Use only isolated http://127.0.0.1:14194');
    log({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
      benchmark: 'production worker round trips; no DOM rendering; payload JSON character estimates' });
    for (const size of [1000, 10000, 30000]) {
      await reset(); active = client();
      const profiles: Profile[] = [];
      const importStart = performance.now();
      for (let index = 0; index < 3; index++) {
        const profile = await active.call<Profile>('createProfile', `Synthetic ${size} account ${index + 1}`);
        profiles.push(profile);
        const count = index === 0 ? size : Math.max(100, Math.floor(size / 10));
        await active.call('importRecords', { profile_id: profile.id, records_document: recordsDocument(count, index) });
        // The second snapshot overlaps half the first without adding occurrences.
        await active.call('importRecords', { profile_id: profile.id,
          records_document: recordsDocument(Math.floor(count / 2), index, Math.floor(count / 2)) });
      }
      const importsMs = Math.round(performance.now() - importStart);
      active.close(); active = client();
      const browsingStart = performance.now();
      const cold = await measure(() => active!.call<History>('history', filters(profiles[0].id)));
      assert(cold.value.total === size, `Overlapping imports changed occurrence count: ${cold.value.total} vs ${size}`);
      await active.call('statistics', filters(profiles[0].id));
      await active.call('filterOptions', profiles[0].id);
      for (const profile of profiles.slice(1)) await active.call('history', filters(profile.id));
      const before = await active.call<Diagnostics>('diagnostics');
      const timings: { action: string; ms: number }[] = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        for (const [action, query] of [
          ['pagination', filters(profiles[0].id, { page: repeat + 2 })],
          ['search', filters(profiles[0].id, { q: '1013' })],
          ['recruitment', filters(profiles[0].id, { type_id: repeat % 2 ? '3' : '6' })],
          ['profile switch', filters(profiles[(repeat % 2) + 1].id)]
        ] as const) {
          const result = await measure(() => active!.call<History>('history', query));
          assert(result.value.items.length <= 50, 'Worker returned an unbounded ledger page');
          timings.push({ action, ms: result.ms });
        }
      }
      const after = await active.call<Diagnostics>('diagnostics');
      assert(after.archiveReads === before.archiveReads && after.engineBuilds === before.engineBuilds,
        'Warm browsing reloaded the archive or rebuilt the engine');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(runtimeErrors.length === 0, runtimeErrors.join('\n'));
      const browsingEnd = performance.now();
      const maximumBrowsingResultJsonCharacters = Math.max(...active.payloads);
      // Reproduce the prior engine-per-query behavior on the current engine.
      // This is a controlled architectural comparison, not a measurement of an old deployment.
      const { LocalEngine } = await import('../../src/lib/local/engine.ts');
      const archive = await active.call<import('../../src/lib/local/types.ts').PortableState>('exportState');
      const baselineStart = performance.now();
      new LocalEngine(archive).history(filters(profiles[0].id));
      new LocalEngine(archive).statistics(filters(profiles[0].id));
      new LocalEngine(archive).filterOptions(profiles[0].id);
      new LocalEngine(archive).overview(profiles[0].id);
      const simulatedPreviousQueryPatternMs = Math.round((performance.now() - baselineStart) * 100) / 100;
      const report = { records: size, profiles: profiles.length, importsMs, coldHistoryMs: cold.ms,
        timings, warmTargetMet: timings.every(({ ms }) => ms < 200), diagnostics: { before, after },
        simulatedPreviousQueryPatternMs,
        maximumBrowsingResultJsonCharacters,
        longTasks: longTasks.filter((task) => task.start >= browsingStart && task.start < browsingEnd) };
      reports.push(report); log(report);
      active.close(); active = undefined;
    }
    (window as unknown as { performanceResults: unknown[] }).performanceResults = reports;
    summary.textContent = 'PASS archive reuse and bounded results; inspect timings for the 200 ms target';
  } catch (error) {
    summary.textContent = 'FAIL performance fixture'; log(error instanceof Error ? error.stack : String(error));
  } finally { active?.close(); running = false; runButton.disabled = false; }
};
if (new URLSearchParams(location.search).get('autorun') === '1') runButton.click();
