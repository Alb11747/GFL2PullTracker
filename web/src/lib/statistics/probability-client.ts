import type {
  ProbabilityRequest,
  ProbabilityResult,
  ProbabilityWorkerResponse
} from './probability-types.ts';

export interface ProbabilityClient {
  run(request: ProbabilityRequest): Promise<ProbabilityResult>;
  dispose(): void;
}

/** One client per panel. Superseding work terminates its synchronous calculation. */
export function createProbabilityClient(
  createWorker: () => Worker = () =>
    new Worker(new URL('./probability.worker.ts', import.meta.url), { type: 'module' })
): ProbabilityClient {
  let worker: Worker | undefined;
  let sequence = 0;
  let disposed = false;
  let pending:
    | {
        id: number;
        resolve: (result: ProbabilityResult) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  function stop(error: Error): void {
    worker?.terminate();
    worker = undefined;
    const request = pending;
    pending = undefined;
    request?.reject(error);
  }

  return {
    run(request) {
      if (disposed) return Promise.reject(new DOMException('Calculation stopped.', 'AbortError'));
      if (pending) stop(new DOMException('Calculation superseded.', 'AbortError'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject };
        try {
          if (!worker) {
            worker = createWorker();
            const activeWorker = worker;
            worker.onmessage = ({ data }: MessageEvent<ProbabilityWorkerResponse>) => {
              if (worker !== activeWorker || !pending || pending.id !== data.id) return;
              const completed = pending;
              pending = undefined;
              if (data.error) {
                completed.reject(
                  Object.assign(new Error(data.error.message), { code: data.error.code })
                );
              } else {
                completed.resolve(data.result);
              }
            };
            worker.onerror = (event) => {
              event.preventDefault();
              if (worker !== activeWorker) return;
              stop(new Error('The probability calculation stopped. Please try again.'));
            };
            worker.onmessageerror = () => {
              if (worker !== activeWorker) return;
              stop(new Error('The probability calculation could not be read. Please try again.'));
            };
          }
          worker.postMessage({ ...request, id });
        } catch {
          stop(new Error('The probability worker could not start. Please try again.'));
        }
      });
    },
    dispose() {
      disposed = true;
      stop(new DOMException('Calculation stopped.', 'AbortError'));
    }
  };
}
