import { reconcile, canonical, type Resolutions } from './reconcile.ts';
import { inspectGraph } from './graph.ts';
import { digest, type Revision } from './drive.ts';
import type { PortableState } from '../local/types.ts';

export async function fingerprint(value: unknown): Promise<string> {
  return digest(new TextEncoder().encode(canonical(value)));
}

/** Archive comparison, graph analysis, and merging stay off the UI thread. */
export function createMergeWorker() {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  function call<T>(method: string, args: unknown[], fallback: () => T | Promise<T>): Promise<T> {
    if (typeof Worker === 'undefined') return Promise.resolve(fallback());
    if (!worker) {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({
        data
      }: MessageEvent<{ id: number; result: unknown; error?: string }>) => {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.result);
      };
      worker.onerror = () => {
        for (const request of pending.values())
          request.reject(
            new Error('The cloud merge worker stopped. Local data is safe; retry sync.')
          );
        pending.clear();
        worker?.terminate();
        worker = undefined;
      };
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker!.postMessage({ id, method, args });
    });
  }
  return {
    reconcile(
      local: PortableState,
      remote: PortableState,
      base: PortableState,
      resolutions: Resolutions
    ) {
      return call('reconcile', [local, remote, base, resolutions], () =>
        reconcile(local, remote, base, resolutions)
      );
    },
    inspect(revisions: Revision[]) {
      return call('inspect', [revisions], () => inspectGraph(revisions));
    },
    fingerprint(value: unknown) {
      return call('fingerprint', [value], () => fingerprint(value));
    },
    close() {
      worker?.terminate();
      worker = undefined;
      for (const request of pending.values()) request.reject(new Error('Cloud sync stopped.'));
      pending.clear();
    }
  };
}
