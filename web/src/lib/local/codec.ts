export type CodecMethod = 'encodeBackup' | 'decodeBackup' | 'validateState';

/** CPU-heavy, pure archive work must not hold up browsing or the mutation queue. */
export function createBackupCodec() {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();

  function stop(message: string) {
    const error = new Error(message);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  }

  function activeWorker() {
    if (!worker) {
      worker = new Worker(new URL('./codec-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({
        data
      }: MessageEvent<{
        id: number;
        result?: unknown;
        error?: string;
        errorName?: string;
      }>) => {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) {
          const error = new Error(data.error);
          error.name = data.errorName ?? 'Error';
          request.reject(error);
        } else request.resolve(data.result);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        stop('The backup processing worker stopped. Local data is safe; retry the operation.');
      };
      worker.onmessageerror = () =>
        stop('The backup processing worker returned an unreadable result. Retry the operation.');
    }
    return worker;
  }

  return {
    call<T>(method: CodecMethod, input: unknown): Promise<T> {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        try {
          const target = activeWorker();
          pending.set(id, { resolve: (value) => resolve(value as T), reject });
          target.postMessage({ id, method, input });
        } catch (cause) {
          pending.delete(id);
          reject(cause);
        }
      });
    },
    close() {
      stop('Backup processing stopped.');
    }
  };
}
