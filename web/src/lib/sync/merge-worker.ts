import { reconcile, type Resolutions } from './reconcile.ts';
import type { PortableState } from '../local/types.ts';

/** Cloud-history reconciliation runs off the UI thread, just like archive compression. */
export function createMergeWorker() {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (result: ReturnType<typeof reconcile>) => void; reject: (error: Error) => void }
  >();
  return {
    reconcile(
      local: PortableState,
      remote: PortableState,
      base: PortableState,
      resolutions: Resolutions
    ): Promise<ReturnType<typeof reconcile>> {
      if (typeof Worker === 'undefined')
        return Promise.resolve(reconcile(local, remote, base, resolutions));
      if (!worker) {
        worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({
          data
        }: MessageEvent<{ id: number; result: ReturnType<typeof reconcile>; error?: string }>) => {
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
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, local, remote, base, resolutions });
      });
    },
    close() {
      worker?.terminate();
      worker = undefined;
      for (const request of pending.values()) request.reject(new Error('Cloud sync stopped.'));
      pending.clear();
    }
  };
}
